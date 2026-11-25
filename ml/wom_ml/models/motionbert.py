"""방식 B: 사전학습 MotionBERT-Lite(DSTformer) 몸통 + 운동별 선형 머리.

입력 (B,T,17,3) [x,y,conf] (H36M 17점, crop_scale 정규화, conf 0~1) -> DSTformer 표현 (B,T,17,512)
-> 시간·관절 평균 풀링 (B,512) -> 운동별 선형 머리 (B, 오류 칸 수) 로짓.
T=64는 DSTformer maxlen(243) 이하라 그대로 들어간다(temp_embed 앞 64칸을 쓴다).

고정 모드
- probe  : 몸통 전부 고정, 머리만 학습.
- partial: 머리 + 몸통 마지막 `partial_blocks`개 블록. 한 '블록' i = blocks_st[i] + blocks_ts[i] + ts_attn[i]
           (DSTformer는 깊이마다 두 갈래 블록과 그 융합 가중치를 한 단계로 쓴다). 블록 뒤의 norm·pre_logits
           (표현 투영)도 함께 푼다 — 마지막 블록 출력이 반드시 지나가는 몸통의 끝부분이기 때문.
- full   : 전부 학습. 몸통 학습률은 머리의 1/10 → `param_groups(lr)`를 train의 cfg["param_groups"]로 넘긴다.
           예: cfg["param_groups"] = lambda m: m.param_groups(cfg["lr"])

가중치: 업스트림 체크포인트는 {'model_pos': {'module.'+키: 값}, ...} 형식(train.py/infer_wild.py 로더와 같음).
외부에서 받은 파일이므로 torch.load(weights_only=True)로만 읽는다. 원래 3D 출력 머리(head.*)는 쓰지 않으므로
로드 뒤 버린다(load_report["unexpected"]에 그 두 키만 남는 것이 정상).

third_party/MotionBERT는 수정하지 않는다. DSTformer.py가 `from lib.model.drop import DropPath`를 쓰므로
sys.path에 MotionBERT 루트를 더하지 않고, 두 파일을 경로로 직접 읽되 실행하는 동안만
sys.modules["lib.model.drop"]을 잠깐 걸어 둔다(전역 'lib' 이름을 남기지 않는다).
"""
from __future__ import annotations

import importlib.util
import sys
from functools import partial
from pathlib import Path
from typing import Literal

import numpy as np
import torch
from torch import nn

from wom_ml import paths

MB_ROOT = paths.THIRD_PARTY / "MotionBERT"
DEFAULT_WEIGHTS = paths.WEIGHTS / "motionbert_lite.bin"

# configs/pretrain/MB_lite.yaml 의 모델 값(커밋 705d3a9)
LITE_CFG = {"dim_feat": 256, "dim_rep": 512, "depth": 5, "num_heads": 8,
            "mlp_ratio": 4, "maxlen": 243, "num_joints": 17}

FreezeMode = Literal["probe", "partial", "full"]
BACKBONE_LR_RATIO = 0.1  # full 모드 몸통 학습률 = 머리 × 0.1

_DST_MODULE = None


def _load_file_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _dstformer_module():
    """third_party의 DSTformer.py를 sys.path 변경 없이 불러온다(한 번만)."""
    global _DST_MODULE
    if _DST_MODULE is None:
        model_dir = MB_ROOT / "lib" / "model"
        if not (model_dir / "DSTformer.py").exists():
            raise FileNotFoundError(
                f"MotionBERT 코드가 없음: {model_dir}. ml/README.md의 'MotionBERT 코드' 절을 보고 "
                f"python ml/scripts/fetch_data.py 로 받으세요.")
        drop = _load_file_module("wom_ml._mb_drop", model_dir / "drop.py")
        key = "lib.model.drop"
        prev = sys.modules.get(key)
        sys.modules[key] = drop  # DSTformer.py의 `from lib.model.drop import DropPath`가 이것을 찾는다
        try:
            _DST_MODULE = _load_file_module("wom_ml._mb_dstformer", model_dir / "DSTformer.py")
        finally:
            if prev is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = prev
    return _DST_MODULE


def build_backbone() -> nn.Module:
    """업스트림 load_backbone과 같은 설정의 DSTformer(Lite). 3D 출력 머리(head, dim_out=3) 포함."""
    DSTformer = _dstformer_module().DSTformer
    c = LITE_CFG
    return DSTformer(dim_in=3, dim_out=3, dim_feat=c["dim_feat"], dim_rep=c["dim_rep"], depth=c["depth"],
                     num_heads=c["num_heads"], mlp_ratio=c["mlp_ratio"],
                     norm_layer=partial(nn.LayerNorm, eps=1e-6), maxlen=c["maxlen"], num_joints=c["num_joints"])


def _missing_weights_message(path: Path) -> str:
    return (f"MotionBERT-Lite 가중치 파일이 없음: {path}\n"
            f"받는 법은 ml/README.md의 'MotionBERT-Lite 사전학습 가중치' 절을 보세요 "
            f"(OneDrive https://1drv.ms/f/s!AvAdh0LSjEOlgS27Ydcbpxlkl0ng?e=rq2Btn 의 Lite 체크포인트 "
            f"MB_lite/latest_epoch.bin 을 받아 {DEFAULT_WEIGHTS} 즉 ml/weights/motionbert_lite.bin 으로 두기).")


def _numpy_safe_globals() -> list:
    """weights_only 로드에 더할 최소 numpy 전역.

    업스트림 save_checkpoint(train.py)는 min_loss(np.mean 결과 = numpy.float64 스칼라)도 저장한다.
    이 스칼라를 풀려면 `numpy._core.multiarray.scalar`(numpy 2.x 이름)와 `numpy.dtype`, 그리고 dtype 상태를
    BUILD할 dtype 클래스가 필요하다(get_unsafe_globals_in_checkpoint와 실제 로드 오류로 확인, numpy 2.4).
    min_loss는 평가 오차(np.mean)라 float32(torch 출력 기반)일 수도 float64일 수도 있어 두 dtype 클래스만 허용.
    공개 가중치는 numpy 1.x 시절에 저장됐으므로 옛 이름 `numpy.core.multiarray.scalar`도 같은 함수로 연결한다.
    그 밖의 전역은 허용하지 않는다.
    """
    scalar = np._core.multiarray.scalar
    return [scalar, (scalar, "numpy.core.multiarray.scalar"), np.dtype,
            np.dtypes.Float32DType, np.dtypes.Float64DType]


def load_backbone_weights(backbone: nn.Module, path: Path) -> dict:
    """체크포인트를 backbone에 넣는다. 반환 {"missing": [...], "unexpected": [...]}.

    missing이 하나라도 있으면 RuntimeError(몸통이 덜 채워진 채로 실험하지 않게).
    """
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(_missing_weights_message(path))
    # 신뢰할 수 없는 외부 파일: weights_only=True 유지, numpy 스칼라에 필요한 최소 전역만 로드하는 동안 허용
    with torch.serialization.safe_globals(_numpy_safe_globals()):
        ck = torch.load(path, map_location="cpu", weights_only=True)
    sd = ck
    if isinstance(ck, dict):
        for k in ("model_pos", "model", "state_dict"):
            if k in ck and isinstance(ck[k], dict):
                sd = ck[k]
                break
    sd = {(k[len("module."):] if k.startswith("module.") else k): v for k, v in sd.items()}
    res = backbone.load_state_dict(sd, strict=False)
    report = {"missing": list(res.missing_keys), "unexpected": list(res.unexpected_keys)}
    if report["missing"]:
        raise RuntimeError(f"가중치에 없는 몸통 키 {len(report['missing'])}개: {report['missing'][:10]}")
    return report


class MotionBertClassifier(nn.Module):
    def __init__(self, heads: dict[str, int], weights: Path | None, freeze: FreezeMode,
                 partial_blocks: int = 2):
        """weights=None은 테스트·메모리 측정 전용 무작위 초기화. 실험은 반드시 가중치 경로를 준다."""
        super().__init__()
        if freeze not in ("probe", "partial", "full"):
            raise ValueError(f"freeze는 probe/partial/full 중 하나: {freeze}")
        if not 0 <= partial_blocks <= LITE_CFG["depth"]:
            raise ValueError(f"partial_blocks는 0~{LITE_CFG['depth']}: {partial_blocks}")
        if weights is not None and not Path(weights).is_file():
            raise FileNotFoundError(_missing_weights_message(Path(weights)))
        self.freeze = freeze
        self.partial_blocks = partial_blocks
        self.backbone = build_backbone()
        # 쓰지 않는 원래 3D 출력 머리는 버린다(forward는 표현만 쓴다). 로드 전에 버려서
        # 체크포인트의 head.* 두 키가 unexpected로 드러나게 한다.
        self.backbone.head = nn.Identity()
        self.load_report = None
        if weights is not None:
            self.load_report = load_backbone_weights(self.backbone, Path(weights))
        dim_rep = LITE_CFG["dim_rep"]
        self.heads = nn.ModuleDict({ex: nn.Linear(dim_rep, n) for ex, n in heads.items()})
        self._apply_freeze()

    # ------------------------------------------------------------ 고정
    def _backbone_trainable_modules(self) -> list[nn.Module]:
        bb = self.backbone
        if self.freeze == "full":
            return [bb]
        if self.freeze == "probe" or self.partial_blocks == 0:
            return []
        k = self.partial_blocks
        mods: list[nn.Module] = []
        for seq in (bb.blocks_st, bb.blocks_ts, bb.ts_attn):
            mods += list(seq)[-k:]
        return mods + [bb.norm, bb.pre_logits]

    def _apply_freeze(self) -> None:
        for p in self.backbone.parameters():
            p.requires_grad = False
        for m in self._backbone_trainable_modules():
            for p in m.parameters():
                p.requires_grad = True
        for p in self.heads.parameters():
            p.requires_grad = True

    def trainable_parameters(self) -> list[nn.Parameter]:
        return [p for p in self.parameters() if p.requires_grad]

    def backbone_trainable_parameters(self) -> list[nn.Parameter]:
        return [p for p in self.backbone.parameters() if p.requires_grad]

    def param_groups(self, lr: float) -> list[dict]:
        """옵티마이저 파라미터 그룹. 머리는 lr. 몸통은 full이면 lr×0.1(설계 ③ '전체를 작은 학습률로'),
        partial이면 머리와 같은 lr(설계에 따로 정하지 않음). probe는 머리 그룹만."""
        groups = [{"params": list(self.heads.parameters()), "lr": lr}]
        body = self.backbone_trainable_parameters()
        if body:
            ratio = BACKBONE_LR_RATIO if self.freeze == "full" else 1.0
            groups.append({"params": body, "lr": lr * ratio})
        return groups

    def train(self, mode: bool = True):
        """probe면 몸통은 늘 eval(고정 특징이 dropout 등으로 흔들리지 않게). 그 밖은 기본 동작."""
        super().train(mode)
        if self.freeze == "probe":
            self.backbone.eval()
        return self

    # ------------------------------------------------------------ 계산
    def features(self, x: torch.Tensor) -> torch.Tensor:
        """(B,T,17,3) -> (B, dim_rep) 시간·관절 평균."""
        if x.dim() != 4 or x.shape[2:] != (17, 3):
            raise ValueError(f"입력은 (B,T,17,3)이어야 함: {tuple(x.shape)}")
        if x.shape[1] > LITE_CFG["maxlen"]:
            raise ValueError(f"T={x.shape[1]} > maxlen {LITE_CFG['maxlen']}")
        if self.freeze == "probe":
            with torch.no_grad():  # 몸통 고정이면 활성값을 저장하지 않아 메모리를 아낀다
                rep = self.backbone(x, return_rep=True)
        else:
            rep = self.backbone(x, return_rep=True)
        return rep.mean(dim=(1, 2))

    def forward(self, x: torch.Tensor, exercise: str) -> torch.Tensor:
        if exercise not in self.heads:
            raise KeyError(f"머리가 없는 운동: {exercise}")
        return self.heads[exercise](self.features(x))

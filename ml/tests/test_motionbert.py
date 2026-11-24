"""방식 B MotionBERT 분류기 테스트 — 합성 입력만(개인 녹화는 열지 않는다).

weights=None(무작위 초기화)은 테스트 전용. 실제 가중치 키 검사는 파일이 있을 때만 돈다.
"""
from pathlib import Path

import pytest
import torch

from wom_ml import paths
from wom_ml.models.motionbert import LITE_CFG, MotionBertClassifier, build_backbone
from wom_ml.sources import HEAD_LABELS

HEADS = {ex: len(c) for ex, c in HEAD_LABELS.items()}
T = 64
REAL_WEIGHTS = paths.WEIGHTS / "motionbert_lite.bin"


@pytest.fixture(scope="module")
def models():
    torch.manual_seed(0)
    return {mode: MotionBertClassifier(HEADS, weights=None, freeze=mode) for mode in ("probe", "partial", "full")}


def _ids(params):
    return {id(p) for p in params}


def test_lite_config_matches_upstream():
    # MotionBERT configs/pretrain/MB_lite.yaml 값
    assert LITE_CFG == {"dim_feat": 256, "dim_rep": 512, "depth": 5, "num_heads": 8,
                        "mlp_ratio": 4, "maxlen": 243, "num_joints": 17}


def test_output_shape_per_exercise(models):
    x = torch.randn(3, T, 17, 3)
    for m in models.values():
        m.eval()
        for ex, k in HEADS.items():
            assert m(x, ex).shape == (3, k)


def test_unknown_exercise_raises(models):
    with pytest.raises(KeyError):
        models["probe"](torch.randn(2, T, 17, 3), "pushup")


def test_probe_trains_heads_only(models):
    m = models["probe"]
    assert _ids(m.trainable_parameters()) == _ids(m.heads.parameters())
    assert all(not p.requires_grad for p in m.backbone.parameters())


def test_partial_trains_heads_and_last_blocks(models):
    m = models["partial"]
    bb = m.backbone
    k = 2
    expect = list(m.heads.parameters()) + list(bb.norm.parameters()) + list(bb.pre_logits.parameters())
    for mods in (bb.blocks_st, bb.blocks_ts, bb.ts_attn):
        for blk in list(mods)[-k:]:
            expect += list(blk.parameters())
    assert _ids(m.trainable_parameters()) == _ids(expect)
    # 앞쪽 블록과 입력 임베딩은 고정
    for blk in list(bb.blocks_st)[:-k]:
        assert all(not p.requires_grad for p in blk.parameters())
    assert not bb.joints_embed.weight.requires_grad and not bb.temp_embed.requires_grad


def test_partial_blocks_count():
    m = MotionBertClassifier(HEADS, weights=None, freeze="partial", partial_blocks=1)
    trainable_blocks = [i for i, b in enumerate(m.backbone.blocks_st) if next(b.parameters()).requires_grad]
    assert trainable_blocks == [LITE_CFG["depth"] - 1]


def test_full_trains_everything(models):
    m = models["full"]
    assert _ids(m.trainable_parameters()) == _ids(m.parameters())
    # 쓰지 않는 원래 3D 출력 머리는 모델에 남기지 않는다(학습 가능 수에 끼지 않게)
    assert isinstance(m.backbone.head, torch.nn.Identity)


def test_full_param_groups_backbone_lr_is_tenth(models):
    m = models["full"]
    groups = m.param_groups(1e-3)
    assert len(groups) == 2
    head, body = groups
    assert head["lr"] == pytest.approx(1e-3) and body["lr"] == pytest.approx(1e-4)
    assert _ids(head["params"]) == _ids(m.heads.parameters())
    assert _ids(head["params"]) | _ids(body["params"]) == _ids(m.trainable_parameters())


def test_probe_param_groups_heads_only(models):
    groups = models["probe"].param_groups(1e-3)
    assert len(groups) == 1 and groups[0]["lr"] == pytest.approx(1e-3)


def test_gradients_reach_only_trainable(models):
    m = models["partial"]
    m.train()
    m.zero_grad(set_to_none=True)
    m(torch.randn(2, T, 17, 3), "squat").sum().backward()
    assert all(p.grad is not None for p in m.heads["squat"].parameters())
    assert m.backbone.blocks_st[-1].mlp_s.fc1.weight.grad is not None
    assert m.backbone.blocks_st[0].mlp_s.fc1.weight.grad is None


def test_bad_freeze_mode_raises():
    with pytest.raises(ValueError):
        MotionBertClassifier(HEADS, weights=None, freeze="half")


def test_missing_weights_file_raises_with_guide(tmp_path):
    missing = tmp_path / "nope" / "motionbert_lite.bin"
    with pytest.raises(FileNotFoundError) as e:
        MotionBertClassifier(HEADS, weights=missing, freeze="probe")
    msg = str(e.value)
    assert str(missing) in msg and "ml/README.md" in msg and "motionbert_lite.bin" in msg


def test_loader_strips_module_prefix_and_model_pos(tmp_path):
    """합성 체크포인트(업스트림 형식: {'model_pos': {'module.'+키: 값}})로 로더 검사."""
    torch.manual_seed(1)
    src = build_backbone()  # 업스트림 그대로(3D 출력 머리 head.* 포함)
    sd = {"module." + k: v.clone() for k, v in src.state_dict().items()}
    ck = tmp_path / "fake.bin"
    torch.save({"epoch": 1, "model_pos": sd}, ck)

    m = MotionBertClassifier(HEADS, weights=ck, freeze="probe")
    assert m.load_report["missing"] == []
    assert set(m.load_report["unexpected"]) == {"head.weight", "head.bias"}
    for k, v in m.backbone.state_dict().items():
        assert torch.equal(v, sd["module." + k]), k
    assert len(m.backbone.state_dict()) == len(sd) - 2


@pytest.mark.skipif(not REAL_WEIGHTS.exists(),
                    reason="ml/weights/motionbert_lite.bin 없음(사용자 수동 다운로드 대기, ml/README.md 참고)")
def test_real_weights_key_mismatch_zero():
    m = MotionBertClassifier(HEADS, weights=REAL_WEIGHTS, freeze="probe")
    assert m.load_report["missing"] == []
    # 원래 3D 출력 머리(head.*)만 남는다
    assert set(m.load_report["unexpected"]) <= {"head.weight", "head.bias"}



def test_works_with_train_loop_param_groups(tmp_path):
    """train.fit이 cfg["param_groups"]로 머리 lr·몸통 lr×0.1 그룹을 받아 학습한다(합성 데이터).

    GPU가 있으면 GPU로 돈다(이 PC에서 앞 테스트 뒤 CPU로 돌리면 이유 없이 30~80초까지 느려져서).
    """
    import numpy as np

    from wom_ml import train as tr

    rng = np.random.default_rng(0)
    n = 8
    X = rng.uniform(-1, 1, (n, T, 17, 3)).astype(np.float32)
    Y = {ex: np.full((n, k), -1, np.int8) for ex, k in HEADS.items()}
    Y["squat"][:] = rng.integers(0, 2, (n, HEADS["squat"]))
    meta = [{"source": "zenodo", "exercise": "squat", "subject": "p01"}] * n
    torch.manual_seed(0)
    m = MotionBertClassifier(HEADS, weights=None, freeze="full")
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    cfg = {"exercise": "squat", "device": dev, "batch_size": 4, "lr": 1e-3, "weight_decay": 0.0,
           "max_epochs": 1, "patience": 1, "param_groups": lambda mod: mod.param_groups(1e-3)}
    before = m.backbone.joints_embed.weight.detach().clone()
    info = tr.fit(m, (X, Y, meta), (X, Y, [{**d, "subject": "p02"} for d in meta]), cfg, 0, tmp_path)
    assert info["epochs_run"] == 1
    assert not torch.equal(before, m.backbone.joints_embed.weight.detach().cpu())

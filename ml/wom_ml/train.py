"""모델에 독립적인 학습·평가 루프(방식 A 작은 GRU, 방식 B MotionBERT 분류기 공용).

모델 약속: `model(x (B,T,17,3) float, exercise: str) -> (B, len(HEAD_LABELS[exercise]))` 로짓.
데이터 약속: data = {"train", "val", "test_ec3d", "test_own"} 각 값은 dataset.build_arrays의 (X, Y, meta).

평가 오염 방지(가장 중요)
- 학습(`fit`)은 train·val만 인자로 받는다. test 분할은 fit이 끝난 뒤 `evaluate`에서만 읽는다.
- fit은 train·val 메타를 다시 검사해, 본인 녹화(source="own")나 EC3D 피험자 4가 섞여 있으면 ValueError.
- 조기 종료·체크포인트 선택은 val 손실로만. 임계값은 0.5 고정(고르지 않음).

조기 종료(컨트롤러 R9): 한 번의 train_model 호출은 운동 하나(cfg["exercise"])의 머리를 학습한다.
그 운동의 val 샘플이 있으면(스쿼트: Zenodo val) val 손실로 조기 종료하고 가장 좋은 epoch의 가중치를 쓴다.
val 샘플이 없으면(런지·플랭크: EC3D뿐이고 피험자 1~3이 모두 train) cfg["fixed_epochs"][운동]만큼 학습하고
마지막 가중치를 쓴다.

실행(ml 폴더에서): python -m wom_ml.train --exercise squat --seeds 0 1 2
결과: runs/small/seed{N}/metrics.json(집계 지표만), runs/small/seed{N}/model.pt, runs/small/summary.json.
터미널에도 집계만 출력한다(개인 녹화 좌표·샘플별 예측 없음).
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import random
import time
from pathlib import Path

# cuBLAS 결정론(torch.use_deterministic_algorithms)에 필요. CUDA 초기화 전에 정해야 한다.
os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from torch import nn  # noqa: E402

from wom_ml import metrics as mt  # noqa: E402
from wom_ml import paths  # noqa: E402
from wom_ml.sources import HEAD_LABELS  # noqa: E402

THRESHOLD = 0.5
# 규칙 판정이 내는 칸(Task 5 기준선과 같은 칸으로 앱 방식 지표를 따로 낸다)
RULE_COLUMNS = {"squat": ["kneeIn", "shallow"]}

DEFAULT_CFG: dict = {
    "exercise": "squat",
    "device": "cuda" if torch.cuda.is_available() else "cpu",
    "batch_size": 64,
    "lr": 1e-3,
    "weight_decay": 1e-4,
    "max_epochs": 100,
    "patience": 15,
    "min_delta": 1e-4,
    # val이 없는 운동의 고정 epoch 수(R9). 모든 시드 공통 상수, test 분할은 보지 않고 정했다.
    # 근거: 스쿼트(같은 SmallGRU·학습률·pos_weight="auto")의 Zenodo val 조기 종료 최적 epoch가
    # 시드 0·1·2에서 4·9·5였다(task-6-report). 가장 큰 값 근처로 올려 10. 런지·플랭크 train 샘플 수
    # (950·780)가 스쿼트(1362)와 같은 자릿수라 그대로 쓴다. 방식 B는 자기 cfg에서 따로 정한다.
    "fixed_epochs": {"lunge": 10, "plank": 10},
    # None이면 보통 BCE. "auto"면 train 라벨의 칸별 음성/양성 비율(train만으로 계산)을 pos_weight로.
    # 기본 "auto": None과 비교해 세 시드 모두 val 손실(가중치 없는 BCE)이 낮고 val shallow F1도 높았다
    # (val만으로 고름, task-6-report). None이면 오류 칸 양성이 드물어 거의 아무것도 지적하지 않았다.
    "pos_weight": "auto",
    # 선택: callable(model) -> 옵티마이저 파라미터 그룹(방식 B에서 층별 학습률 등). 없으면 requires_grad 전부.
    "param_groups": None,
}


# ---------------------------------------------------------------- 재현성
def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False
    torch.use_deterministic_algorithms(True, warn_only=True)


# ---------------------------------------------------------------- 데이터 고르기
def select(split, exercise: str):
    """(X, Y, meta) -> 그 운동 샘플만 (X, y (n,칸), meta). split이 None이면 빈 것."""
    k = len(HEAD_LABELS[exercise])
    if split is None:
        return np.zeros((0, 64, 17, 3), np.float32), np.zeros((0, k), np.int8), []
    X, Y, meta = split
    y = np.asarray(Y[exercise])
    rows = np.flatnonzero((y >= 0).any(axis=1))
    return np.asarray(X)[rows].astype(np.float32), y[rows], [meta[i] for i in rows]


def assert_not_test(meta: list[dict], name: str) -> None:
    """학습·검증 데이터에 평가 전용 샘플 표식이 있으면 ValueError."""
    for m in meta:
        if (m.get("source") == "own" or (m.get("source") == "ec3d" and str(m.get("subject")) == "4")
                or str(m.get("split", "")).startswith("test")):
            raise ValueError(f"{name}에 평가 전용 샘플이 있음(source={m.get('source')}, subject={m.get('subject')})")


def _masked_bce(logits, y, pos_weight=None):
    mask = (y >= 0).float()
    loss = nn.functional.binary_cross_entropy_with_logits(
        logits, y.clamp(min=0).float(), reduction="none", pos_weight=pos_weight)
    return (loss * mask).sum() / mask.sum().clamp(min=1)


@torch.no_grad()
def predict(model, X: np.ndarray, exercise: str, device, batch_size: int = 256) -> np.ndarray:
    """확률 (n, 칸)."""
    model.eval()
    out = []
    for i in range(0, len(X), batch_size):
        xb = torch.as_tensor(X[i:i + batch_size], device=device)
        out.append(torch.sigmoid(model(xb, exercise)).float().cpu().numpy())
    return np.concatenate(out) if out else np.zeros((0, len(HEAD_LABELS[exercise])), np.float32)


@torch.no_grad()
def _loss_on(model, X, y, exercise, device, batch_size=256) -> float:
    model.eval()
    tot, cnt = 0.0, 0.0
    for i in range(0, len(X), batch_size):
        xb = torch.as_tensor(X[i:i + batch_size], device=device)
        yb = torch.as_tensor(y[i:i + batch_size], device=device)
        m = float((yb >= 0).sum())
        tot += _masked_bce(model(xb, exercise), yb).item() * m
        cnt += m
    return tot / max(cnt, 1.0)


# ---------------------------------------------------------------- 학습
def fit(model, train, val, cfg: dict, seed: int, out_dir: Path) -> dict:
    """train으로 학습, val 손실로 조기 종료(val이 없으면 고정 epoch). test 분할은 받지 않는다.

    끝나면 model에 고른 가중치를 올리고 out_dir/model.pt로 저장. 학습 정보 dict 반환.
    """
    cfg = {**DEFAULT_CFG, **cfg}
    ex, device = cfg["exercise"], torch.device(cfg["device"])
    Xtr, ytr, mtr = select(train, ex)
    Xva, yva, mva = select(val, ex)
    assert_not_test(mtr, "train")
    assert_not_test(mva, "val")
    if len(Xtr) == 0:
        raise ValueError(f"train에 {ex} 샘플이 없음")
    has_val = len(Xva) > 0
    epochs = cfg["max_epochs"] if has_val else int(cfg["fixed_epochs"][ex])

    model.to(device)
    Xtr_t, ytr_t = torch.as_tensor(Xtr, device=device), torch.as_tensor(ytr, device=device)
    pos_weight = None
    if cfg["pos_weight"] == "auto":
        pos = (ytr == 1).sum(0).astype(np.float64)
        neg = (ytr == 0).sum(0).astype(np.float64)
        pos_weight = torch.as_tensor(neg / np.maximum(pos, 1), dtype=torch.float32, device=device)
    groups = cfg["param_groups"](model) if callable(cfg["param_groups"]) else \
        [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(groups, lr=cfg["lr"], weight_decay=cfg["weight_decay"])
    gen = torch.Generator().manual_seed(seed)

    t0 = time.time()
    history, best, best_epoch, best_state, bad = [], float("inf"), 0, None, 0
    stopped_by = "max_epochs" if has_val else "fixed_epochs"
    epoch = 0
    for epoch in range(1, epochs + 1):
        model.train()
        perm = torch.randperm(len(Xtr), generator=gen).to(device)
        tl, nb = 0.0, 0
        for i in range(0, len(perm), cfg["batch_size"]):
            idx = perm[i:i + cfg["batch_size"]]
            opt.zero_grad(set_to_none=True)
            loss = _masked_bce(model(Xtr_t[idx], ex), ytr_t[idx], pos_weight)
            loss.backward()
            opt.step()
            tl, nb = tl + loss.item(), nb + 1
        rec = {"epoch": epoch, "train_loss": tl / nb}
        if has_val:
            vl = _loss_on(model, Xva, yva, ex, device)
            rec["val_loss"] = vl
            if vl < best - cfg["min_delta"]:
                best, best_epoch, bad = vl, epoch, 0
                best_state = copy.deepcopy({k: v.detach().cpu() for k, v in model.state_dict().items()})
            else:
                bad += 1
        history.append(rec)
        if has_val and bad >= cfg["patience"]:
            stopped_by = "early_stop"
            break
    if has_val:
        model.load_state_dict(best_state)
    else:
        best_epoch = epoch
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), out_dir / "model.pt")
    return {"epochs_run": epoch, "best_epoch": best_epoch, "stopped_by": stopped_by,
            "val_loss": best if has_val else None, "n_train": int(len(Xtr)), "n_val": int(len(Xva)),
            "seconds": round(time.time() - t0, 1), "history": history}


# ---------------------------------------------------------------- 평가(학습이 끝난 뒤에만)
def _scores(y, pred, names, ex) -> dict:
    out = {"n": int(len(y)), "per_error": mt.per_error(y, pred, names), "app_style": mt.app_style(y, pred, names)}
    if ex in RULE_COLUMNS:
        cols = [names.index(c) for c in RULE_COLUMNS[ex]]
        out["app_style_rule_columns"] = mt.app_style(y[:, cols], pred[:, cols], RULE_COLUMNS[ex])
    return out


def evaluate(model, split, cfg: dict) -> dict | None:
    """한 분할의 집계 지표. 그 운동 샘플이 없으면 None. EC3D처럼 yaw가 있으면 yaw별도 함께."""
    cfg = {**DEFAULT_CFG, **cfg}
    ex, names = cfg["exercise"], HEAD_LABELS[cfg["exercise"]]
    X, y, meta = select(split, ex)
    if len(X) == 0:
        return None
    device = torch.device(cfg["device"])
    pred = (predict(model, X, ex, device) >= THRESHOLD).astype(np.int8)
    res = _scores(y, pred, names, ex)
    res["loss"] = _loss_on(model, X, y, ex, device)
    yaws = [m.get("yaw") for m in meta]
    if any(v is not None for v in yaws):
        res["by_yaw"] = {}
        for v in sorted({v for v in yaws if v is not None}):
            idx = [i for i, w in enumerate(yaws) if w == v]
            res["by_yaw"][str(v)] = _scores(y[idx], pred[idx], names, ex)
    return res


def train_model(model, data: dict, cfg: dict, seed: int, out_dir: Path) -> dict:
    """학습(fit: train·val만) → 끝난 뒤 val·test_ec3d·test_own 평가 → out_dir/metrics.json.

    모델 초기값을 시드로 정하려면 모델을 만들기 전에 set_seed(seed)를 부른다(여기선 학습 순서만 고정).
    """
    cfg = {**DEFAULT_CFG, **cfg}
    set_seed(seed)
    info = fit(model, data["train"], data.get("val"), cfg, seed, out_dir)
    # ---- 여기부터 학습 끝. test 분할은 이 아래에서만 읽는다.
    res = {
        "exercise": cfg["exercise"], "seed": seed, "threshold": THRESHOLD, "train_info": info,
        "val": evaluate(model, data.get("val"), cfg),
        "test_ec3d": evaluate(model, data.get("test_ec3d"), cfg),
        "test_own": evaluate(model, data.get("test_own"), cfg),
    }
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    (Path(out_dir) / "metrics.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf8")
    return res


# ---------------------------------------------------------------- 실제 데이터 실행
def build_data(data_seed: int = 0) -> dict:
    """실제 데이터 → {분할: (X, Y, meta)}. 증강 시드는 data_seed로 고정(모델 시드와 별개)."""
    from wom_ml import dataset as ds

    reps = (ds.load_ec3d(paths.DATA_RAW / "ec3d") + ds.load_zenodo(paths.DATA_RAW / "zenodo")
            + ds.load_own(paths.PRIVATE_OWN))
    sp = ds.split(reps)
    out = {}
    for k in ds.SPLITS:
        X, Y, meta = ds.build_arrays(sp[k], train=(k == "train"), seed=data_seed)
        out[k] = (X.astype(np.float32), Y, meta)
    return out


def _mean_std(vals):
    a = np.asarray(vals, dtype=np.float64)
    return {"mean": float(a.mean()), "std": float(a.std(ddof=0)), "values": [float(v) for v in a]}


def summarize(results: list[dict]) -> dict:
    """시드별 결과 → 주요 지표 평균·표준편차."""
    ex = results[0]["exercise"]
    names = HEAD_LABELS[ex]
    s: dict = {"exercise": ex, "seeds": [r["seed"] for r in results],
               "best_epoch": [r["train_info"]["best_epoch"] for r in results]}
    for split in ("val", "test_ec3d", "test_own"):
        if results[0][split] is None:
            continue
        d = {f"{c}_f1": _mean_std([r[split]["per_error"][c]["f1"] for r in results]) for c in names}
        key = "app_style_rule_columns" if ex in RULE_COLUMNS else "app_style"
        for m in ("errors_caught_rate", "clean_flagged_rate"):
            d[f"{key}.{m}"] = _mean_std([r[split][key][m] for r in results])
        s[split] = d
    return s


def main(argv=None):
    ap = argparse.ArgumentParser(description="방식 A 작은 GRU 학습·평가")
    ap.add_argument("--exercise", default="squat", choices=list(HEAD_LABELS))
    ap.add_argument("--seeds", type=int, nargs="+", default=[0, 1, 2])
    ap.add_argument("--hidden", type=int, default=128)
    ap.add_argument("--out", type=Path, default=paths.RUNS / "small")
    a = ap.parse_args(argv)

    from wom_ml.models.small import SmallGRU

    data = build_data()
    heads = {ex: len(c) for ex, c in HEAD_LABELS.items()}
    cfg = {**DEFAULT_CFG, "exercise": a.exercise}
    results = []
    for seed in a.seeds:
        set_seed(seed)
        model = SmallGRU(heads, hidden=a.hidden)
        r = train_model(model, data, cfg, seed, a.out / f"seed{seed}")
        results.append(r)
        i = r["train_info"]
        line = f"seed {seed}: epochs {i['epochs_run']} best {i['best_epoch']} ({i['stopped_by']}, {i['seconds']}s)"
        for split in ("test_ec3d", "test_own"):
            if r[split] is not None:
                f1 = " ".join(f"{c}={v['f1']:.3f}" for c, v in r[split]["per_error"].items())
                line += f" | {split} F1 {f1}"
        print(line)
    s = summarize(results)
    (a.out / "summary.json").write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps(s, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

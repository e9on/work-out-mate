"""방식 A 작은 GRU와 학습 루프 테스트 — 합성 데이터만(개인 녹화는 열지 않는다)."""
import json

import numpy as np
import pytest
import torch

from wom_ml import train as tr
from wom_ml.models.small import SmallGRU
from wom_ml.sources import HEAD_LABELS

HEADS = {ex: len(c) for ex, c in HEAD_LABELS.items()}
T = 64


def _split(n_by_ex: dict[str, int], source="ec3d", subject="1", yaws=(None,), seed=0):
    """합성 (X, Y, meta) — build_arrays와 같은 형태. 운동이 아닌 행의 라벨은 -1."""
    rng = np.random.default_rng(seed)
    xs, metas, rows = [], [], []
    for ex, n in n_by_ex.items():
        for i in range(n):
            yaw = yaws[i % len(yaws)]
            xs.append(rng.uniform(-1, 1, (T, 17, 3)))
            metas.append({"source": source, "exercise": ex, "subject": subject, "yaw": yaw})
            rows.append((ex, rng.integers(0, 2, HEADS[ex])))
    X = np.stack(xs).astype(np.float32) if xs else np.zeros((0, T, 17, 3), np.float32)
    Y = {ex: np.full((len(xs), k), -1, np.int8) for ex, k in HEADS.items()}
    for i, (ex, y) in enumerate(rows):
        Y[ex][i] = y
    return X, Y, metas


def _data(val_ex=("squat",)):
    return {
        "train": _split({"squat": 24, "lunge": 16}, source="zenodo", subject="p01", seed=1),
        "val": _split({ex: 8 for ex in val_ex}, source="zenodo", subject="p02", seed=2),
        "test_ec3d": _split({"squat": 10, "lunge": 10}, source="ec3d", subject="4",
                            yaws=(0, 30, 45, 60, 90), seed=3),
        "test_own": _split({"squat": 6}, source="own", subject="own", seed=4),
    }


CFG = {"exercise": "squat", "device": "cpu", "batch_size": 8, "lr": 1e-3, "weight_decay": 0.0,
       "max_epochs": 4, "patience": 2, "fixed_epochs": {"lunge": 3, "plank": 3}}


# ---------------------------------------------------------------- 모델
def test_output_shape_per_exercise():
    m = SmallGRU(HEADS, hidden=32)
    x = torch.randn(5, T, 17, 3)
    for ex, k in HEADS.items():
        assert m(x, ex).shape == (5, k)


def test_unknown_exercise_raises():
    m = SmallGRU(HEADS, hidden=16)
    with pytest.raises(KeyError):
        m(torch.randn(2, T, 17, 3), "pushup")


def test_memorizes_small_random_batch():
    tr.set_seed(0)
    # CPU에서 빨리 끝나도록 작은 크기·짧은 시퀀스(모델은 시퀀스 길이에 무관)
    m = SmallGRU(HEADS, hidden=32)
    x = torch.randn(20, 16, 17, 3)
    y = torch.randint(0, 2, (20, HEADS["squat"])).float()
    opt = torch.optim.Adam(m.parameters(), lr=3e-3)
    loss_fn = torch.nn.BCEWithLogitsLoss()
    first = None
    for _ in range(300):
        opt.zero_grad()
        loss = loss_fn(m(x, "squat"), y)
        loss.backward()
        opt.step()
        first = loss.item() if first is None else first
    assert loss.item() < 0.2 * first and loss.item() < 0.1


# ---------------------------------------------------------------- 학습 루프
class TrapSplit:
    """학습이 끝나기 전에 건드리면 예외를 내는 test 분할 대역."""

    def __init__(self, inner):
        self.inner, self.open = inner, False

    def _get(self):
        if not self.open:
            raise AssertionError("학습 중에 test 분할에 접근함")
        return self.inner

    def __iter__(self):
        return iter(self._get())

    def __getitem__(self, i):
        return self._get()[i]

    def __len__(self):
        return len(self._get())


def test_train_model_never_touches_test_splits(tmp_path):
    # R15: train_model은 test 분할을 전혀 읽지 않는다(학습 중에도, 끝난 뒤에도).
    data = _data()
    traps = [TrapSplit(data[k]) for k in ("test_ec3d", "test_own")]
    data["test_ec3d"], data["test_own"] = traps
    res = tr.train_model(SmallGRU(HEADS, hidden=16), data, CFG, seed=0, out_dir=tmp_path)
    assert set(res) == {"exercise", "seed", "threshold", "train_info", "val"}
    assert not (tmp_path / "metrics.json").exists()
    saved = json.loads((tmp_path / "val_metrics.json").read_text(encoding="utf8"))
    assert "test_ec3d" not in saved and "test_own" not in saved


def test_final_eval_writes_test_metrics_to_file_only(tmp_path):
    data = _data()
    model = SmallGRU(HEADS, hidden=16)
    res = tr.train_model(model, data, CFG, seed=0, out_dir=tmp_path)
    out = tr.final_eval(model, data, CFG, res, tmp_path)
    assert isinstance(out, type(tmp_path)) and out == tmp_path / "metrics.json"  # 지표 dict를 돌려주지 않음
    saved = json.loads(out.read_text(encoding="utf8"))
    assert {"val", "test_ec3d", "test_own", "train_info"} <= set(saved)


@pytest.mark.parametrize("split", ["train", "val"])
@pytest.mark.parametrize("marker", [("own", "own"), ("ec3d", "4")])
def test_fit_rejects_test_marked_samples(tmp_path, split, marker):
    data = _data()
    X, Y, meta = data[split]
    meta[0] = {**meta[0], "source": marker[0], "subject": marker[1]}
    with pytest.raises(ValueError):
        tr.train_model(SmallGRU(HEADS, hidden=16), data, CFG, seed=0, out_dir=tmp_path)


def test_fit_signature_has_no_test_access():
    # fit은 train·val만 받는다(구조적으로 test에 닿을 수 없음).
    import inspect
    assert list(inspect.signature(tr.fit).parameters)[:3] == ["model", "train", "val"]


def test_train_model_outputs_and_metrics(tmp_path):
    data = _data()
    model = SmallGRU(HEADS, hidden=16)
    res = tr.train_model(model, data, CFG, seed=0, out_dir=tmp_path)
    info = res["train_info"]
    assert info["stopped_by"] in ("early_stop", "max_epochs")
    assert 1 <= info["best_epoch"] <= info["epochs_run"] <= CFG["max_epochs"]
    assert (tmp_path / "model.pt").exists()
    saved = json.loads(tr.final_eval(model, data, CFG, res, tmp_path).read_text(encoding="utf8"))
    assert saved["test_ec3d"]["n"] == 10
    assert set(saved["test_ec3d"]["by_yaw"]) == {"0", "30", "45", "60", "90"}
    assert saved["test_ec3d"]["by_yaw"]["45"]["n"] == 2
    assert set(saved["test_own"]["per_error"]) == set(HEAD_LABELS["squat"])
    assert set(saved["test_own"]["app_style_rule_columns"]) >= {"errors_total", "clean_total"}
    assert saved["test_own"]["n"] == 6
    # 집계만: 샘플별 예측·좌표가 들어가지 않는다
    assert "pred" not in json.dumps(saved) and "X" not in saved


def test_val_loss_never_improves_raises_clear_error(tmp_path, monkeypatch):
    # 검증 손실이 NaN이면 best_state가 None으로 남는다 -> load_state_dict(None) 대신 알아보기 쉬운 오류
    monkeypatch.setattr(tr, "_loss_on", lambda *a, **k: float("nan"))
    with pytest.raises(RuntimeError, match="검증 손실이 한 번도 좋아지지 않아"):
        tr.train_model(SmallGRU(HEADS, hidden=16), _data(), CFG, seed=0, out_dir=tmp_path)


def test_no_val_samples_uses_fixed_epochs(tmp_path):
    cfg = {**CFG, "exercise": "lunge"}
    data = _data(val_ex=("squat",))
    model = SmallGRU(HEADS, hidden=16)
    res = tr.train_model(model, data, cfg, seed=0, out_dir=tmp_path)
    info = res["train_info"]
    assert info["stopped_by"] == "fixed_epochs"
    assert info["epochs_run"] == 3 and info["best_epoch"] == 3
    assert res["val"] is None
    saved = json.loads(tr.final_eval(model, data, cfg, res, tmp_path).read_text(encoding="utf8"))
    assert saved["test_own"] is None  # 본인 녹화엔 런지가 없음
    assert saved["test_ec3d"]["n"] == 10


def test_fit_rejects_test_marker_in_other_exercise_rows(tmp_path):
    # 스쿼트를 학습할 때 런지 행에 있는 표식도 잡는다
    data = _data()
    X, Y, meta = data["train"]
    i = next(k for k, m in enumerate(meta) if m["exercise"] == "lunge")
    meta[i] = {**meta[i], "source": "own"}
    with pytest.raises(ValueError):
        tr.train_model(SmallGRU(HEADS, hidden=16), data, CFG, seed=0, out_dir=tmp_path)


def test_same_seed_same_result(tmp_path):
    # 모델 초기값도 시드로 정해지도록 만들기 전에 시드를 고정한다(train_model은 받은 모델을 그대로 씀).
    tr.set_seed(1)
    a = tr.train_model(SmallGRU(HEADS, hidden=16), _data(), CFG, seed=1, out_dir=tmp_path / "a")
    tr.set_seed(1)
    b = tr.train_model(SmallGRU(HEADS, hidden=16), _data(), CFG, seed=1, out_dir=tmp_path / "b")
    assert a["train_info"]["val_loss"] == b["train_info"]["val_loss"]

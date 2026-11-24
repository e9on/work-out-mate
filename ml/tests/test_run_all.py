"""단계별 실행(scripts/run_all.py) 테스트 — 합성 데이터와 작은 가짜 모델만(실제 학습·개인 녹화 없음)."""
import json
import sys
from pathlib import Path

import numpy as np
import pytest
import torch
import yaml
from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import run_all as ra  # noqa: E402

from wom_ml.sources import HEAD_LABELS  # noqa: E402

HEADS = {ex: len(c) for ex, c in HEAD_LABELS.items()}
T = 64
REAL_CONFIG = Path(__file__).resolve().parents[1] / "configs" / "experiments.yaml"
MB_STAGES = ["mb_probe", "mb_partial", "mb_full", "mb_full_lunge_plank"]


# ---------------------------------------------------------------- 합성 데이터
def _split(n_by_ex, source, subject, yaws=(None,), seed=0):
    rng = np.random.default_rng(seed)
    xs, metas, rows = [], [], []
    for ex, n in n_by_ex.items():
        for i in range(n):
            xs.append(rng.uniform(-1, 1, (T, 17, 3)))
            metas.append({"source": source, "exercise": ex, "subject": subject, "yaw": yaws[i % len(yaws)]})
            rows.append((ex, rng.integers(0, 2, HEADS[ex])))
    X = np.stack(xs).astype(np.float32)
    Y = {ex: np.full((len(xs), k), -1, np.int8) for ex, k in HEADS.items()}
    for i, (ex, y) in enumerate(rows):
        Y[ex][i] = y
    return X, Y, metas


def _data():
    tr_z = _split({"squat": 16}, "zenodo", "p01", seed=1)
    tr_e = _split({"lunge": 12, "plank": 12}, "ec3d", "1", yaws=(0, 45), seed=2)
    train = (np.concatenate([tr_z[0], tr_e[0]]), {ex: np.concatenate([tr_z[1][ex], tr_e[1][ex]]) for ex in HEADS},
             tr_z[2] + tr_e[2])
    return {
        "train": train,
        "val": _split({"squat": 8}, "zenodo", "p02", seed=3),
        "test_ec3d": _split({"squat": 5, "lunge": 5, "plank": 5}, "ec3d", "4", yaws=(0, 45), seed=4),
        "test_own": _split({"squat": 6}, "own", "own", seed=5),
    }


# ---------------------------------------------------------------- 가짜 모델
class TinySmall(nn.Module):
    def __init__(self, heads):
        super().__init__()
        self.body = nn.Linear(51, 8)
        self.heads = nn.ModuleDict({ex: nn.Linear(8, n) for ex, n in heads.items()})

    def forward(self, x, ex):
        return self.heads[ex](torch.tanh(self.body(x.mean(1).reshape(len(x), -1))))


class TinyMB(TinySmall):
    """MotionBertClassifier와 같은 약속(freeze, load_report, param_groups)만 흉내."""

    def __init__(self, heads, freeze, report="ok"):
        super().__init__(heads)
        self.freeze = freeze
        self.load_report = {"missing": [], "unexpected": ["head.weight", "head.bias"]} if report == "ok" else report
        for p in self.body.parameters():
            p.requires_grad = freeze != "probe"

    def param_groups(self, lr):
        g = [{"params": list(self.heads.parameters()), "lr": lr}]
        body = [p for p in self.body.parameters() if p.requires_grad]
        if body:
            g.append({"params": body, "lr": lr * (0.1 if self.freeze == "full" else 1.0)})
        return g


def _cfg(tmp_path, weights=True, **over):
    cfg = yaml.safe_load(REAL_CONFIG.read_text(encoding="utf8"))
    cfg["seeds"] = [0, 1]
    cfg["device"] = "cpu"
    cfg["common"].update({"max_epochs": 3, "patience": 2})
    cfg["stages"]["small"]["fixed_epochs"] = {"lunge": 2, "plank": 2}
    w = tmp_path / "w.bin"
    if weights:
        w.write_bytes(b"fake")
    cfg["weights"] = str(w)
    for k, v in over.items():
        cfg[k] = v
    p = tmp_path / "exp.yaml"
    p.write_text(yaml.safe_dump(cfg, allow_unicode=True), encoding="utf8")
    return p


@pytest.fixture
def fake(monkeypatch):
    """데이터·모델·규칙을 가짜로 바꾸고 train_model 호출을 기록한다."""
    data = _data()
    calls = {"train": [], "make": []}
    monkeypatch.setattr(ra, "load_data", lambda cfg: data)

    def make_model(scfg, heads, weights):
        calls["make"].append(scfg["kind"])
        return TinySmall(heads) if scfg["kind"] == "small" else TinyMB(heads, scfg["freeze"])

    monkeypatch.setattr(ra, "make_model", make_model)

    def run_rules(runs):
        (runs / "rules").mkdir(parents=True, exist_ok=True)
        (runs / "rules" / "metrics.json").write_text("{}", encoding="utf8")

    monkeypatch.setattr(ra, "run_rules", run_rules)
    real = ra.tr.train_model

    def spy(model, tdata, tcfg, seed, out_dir):
        calls["train"].append({"model": model, "data": tdata, "cfg": tcfg, "seed": seed, "out": Path(out_dir),
                               "start": {k: v.detach().clone() for k, v in model.state_dict().items()}})
        return real(model, tdata, tcfg, seed, out_dir)

    monkeypatch.setattr(ra.tr, "train_model", spy)
    return data, calls


def _run(tmp_path, cfg_path, stages, capsys=None):
    code = ra.main(["--config", str(cfg_path), "--runs", str(tmp_path / "runs"), "--stages", *stages])
    out = capsys.readouterr().out if capsys else ""
    return code, out


# ---------------------------------------------------------------- 설정·dry-run
def test_dry_run_lists_stages_and_splits(tmp_path, capsys):
    code = ra.main(["--config", str(REAL_CONFIG), "--runs", str(tmp_path / "runs"), "--dry-run"])
    out = capsys.readouterr().out
    assert code == 0
    for st in ra.STAGES:
        assert st in out
    assert "학습: train" in out and "선택: val" in out and "고정 epoch" in out
    assert not (tmp_path / "runs").exists()  # dry-run은 아무것도 만들지 않는다


def test_plan_never_trains_or_selects_on_test():
    cfg = ra.load_config(REAL_CONFIG)
    plan = ra.plan(cfg)
    assert [p["stage"] for p in plan] == list(ra.STAGES)
    for p in plan:
        for e in p["exercises"]:
            if p["kind"] == "rules":
                assert e["train"] is None and e["select"] is None
                continue
            assert e["train"] == "train"
            assert e["select"] in ("val", "fixed")
            assert e["train"] not in ra.TEST_SPLITS and e["select"] not in ra.TEST_SPLITS
            assert set(e["eval"]) <= {"val", *ra.TEST_SPLITS}
    by = {p["stage"]: p for p in plan}
    # R9: 런지·플랭크는 val이 없으니 고정 epoch
    for st in ("small", "mb_full_lunge_plank"):
        for e in by[st]["exercises"]:
            if e["exercise"] != "squat":
                assert e["select"] == "fixed"
    assert by["mb_partial"]["init_from"] == "mb_probe"
    assert by["mb_full"]["init_from"] == "mb_partial"
    assert by["mb_full_lunge_plank"]["init_from"] == "mb_full"


@pytest.mark.parametrize("path,value", [
    (("stages", "small", "train_split"), "test_own"),
    (("stages", "mb_probe", "select"), {"squat": "test_ec3d"}),
    (("stages", "mb_full", "batch_size"), 32),      # R17 full ≤ 16
    (("stages", "mb_partial", "batch_size"), 64),   # R17 partial ≤ 32
    (("stages", "mb_full", "body_lr_ratio"), None),  # full은 몸통 1/10 필수
    (("stages", "mb_partial", "init_from"), "mb_full"),  # 뒤 단계에서 시작할 수 없음
])
def test_validate_rejects(path, value):
    cfg = yaml.safe_load(REAL_CONFIG.read_text(encoding="utf8"))
    d = cfg
    for k in path[:-1]:
        d = d[k]
    if value is None:
        d.pop(path[-1])
    else:
        d[path[-1]] = value
    with pytest.raises(ValueError):
        ra.validate(cfg)


def test_full_without_param_groups_raises():
    m = TinyMB(HEADS, "full")
    with pytest.raises(ValueError):
        ra.check_param_groups(m, {"lr": 1e-4, "param_groups": None}, body_lr_ratio=0.1)
    # 몸통 학습률이 1/10이 아니어도 예외
    with pytest.raises(ValueError):
        ra.check_param_groups(m, {"lr": 1e-4, "param_groups": lambda mm: [{"params": list(mm.parameters()),
                                                                           "lr": 1e-4}]}, body_lr_ratio=0.1)


def test_mb_requires_pretrained_weights_loaded():
    with pytest.raises(RuntimeError):
        ra.check_pretrained(TinyMB(HEADS, "probe", report=None))
    with pytest.raises(RuntimeError):
        ra.check_pretrained(TinyMB(HEADS, "probe", report={"missing": [], "unexpected": ["blocks_st.0.x"]}))
    assert ra.check_pretrained(TinyMB(HEADS, "probe"))["loaded"] is True


# ---------------------------------------------------------------- 실행(가짜)
def test_chain_resumes_from_previous_stage_checkpoints(tmp_path, fake, capsys):
    data, calls = fake
    code, out = _run(tmp_path, _cfg(tmp_path), MB_STAGES, capsys)
    assert code == 0
    runs = tmp_path / "runs"
    by = {}
    for c in calls["train"]:
        by[(c["out"].parts[-3], c["seed"], c["out"].parts[-1])] = c
    for seed in (0, 1):
        for st, prev in (("mb_partial", "mb_probe"), ("mb_full", "mb_partial")):
            start = by[(st, seed, "squat")]["start"]
            ck = torch.load(runs / prev / f"seed{seed}" / "squat" / "model.pt", weights_only=True)
            assert all(torch.equal(start[k], ck[k]) for k in ck), f"{st} seed{seed}가 {prev} 체크포인트에서 시작 안 함"
            m = json.loads((runs / st / f"seed{seed}" / "metrics.json").read_text(encoding="utf8"))
            assert m["init_from"].replace("\\", "/").endswith(f"{prev}/seed{seed}/squat/model.pt")
            assert m["pretrained"]["loaded"] is True
        # 런지·플랭크 머리: mb_full 몸통에서 시작, 몸통·스쿼트 머리는 바뀌지 않음
        full = torch.load(runs / "mb_full" / f"seed{seed}" / "squat" / "model.pt", weights_only=True)
        lp = by[(("mb_full_lunge_plank"), seed, "lunge")]
        assert all(torch.equal(lp["start"][k], full[k]) for k in full)
        after = torch.load(runs / "mb_full_lunge_plank" / f"seed{seed}" / "plank" / "model.pt", weights_only=True)
        for k in full:
            if k.startswith("body.") or k.startswith("heads.squat."):
                assert torch.equal(after[k], full[k]), k
    # mb_full은 몸통 학습률 = 머리 × 0.1
    c = by[("mb_full", 0, "squat")]
    lrs = sorted(g["lr"] for g in c["cfg"]["param_groups"](c["model"]))
    assert lrs == pytest.approx([1e-5, 1e-4])
    # 고정 epoch(R9): 런지·플랭크는 val 없이, epoch 수는 mb_probe 스쿼트 val 최적 epoch의 시드 최대값
    best = max(json.loads((runs / "mb_probe" / f"seed{s}" / "squat" / "val_metrics.json").read_text(
        encoding="utf8"))["train_info"]["best_epoch"] for s in (0, 1))
    for (st, seed, ex), c in by.items():
        if ex in ("lunge", "plank"):
            assert c["data"]["val"] is None
            m = json.loads((c["out"] / "metrics.json").read_text(encoding="utf8"))
            assert m["train_info"]["epochs_run"] == best and m["train_info"]["stopped_by"] == "fixed_epochs"


def test_training_only_sees_train_and_val(tmp_path, fake, capsys):
    data, calls = fake
    code, out = _run(tmp_path, _cfg(tmp_path), ["small", *MB_STAGES], capsys)
    assert code == 0
    assert calls["train"]
    for c in calls["train"]:
        assert set(c["data"]) == {"train", "val"}
        assert c["data"]["train"] is data["train"]
        assert c["data"]["val"] is (data["val"] if c["out"].name == "squat" else None)
    # 터미널에 test 지표를 찍지 않는다(R15) — test 분할 이름조차 나오지 않는다
    assert "test_ec3d" not in out and "test_own" not in out
    # test 지표는 파일에만
    m = json.loads((tmp_path / "runs" / "small" / "seed0" / "squat" / "metrics.json").read_text(encoding="utf8"))
    assert m["test_ec3d"] is not None and m["test_own"] is not None


def test_small_trains_three_exercises_per_seed(tmp_path, fake, capsys):
    data, calls = fake
    code, _ = _run(tmp_path, _cfg(tmp_path), ["small"], capsys)
    assert code == 0
    for seed in (0, 1):
        d = tmp_path / "runs" / "small" / f"seed{seed}"
        m = json.loads((d / "metrics.json").read_text(encoding="utf8"))
        assert set(m["exercises"]) == {"squat", "lunge", "plank"}
        assert m["exercises"]["lunge"]["train_info"]["epochs_run"] == 2  # 고정 epoch
        assert (d / "done.json").exists()
    s = json.loads((tmp_path / "runs" / "small" / "summary.json").read_text(encoding="utf8"))
    assert set(s) == {"squat", "lunge", "plank"}


def test_done_stages_are_skipped(tmp_path, fake, capsys):
    data, calls = fake
    cfg = _cfg(tmp_path)
    _run(tmp_path, cfg, ["rules", "small", "mb_probe"], capsys)
    n = len(calls["train"])
    code, out = _run(tmp_path, cfg, ["rules", "small", "mb_probe"], capsys)
    assert code == 0
    assert len(calls["train"]) == n  # 다시 학습하지 않음
    assert out.count("건너뜀") >= 5  # rules 1 + small 2시드 + mb_probe 2시드


def test_missing_weights_skips_mb_stages(tmp_path, fake, capsys):
    data, calls = fake
    cfg = _cfg(tmp_path, weights=False)
    code, out = _run(tmp_path, cfg, ["rules", "small", *MB_STAGES], capsys)
    assert code == ra.EXIT_NO_WEIGHTS != 0
    assert "mb" not in calls["make"]  # 무작위 몸통으로 절대 돌지 않음
    runs = tmp_path / "runs"
    assert (runs / "small" / "seed1" / "done.json").exists()
    assert (runs / "rules" / "done.json").exists()
    for st in MB_STAGES:
        assert not (runs / st).exists()
    status = json.loads((runs / "run_all_status.json").read_text(encoding="utf8"))
    for st in MB_STAGES:
        assert status[st]["status"] == "skipped_no_weights"
    assert "motionbert_lite.bin" in out or "가중치" in out
    # 가중치가 생기면 같은 명령으로 이어서: rules·small은 건너뛰고 mb_*만
    Path(yaml.safe_load(cfg.read_text(encoding="utf8"))["weights"]).write_bytes(b"fake")
    n_small = sum(1 for c in calls["train"] if c["out"].parts[-3] == "small")
    code, out = _run(tmp_path, cfg, ["rules", "small", *MB_STAGES], capsys)
    assert code == 0
    assert sum(1 for c in calls["train"] if c["out"].parts[-3] == "small") == n_small
    status = json.loads((runs / "run_all_status.json").read_text(encoding="utf8"))
    assert all(status[st]["status"] == "done" for st in MB_STAGES)

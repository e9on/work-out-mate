"""오류별 지표·규칙 판정 기준선 테스트 — 합성 데이터만(개인 녹화는 열지 않는다)."""
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

import test_dataset as td
from wom_ml import metrics as mt
from wom_ml.sources import own as own_src

REPO = Path(__file__).resolve().parents[2]
NAMES = ["kneeIn", "shallow"]


# ---------------------------------------------------------------- per_error
def test_per_error_hand_computed():
    # kneeIn: 정답 1 1 1 0 0 / 예측 1 1 0 1 0 -> tp2 fp1 fn1
    yt = np.array([[1, 0], [1, 0], [1, 0], [0, 0], [0, 1]])
    yp = np.array([[1, 0], [1, 0], [0, 0], [1, 0], [0, 1]])
    r = mt.per_error(yt, yp, NAMES)
    k = r["kneeIn"]
    assert (k["tp"], k["fp"], k["fn"]) == (2, 1, 1)
    assert k["precision"] == pytest.approx(2 / 3, abs=1e-3)
    assert k["recall"] == pytest.approx(2 / 3, abs=1e-3)
    assert k["f1"] == pytest.approx(2 / 3, abs=1e-3)
    s = r["shallow"]
    assert (s["tp"], s["fp"], s["fn"]) == (1, 0, 0) and s["f1"] == 1.0


def test_per_error_no_positives_no_division_by_zero():
    yt = np.zeros((4, 2), dtype=int)
    r = mt.per_error(yt, yt.copy(), NAMES)
    for n in NAMES:
        assert r[n]["precision"] == 0.0 and r[n]["recall"] == 0.0 and r[n]["f1"] == 0.0
        assert r[n]["tp"] == r[n]["fp"] == r[n]["fn"] == 0


def test_per_error_ignores_masked_rows():
    yt = np.array([[1, 0], [-1, -1]])
    yp = np.array([[1, 0], [1, 1]])
    r = mt.per_error(yt, yp, NAMES)
    assert r["kneeIn"]["fp"] == 0 and r["shallow"]["fp"] == 0


def test_per_error_checks_shape():
    with pytest.raises(ValueError):
        mt.per_error(np.zeros((3, 2)), np.zeros((3, 2)), ["a"])


# ---------------------------------------------------------------- app_style
def test_app_style():
    # 오류 있는 반복 3개(1개 잡음, 1개는 다른 칸만 잡아 놓침, 1개 놓침), 오류 없는 반복 3개(1개 잘못 지적)
    yt = np.array([[1, 0], [0, 1], [1, 0], [0, 0], [0, 0], [0, 0]])
    yp = np.array([[1, 0], [1, 0], [0, 0], [0, 0], [0, 1], [0, 0]])
    a = mt.app_style(yt, yp, NAMES)
    assert a["errors_total"] == 3 and a["errors_caught"] == 1
    assert a["clean_total"] == 3 and a["clean_flagged"] == 1
    assert a["errors_caught_rate"] == pytest.approx(1 / 3)
    assert a["clean_flagged_rate"] == pytest.approx(1 / 3)


def test_app_style_empty_groups():
    a = mt.app_style(np.zeros((2, 2), dtype=int), np.zeros((2, 2), dtype=int), NAMES)
    assert a["errors_total"] == 0 and a["errors_caught_rate"] == 0.0
    assert a["clean_total"] == 2 and a["clean_flagged_rate"] == 0.0


# ---------------------------------------------------------------- raw_sets(원본 프레임)
def test_raw_sets_matches_load_own_boundaries(tmp_path):
    td.write_own(tmp_path)
    reps = own_src.load_own(tmp_path)
    sets = own_src.raw_sets(tmp_path)
    assert [s["file"] for s in sets] == sorted({r.meta["file"] for r in reps}, key=[s["file"] for s in sets].index)
    n_raw = sum(len(s["reps"]) for s in sets)
    assert n_raw == len(reps) == 44
    assert "front.json" not in [s["file"] for s in sets]  # R7 제외도 같다
    lite = next(s for s in sets if s["file"] == "side.json")
    assert lite["kind"] == "mediapipe" and len(lite["frames"][0]["kps"]) == 33
    for r in lite["reps"]:
        assert r["startT"] <= r["bottomT"] <= r["endT"]
    vid = next(s for s in sets if s["kind"] == "halpe")
    assert len(vid["frames"][0]["kps"]) == 26 and any(f["kps"] is None for f in vid["frames"])
    json.dumps(sets)  # JSON으로 저장 가능


# ---------------------------------------------------------------- run_rules.ts
def synth_set(depth_knee_deg: float, n_stand=40):
    """Halpe26 합성 세트: 서 있다가 앉고 다시 서는 반복 하나. 다리는 정면, 무릎 각도만 조절."""
    frames = []
    T = 100  # ms 간격
    n = n_stand + 30 + n_stand
    for i in range(n):
        if i < n_stand or i >= n_stand + 30:
            deg = 175.0
        else:
            ph = (i - n_stand) / 29
            deg = 175 - (175 - depth_knee_deg) * np.sin(np.pi * ph)
        th = np.deg2rad(180 - deg)
        kps = [[0.0, 0.0, 0.0] for _ in range(26)]
        for side, x in ((11, 100.0), (12, 300.0)):
            hip, knee, ank = side, side + 2, side + 4
            kps[hip] = [x, 500.0, 0.9]
            kps[knee] = [x, 700.0, 0.9]
            kps[ank] = [x + 200 * np.sin(th), 700 + 200 * np.cos(th), 0.9]
        for j, p in ((20, 11), (21, 12), (24, 11), (25, 12)):
            kps[j] = [kps[p + 4][0], kps[p + 4][1] + 10, 0.9]
        frames.append({"t": i * T, "kps": kps})
    rep = {"index": 1, "startT": n_stand * T, "bottomT": (n_stand + 15) * T, "endT": (n_stand + 30) * T}
    return {"file": f"synth{int(depth_knee_deg)}", "kind": "halpe", "frames": frames, "reps": [rep]}


@pytest.mark.skipif(shutil.which("node") is None, reason="node 없음")
def test_run_rules_deep_vs_shallow(tmp_path):
    bundle = tmp_path / "run_rules.cjs"
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if npx is None:
        pytest.skip("npx 없음")
    subprocess.run([npx, "esbuild", str(REPO / "ml/rules/run_rules.ts"), "--bundle", "--platform=node",
                    f"--outfile={bundle}"], cwd=REPO, check=True, capture_output=True)
    inp, out = tmp_path / "in.json", tmp_path / "out.json"
    inp.write_text(json.dumps({"sets": [synth_set(80), synth_set(130)]}))
    subprocess.run(["node", str(bundle), str(inp), str(out)], check=True, capture_output=True)
    res = {s["file"]: s["reps"] for s in json.loads(out.read_text())["sets"]}
    deep, shallow = res["synth80"][0], res["synth130"][0]
    assert deep["shallow"] == 0 and deep["kneeIn"] == 0 and deep["skipped"] is None
    assert shallow["shallow"] == 1 and shallow["kneeIn"] == 0


# ---------------------------------------------------------------- rules_baseline 집계
def test_make_metrics_from_synthetic_output(tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("rules_baseline", REPO / "ml/scripts/rules_baseline.py")
    rb = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rb)
    td.write_own(tmp_path)
    reps = own_src.load_own(tmp_path)
    sets = {}
    for r in reps:  # 정답을 그대로 맞히는 가짜 출력 + 하나는 놓침 + 하나는 잘못 지적
        sets.setdefault(r.meta["file"], []).append(
            {"index": r.meta["index"], "kneeIn": r.labels["kneeIn"], "shallow": r.labels["shallow"], "skipped": None})
    first = sets["side.json"][0]
    first["kneeIn"] = 1  # 정상 반복을 잘못 지적
    out = {"sets": [{"file": f, "reps": v} for f, v in sets.items()]}
    m = rb.make_metrics(reps, out)
    assert m["n_reps"] == 44 and m["columns_with_rules"] == ["kneeIn", "shallow"]
    assert set(m["columns_without_rules"]) == {"feetWide", "trunkLean"}
    assert m["per_error"]["kneeIn"]["fp"] == 1 and m["per_error"]["kneeIn"]["fn"] == 0
    assert m["app_style"]["clean_flagged"] == 1
    out["sets"][0]["reps"].pop()
    with pytest.raises(ValueError):
        rb.make_metrics(reps, out)

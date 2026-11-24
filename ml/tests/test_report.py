"""결과 보고서(wom_ml.report) 테스트 — 가짜 metrics만 쓴다(실제 결과·개인 녹화 없음)."""
import json
from pathlib import Path

import pytest

from wom_ml import report as rp
from wom_ml.sources import HEAD_LABELS

YAWS = ("0", "30", "45", "60", "90")
# 개인 좌표처럼 보이는 표식 값. 출력 어디에도 나오면 안 된다.
SECRET = [987.654321, 123.456789, 0.4242424242]


def _pe(f1s: dict) -> dict:
    return {c: {"precision": f, "recall": f, "f1": f, "tp": 1, "fp": 0, "fn": 0} for c, f in f1s.items()}


def _app(caught, total, flagged, clean):
    return {"errors_total": total, "errors_caught": caught, "errors_caught_rate": caught / total if total else 0.0,
            "clean_total": clean, "clean_flagged": flagged, "clean_flagged_rate": flagged / clean if clean else 0.0}


def _split_block(ex, f, with_yaw):
    cols = HEAD_LABELS[ex]
    d = {"n": 10, "per_error": _pe({c: f for c in cols}), "app_style": _app(3, 4, 1, 6), "loss": 0.5,
         # 개인 좌표·프레임처럼 보이는 필드(보고서가 옮기면 안 됨)
         "frames": [{"t": SECRET[0], "kps": [[SECRET[1], SECRET[2], 1.0]]}],
         "pred": [[SECRET[0], SECRET[1]]]}
    if ex == "squat":
        d["app_style_rule_columns"] = _app(2, 4, 1, 6)
    if with_yaw:
        d["by_yaw"] = {y: {"n": 2, "per_error": _pe({c: f for c in cols}), "app_style": _app(1, 1, 0, 1)}
                       for y in YAWS}
    return d


def _seed_metrics(stage, seed, exercises, f, batch=64):
    exs = {}
    for ex in exercises:
        exs[ex] = {"exercise": ex, "seed": seed, "threshold": 0.5,
                   "train_info": {"best_epoch": 3 + seed, "stopped_by": "early_stop", "history": [{"epoch": 1}]},
                   "val": _split_block(ex, f, False) if ex == "squat" else None,
                   "test_ec3d": _split_block(ex, f, True),
                   "test_own": _split_block(ex, f, False) if ex == "squat" else None}
    return {"stage": stage, "seed": seed, "batch_size": batch, "exercises": exs}


def _write(p: Path, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj), encoding="utf8")


def _rules(runs: Path):
    _write(runs / "rules" / "metrics.json", {
        "n_reps": 4, "per_error": {"kneeIn": {"precision": 1.0, "recall": 0.5, "f1": 0.6667, "tp": 1, "fp": 0, "fn": 1},
                                   "shallow": {"precision": 1.0, "recall": 1.0, "f1": 1.0, "tp": 1, "fp": 0, "fn": 0}},
        "app_style": _app(2, 3, 0, 1), "skipped": {"noPerson": 1, "oneLeg": 0}})
    # 규칙 출력: diag45-12 1~4 정상, 5 kneeIn(판정 못 함), 영상 17 shallow. 원본 좌표 필드도 섞어 둔다.
    _write(runs / "rules" / "output.json", {"sets": [
        {"file": "diag45-12.json", "frames": [{"t": SECRET[0], "kps": [[SECRET[1], SECRET[2], 1]]}], "reps": [
            {"index": 1, "kneeIn": 0, "shallow": 0, "skipped": None, "bottomT": SECRET[0]},
            {"index": 5, "kneeIn": 0, "shallow": 0, "skipped": "noPerson"},
            {"index": 6, "kneeIn": 1, "shallow": 0, "skipped": None}]},
        {"file": "rtm-litebox-1.0.json", "reps": [
            {"index": 17, "kneeIn": 0, "shallow": 1, "skipped": None}]}]})


@pytest.fixture
def runs(tmp_path):
    r = tmp_path / "runs"
    _rules(r)
    for k, f in enumerate([0.2, 0.4, 0.6]):
        _write(r / "small" / f"seed{k}" / "metrics.json", _seed_metrics("small", k, ["squat", "lunge", "plank"], f))
        _write(r / "small" / f"seed{k}" / "done.json", {"stage": "small", "seed": k})
    _write(r / "run_all_status.json", {"rules": {"status": "done", "seconds": 1.0},
                                       "small": {"status": "done", "seconds_total": 3.0},
                                       **{s: {"status": "skipped_no_weights"} for s in rp.MB_STAGES}})
    _write(r / "dataset_summary.json", {"splits": {
        "train": {"reps": {"ec3d/squat": 7, "zenodo/squat": 5}, "samples": 80},
        "val": {"reps": {"zenodo/squat": 3}, "samples": 3},
        "test_ec3d": {"reps": {"ec3d/squat": 2, "ec3d/lunge": 2, "ec3d/plank": 2}, "samples": 30},
        "test_own": {"reps": {"own/squat": 4}, "samples": 4}}, "own_excluded": {"front.json": "제외(R7)"}})
    return r


def test_mean_std_population():
    m, s = rp.mean_std([0.2, 0.4, 0.6])
    assert m == pytest.approx(0.4)
    assert s == pytest.approx(0.16329931618554522)  # ddof=0 (run_all summary와 같은 정의)
    assert rp.fmt_ms([0.2, 0.4, 0.6]) == "0.40±0.16"
    assert rp.fmt_ms([0.5]) == "0.50"


def test_render_has_tables(runs):
    md = rp.render_report(runs)
    assert "## 표 1" in md and "## 표 2" in md and "데이터 개수" in md
    # 시드 평균±표준편차가 표에 들어감(small kneeIn F1 = 0.2/0.4/0.6)
    assert "0.40±0.16" in md
    # 규칙 기준선 값
    assert "0.67" in md
    # 가중치가 없는 MotionBERT 단계는 오류가 아니라 안내 행
    assert md.count(rp.PENDING) >= 3
    # EC3D yaw별 열
    for y in YAWS:
        assert f"{y}°" in md
    # 데이터 개수
    assert "zenodo/squat" in md and "440" not in md  # 가짜 summary 값만


def test_rules_judged_only(runs):
    out = json.loads((runs / "rules" / "output.json").read_text(encoding="utf8"))
    j = rp.rules_judged_only(out)
    assert j["n_judged"] == 3 and j["n_skipped"] == 1
    assert j["skipped_by_file"] == {"diag45-12.json": {"n": 3, "skipped": 1}, "rtm-litebox-1.0.json": {"n": 1, "skipped": 0}}
    # 판정한 반복만: kneeIn 정답은 6번(1개) → 잡음, shallow 17번 → 잡음
    assert j["per_error"]["kneeIn"]["tp"] == 1 and j["per_error"]["kneeIn"]["fn"] == 0
    assert j["per_error"]["shallow"]["f1"] == pytest.approx(1.0)


def test_no_private_values_in_output(runs):
    md = rp.render_report(runs)
    for v in SECRET:
        for s in (repr(v), f"{v:.2f}", f"{v:.3f}", f"{v:.4f}", str(v)[:6]):
            assert s not in md, s
    for key in ("frames", "kps", "bottomT", "pred"):
        assert key not in md


def test_mb_rows_fill_in_when_results_exist(runs):
    for k in range(3):
        _write(runs / "mb_probe" / f"seed{k}" / "metrics.json", _seed_metrics("mb_probe", k, ["squat"], 0.9, batch=12))
        _write(runs / "mb_probe" / f"seed{k}" / "done.json", {"stage": "mb_probe", "seed": k})
    md = rp.render_report(runs)
    assert "0.90" in md
    assert "| 12 |" in md  # 실제로 쓴 배치(R21)가 표에 나옴


def test_incomplete_seed_ignored(runs):
    # done.json이 없는 시드(중단)는 평균에 넣지 않는다
    _write(runs / "small" / "seed3" / "metrics.json", _seed_metrics("small", 3, ["squat", "lunge", "plank"], 0.99))
    md = rp.render_report(runs)
    assert "0.99" not in md and "0.40±0.16" in md


def test_update_doc_keeps_human_text():
    doc = f"# 제목\n\n사람이 쓴 앞\n\n{rp.START}\n옛 표\n{rp.END}\n\n## 해석\n사람이 쓴 뒤\n"
    new = rp.update_doc(doc, "새 표")
    assert "사람이 쓴 앞" in new and "사람이 쓴 뒤" in new and "새 표" in new and "옛 표" not in new
    # 표식이 없는 문서는 새 틀
    fresh = rp.update_doc(None, "새 표")
    assert rp.START in fresh and rp.END in fresh and "새 표" in fresh
    with pytest.raises(ValueError):
        rp.update_doc("표식 없는 문서", "새 표")

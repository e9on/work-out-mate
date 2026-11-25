"""규칙 판정 기준선: test_own 반복(Task 4와 같은 44개, 같은 경계·라벨)에 core 규칙을 돌려 지표를 만든다.

흐름: own.load_own(정답 라벨) + own.raw_sets(정규화 전 원본 프레임) -> ml/runs/rules/input.json
      -> esbuild로 ml/rules/run_rules.ts를 묶어 node 실행 -> ml/runs/rules/output.json
      -> 지표 -> ml/runs/rules/metrics.json (집계만. 개인 좌표·수치 없음).

규칙이 내지 않는 칸(HEAD_LABELS squat 중 kneeIn·shallow 외)은 "규칙 없음"으로 표시하고 지표에서 뺀다.
실행(ml 폴더 기준 아무 곳에서나): python scripts/rules_baseline.py
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wom_ml import metrics as mt  # noqa: E402
from wom_ml import paths  # noqa: E402
from wom_ml.sources import HEAD_LABELS  # noqa: E402
from wom_ml.sources import own as own_src  # noqa: E402

RULES_DIR = paths.RUNS / "rules"
RULE_COLUMNS = ["kneeIn", "shallow"]  # 규칙이 내는 칸


def build_arrays(reps, output: dict) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """Rep 목록(정답)과 run_rules 출력 -> (y_true, y_pred, 반복별 부가정보). 반복 키(파일, 번호)가 어긋나면 ValueError."""
    pred = {(s["file"], r["index"]): r for s in output["sets"] for r in s["reps"]}
    keys = [(r.meta["file"], r.meta["index"]) for r in reps]
    if set(keys) != set(pred) or len(keys) != len(set(keys)):
        raise ValueError("규칙 출력의 반복 집합이 test_own 반복과 다름")
    yt = np.array([[r.labels[c] for c in RULE_COLUMNS] for r in reps], dtype=np.int8)
    yp = np.array([[pred[k][c] for c in RULE_COLUMNS] for k in keys], dtype=np.int8)
    info = [{"file": k[0], "group": r.meta["group"], "skipped": pred[k]["skipped"]} for k, r in zip(keys, reps)]
    return yt, yp, info


def make_metrics(reps, output: dict) -> dict:
    yt, yp, info = build_arrays(reps, output)
    unruled = [c for c in HEAD_LABELS["squat"] if c not in RULE_COLUMNS]
    by_group = {}
    for g in sorted({i["group"] for i in info}):
        idx = [n for n, i in enumerate(info) if i["group"] == g]
        by_group[g] = {"n": len(idx), **{f"{c}_flagged": int(yp[idx, j].sum()) for j, c in enumerate(RULE_COLUMNS)}}
    return {
        "n_reps": len(reps),
        "files": sorted({i["file"] for i in info}),
        "columns_with_rules": RULE_COLUMNS,
        "columns_without_rules": {c: "규칙 없음(지표에서 제외)" for c in unruled},
        "per_error": mt.per_error(yt, yp, RULE_COLUMNS),
        "app_style": mt.app_style(yt, yp, RULE_COLUMNS),
        "skipped": {k: sum(1 for i in info if i["skipped"] == k) for k in ("noPerson", "oneLeg")},
        "flagged_by_group": by_group,
    }


def run_node(inp: Path, out: Path) -> None:
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    node = shutil.which("node")
    if not npx or not node:
        raise RuntimeError("node/npx가 필요함")
    bundle = RULES_DIR / "run_rules.cjs"
    subprocess.run([npx, "esbuild", str(paths.ML_ROOT / "rules" / "run_rules.ts"), "--bundle",
                    "--platform=node", f"--outfile={bundle}"], cwd=paths.REPO_ROOT, check=True)
    subprocess.run([node, str(bundle), str(inp), str(out)], check=True)


def main(argv=None):
    argparse.ArgumentParser(description="규칙 판정 기준선").parse_args(argv)
    RULES_DIR.mkdir(parents=True, exist_ok=True)
    reps = own_src.load_own(paths.PRIVATE_OWN)  # Task 4와 같은 기본값(R7 제외) -> 44개
    inp, out = RULES_DIR / "input.json", RULES_DIR / "output.json"
    inp.write_text(json.dumps({"sets": own_src.raw_sets(paths.PRIVATE_OWN)}), encoding="utf8")
    run_node(inp, out)
    res = make_metrics(reps, json.loads(out.read_text(encoding="utf8")))
    (RULES_DIR / "metrics.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

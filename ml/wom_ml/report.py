"""실험 결과 보고서의 표 부분을 `ml/runs/` 결과에서 만든다.

- `render_report(runs)`: 마크다운 문자열(표 1 본인 녹화, 규칙 판정 부가 지표(R10), 표 2 EC3D 피험자 4 + yaw별(R11),
  데이터 개수, 단계 상태). 결과가 없는 MotionBERT 단계는 오류가 아니라 '가중치 받은 뒤 실행' 행으로 둔다(R22).
- `update_doc(doc, generated)`: 보고서 파일에서 START~END 표식 사이만 바꾼다(사람이 쓴 해석은 그대로).

개인 데이터: 결과 파일에서 **정해진 집계 키만** 골라 읽는다(F1, tp/fp/fn, 잡음·오탐 수, 반복 수, 판정 못 한 이유).
좌표·프레임·시각 같은 다른 필드는 읽지도 옮기지도 않는다. 규칙 입력(rules/input.json, 원본 프레임)은 열지 않는다.

실행(ml 폴더에서): python -m wom_ml.report            → docs/finetune-experiment-results.md 갱신
                  python -m wom_ml.report --stdout   → 화면에만
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from wom_ml import metrics as mt
from wom_ml import paths
from wom_ml.sources import HEAD_LABELS

PENDING = "가중치 받은 뒤 실행"
NOT_RUN = "아직 실행 안 함"
START = "<!-- report:start — 이 아래 표는 `python -m wom_ml.report`가 자동으로 다시 쓴다. 손으로 고치지 말 것 -->"
END = "<!-- report:end -->"
DOC = paths.REPO_ROOT / "docs" / "finetune-experiment-results.md"

MB_STAGES = ("mb_probe", "mb_partial", "mb_full", "mb_full_lunge_plank")
STAGE_NAMES = {
    "rules": "규칙 판정(지금 앱)",
    "small": "방식 A: 작은 GRU(처음부터)",
    "mb_probe": "MotionBERT ① 머리만",
    "mb_partial": "MotionBERT ② 뒤 2블록+머리",
    "mb_full": "MotionBERT ③ 전체",
    "mb_full_lunge_plank": "MotionBERT ③ 몸통 + 런지·플랭크 머리",
}
SQUAT_STAGES = ("small", "mb_probe", "mb_partial", "mb_full")
LP_STAGES = ("small", "mb_full_lunge_plank")  # 런지·플랭크 머리를 가진 단계
YAWS = ("0", "30", "45", "60", "90")
RULE_COLUMNS = ("kneeIn", "shallow")
VIEW_NAMES = {
    "diag45-12.json": "45도 12회 (MediaPipe lite)",
    "diag45.json": "45도 6회 (MediaPipe lite)",
    "side.json": "옆 6회 (MediaPipe lite)",
    "front.json": "정면 6회 (MediaPipe lite)",
    "rtm-litebox-1.0.json": "영상 20회 (RTMPose, 45도 근처)",
}
SKIP_NAMES = {"noPerson": "사람 못 찾음(noPerson)", "oneLeg": "한쪽 다리만 보임(oneLeg)"}


# ---------------------------------------------------------------- 읽기
def _read(p: Path):
    return json.loads(Path(p).read_text(encoding="utf8"))


def load_seeds(runs: Path, stage: str) -> list[dict]:
    """끝난 시드(done.json 있음)의 seed<k>/metrics.json, 시드 번호순. 중단된 시드는 넣지 않는다."""
    d = Path(runs) / stage
    if not d.is_dir():
        return []
    out = []
    for s in d.glob("seed*"):
        if (s / "done.json").is_file() and (s / "metrics.json").is_file() and s.name[4:].isdigit():
            out.append((int(s.name[4:]), _read(s / "metrics.json")))
    return [m for _, m in sorted(out, key=lambda t: t[0])]


def _status(runs: Path) -> dict:
    p = Path(runs) / "run_all_status.json"
    return _read(p) if p.is_file() else {}


def _missing(stage: str, status: dict) -> str:
    st = (status.get(stage) or {}).get("status")
    if stage in MB_STAGES and st in (None, "skipped_no_weights"):
        return PENDING
    return NOT_RUN


# ---------------------------------------------------------------- 숫자 모양
def mean_std(vals) -> tuple[float, float]:
    """시드 평균과 모표준편차(ddof=0, run_all summary와 같은 정의)."""
    a = np.asarray(list(vals), dtype=float)
    return float(a.mean()), float(a.std(ddof=0))


def fmt_ms(vals, pct: bool = False) -> str:
    vals = list(vals)
    if not vals:
        return "—"
    m, s = mean_std(vals)
    if pct:
        return f"{m * 100:.0f}%" if len(vals) == 1 else f"{m * 100:.0f}%±{s * 100:.0f}"
    return f"{m:.2f}" if len(vals) == 1 else f"{m:.2f}±{s:.2f}"


def _count(a: dict, kind: str) -> str:
    """앱 방식 한 칸: 'caught/total (비율)'."""
    if kind == "caught":
        n, d = a["errors_caught"], a["errors_total"]
    else:
        n, d = a["clean_flagged"], a["clean_total"]
    return f"{n}/{d} ({(n / d * 100) if d else 0:.0f}%)"


def _app_seeds(blocks: list[dict], key: str, kind: str) -> str:
    """시드별 앱 방식 값 → '평균%±편차 (시드별 n/d)'."""
    rate = "errors_caught_rate" if kind == "caught" else "clean_flagged_rate"
    vals = [b[key][rate] for b in blocks]
    if kind == "caught":
        counts = "·".join(f"{b[key]['errors_caught']}/{b[key]['errors_total']}" for b in blocks)
    else:
        counts = "·".join(f"{b[key]['clean_flagged']}/{b[key]['clean_total']}" for b in blocks)
    return f"{fmt_ms(vals, pct=True)} ({counts})"


def _f1(blocks: list[dict], col: str) -> str:
    return fmt_ms(b["per_error"][col]["f1"] for b in blocks)


def _row(cells) -> str:
    return "| " + " | ".join(str(c) for c in cells) + " |"


def _table(header, rows) -> list[str]:
    return [_row(header), _row(["---"] * len(header)), *[_row(r) for r in rows]]


def _blocks(seeds: list[dict], ex: str, split: str) -> list[dict]:
    return [m["exercises"][ex][split] for m in seeds if ex in m.get("exercises", {}) and m["exercises"][ex].get(split)]


# ---------------------------------------------------------------- 규칙 판정 부가 지표(R10)
def rules_judged_only(output: dict) -> dict:
    """규칙 출력(rules/output.json)에서 판정 못 한 반복 수와 '판정한 반복만'의 지표.

    정답은 own.lite_label/video_label(파일 이름·반복 번호만으로 정해지는 순수 함수)로 다시 붙인다 — 개인 녹화를 열지 않는다.
    출력에서 쓰는 필드는 file, index, kneeIn, shallow, skipped뿐이다.
    """
    from wom_ml.sources import own  # 순수 라벨 함수만 쓴다

    yt, yp = [], []
    by_file, by_reason = {}, {}
    for s in output["sets"]:
        f = s["file"]
        bf = by_file.setdefault(f, {"n": 0, "skipped": 0})
        for r in s["reps"]:
            bf["n"] += 1
            if r.get("skipped"):
                bf["skipped"] += 1
                by_reason[r["skipped"]] = by_reason.get(r["skipped"], 0) + 1
                continue
            lab, _ = own.video_label(r["index"]) if f == own.VIDEO_FILE else own.lite_label(f, r["index"])
            yt.append([lab[c] for c in RULE_COLUMNS])
            yp.append([int(r[c]) for c in RULE_COLUMNS])
    yt = np.asarray(yt, dtype=np.int8).reshape(-1, len(RULE_COLUMNS))
    yp = np.asarray(yp, dtype=np.int8).reshape(-1, len(RULE_COLUMNS))
    n_skip = sum(v["skipped"] for v in by_file.values())
    return {"n_judged": int(len(yt)), "n_skipped": n_skip, "skipped_by_file": by_file, "skipped_by_reason": by_reason,
            "per_error": mt.per_error(yt, yp, list(RULE_COLUMNS)), "app_style": mt.app_style(yt, yp, list(RULE_COLUMNS))}


# ---------------------------------------------------------------- 표
def _table_own(runs: Path, status: dict) -> list[str]:
    out = ["## 표 1. 스쿼트 — 본인 녹화(test_own, 평가 전용)", "",
           "앱이 지적하는 두 오류(kneeIn 무릎 모임, shallow 깊이 부족)의 F1과, 사용자가 느끼는 방식의 두 수치.",
           "모델 행은 시드 3개의 평균±표준편차(괄호는 시드별 개수). '모든 칸'은 모델이 feetWide·trunkLean까지 지적한 경우도 오탐으로 센 값"
           "(본인 녹화에는 그 오류가 없으므로 잘못 지적하지 않는지만 본다).", ""]
    header = ["방법", "kneeIn F1", "shallow F1", "일부러 만든 오류 잡음", "오류 없는 반복 잘못 지적", "잘못 지적(모든 칸)"]
    rows = []
    rp = Path(runs) / "rules" / "metrics.json"
    if rp.is_file():
        r = _read(rp)
        rows.append([STAGE_NAMES["rules"], f"{r['per_error']['kneeIn']['f1']:.2f}", f"{r['per_error']['shallow']['f1']:.2f}",
                     _count(r["app_style"], "caught"), _count(r["app_style"], "flagged"), "— (규칙은 두 칸만 판정)"])
    else:
        rows.append([STAGE_NAMES["rules"], NOT_RUN, "", "", "", ""])
    for st in SQUAT_STAGES:
        b = _blocks(load_seeds(runs, st), "squat", "test_own")
        if not b:
            rows.append([STAGE_NAMES[st], _missing(st, status), "", "", "", ""])
            continue
        rows.append([STAGE_NAMES[st], _f1(b, "kneeIn"), _f1(b, "shallow"),
                     _app_seeds(b, "app_style_rule_columns", "caught"), _app_seeds(b, "app_style_rule_columns", "flagged"),
                     _app_seeds(b, "app_style", "flagged")])
    return out + _table(header, rows)


def _table_rules_extra(runs: Path) -> list[str]:
    op = Path(runs) / "rules" / "output.json"
    if not op.is_file():
        return []
    j = rules_judged_only(_read(op))
    total = j["n_judged"] + j["n_skipped"]
    out = ["", "### 표 1-1. 규칙 판정이 판정하지 못한 반복(R10)", "",
           f"앱 규칙은 {total}회 중 **{j['n_skipped']}회를 판정하지 못했다**(이유: "
           + ", ".join(f"{SKIP_NAMES.get(k, k)} {v}회" for k, v in sorted(j["skipped_by_reason"].items())) + "). "
           "표 1의 규칙 행은 앱이 실제로 하는 것처럼 이 반복을 '지적 안 함(놓침)'으로 센 값이다. "
           "아래는 녹화별 판정 못 한 수와, 판정한 반복만 남겨 다시 센 값(규칙에 유리한 비교).", ""]
    rows = [[VIEW_NAMES.get(f, f), v["n"], v["skipped"]] for f, v in j["skipped_by_file"].items()]
    out += _table(["녹화", "반복 수", "판정 못 함"], rows)
    pe, a = j["per_error"], j["app_style"]
    out += ["", *_table(["규칙 판정, 판정한 반복만", "반복 수", "kneeIn F1", "shallow F1", "일부러 만든 오류 잡음",
                          "오류 없는 반복 잘못 지적"],
                         [["판정한 반복만", j["n_judged"], f"{pe['kneeIn']['f1']:.2f}", f"{pe['shallow']['f1']:.2f}",
                           _count(a, "caught"), _count(a, "flagged")]])]
    return out


def _lp_rows(runs: Path, status: dict, ex: str) -> list[list]:
    cols = HEAD_LABELS[ex]
    rows = [[STAGE_NAMES["rules"], "— (규칙 판정은 EC3D에 돌리지 않음)", *[""] * (len(cols) + 1)]]
    stages = SQUAT_STAGES if ex == "squat" else LP_STAGES
    for st in stages:
        b = _blocks(load_seeds(runs, st), ex, "test_ec3d")
        if not b:
            rows.append([STAGE_NAMES[st], _missing(st, status), *[""] * (len(cols) + 1)])
            continue
        rows.append([STAGE_NAMES[st], *[_f1(b, c) for c in cols], _app_seeds(b, "app_style", "caught"),
                     _app_seeds(b, "app_style", "flagged")])
    return rows


def _table_ec3d(runs: Path, status: dict, ds: dict | None) -> list[str]:
    reps = ((ds or {}).get("splits", {}).get("test_ec3d", {}) or {})
    n_reps = sum(reps.get("reps", {}).values()) if reps else None
    out = ["", "## 표 2. EC3D 피험자 4(test_ec3d, 학습에 안 쓴 사람)", "",
           "EC3D는 3D 좌표라 가상 카메라 5방향(0·30·45·60·90°)으로 2D에 투영해 평가한다. "
           + (f"샘플 {reps.get('samples')}개는 **독립된 반복 {n_reps}개 × 5방향**이다"
              f"(같은 반복을 다른 각도에서 본 것이므로, 실제로 서로 다른 반복은 {n_reps}개뿐). " if n_reps else "")
           + "아래는 5방향 전체를 합친 값. 일부러 만든 오류 잡음/오류 없는 반복 잘못 지적은 그 운동의 모든 오류 칸 기준.", ""]
    for ex, title in (("squat", "스쿼트"), ("lunge", "런지"), ("plank", "플랭크")):
        cols = HEAD_LABELS[ex]
        out += [f"### 표 2-{'123'[['squat', 'lunge', 'plank'].index(ex)]}. {title}", ""]
        out += _table(["방법", *[f"{c} F1" for c in cols], "오류 잡음", "오류 없는데 지적"], _lp_rows(runs, status, ex))
        out.append("")
    out += ["### 표 2-4. 투영 방향(yaw)별", "",
            "칸 = 그 운동 오류 칸들의 평균 F1(시드 평균±표준편차) / 오류 없는 반복을 잘못 지적한 비율(시드 평균). "
            "앱 촬영 조건은 45°에 가깝다. 방향마다 반복 수가 작아(스쿼트 약 30개) 칸 사이 차이는 크게 믿지 말 것.", ""]
    rows = []
    for ex, title in (("squat", "스쿼트"), ("lunge", "런지"), ("plank", "플랭크")):
        stages = SQUAT_STAGES if ex == "squat" else LP_STAGES
        for st in stages:
            b = _blocks(load_seeds(runs, st), ex, "test_ec3d")
            if not b:
                rows.append([title, STAGE_NAMES[st], _missing(st, status), *[""] * (len(YAWS) - 1)])
                continue
            cells = []
            for y in YAWS:
                yb = [x["by_yaw"][y] for x in b if y in x.get("by_yaw", {})]
                if not yb:
                    cells.append("—")
                    continue
                macro = [float(np.mean([v["per_error"][c]["f1"] for c in HEAD_LABELS[ex]])) for v in yb]
                flag = float(np.mean([v["app_style"]["clean_flagged_rate"] for v in yb]))
                cells.append(f"{fmt_ms(macro)} / {flag * 100:.0f}%")
            rows.append([title, STAGE_NAMES[st], *cells])
    out += _table(["운동", "방법", *[f"{y}°" for y in YAWS]], rows)
    return out


def _table_data(ds: dict | None) -> list[str]:
    out = ["", "## 데이터 개수(소스·분할별)", ""]
    if not ds:
        return out + ["(`python -m wom_ml.dataset --summary`를 먼저 실행)"]
    names = {"train": "학습(train)", "val": "검증(val, 조기 종료용)", "test_ec3d": "평가: EC3D 피험자 4",
             "test_own": "평가: 본인 녹화"}
    rows = []
    for sp, v in ds.get("splits", {}).items():
        for k, n in sorted(v.get("reps", {}).items()):
            rows.append([names.get(sp, sp), k, n, ""])
        rows.append([names.get(sp, sp), "**합계**", sum(v.get("reps", {}).values()), v.get("samples", "")])
    out += ["반복 수 = 서로 다른 반복. 샘플 수 = 모델이 실제로 본 개수(EC3D는 5방향 투영, train은 좌우 반전·증강 포함).", ""]
    out += _table(["분할", "소스/운동", "반복 수", "샘플 수"], rows)
    lab_rows = []
    for sp, v in ds.get("splits", {}).items():
        for ex, lab in v.get("labels", {}).items():
            cols = ", ".join(f"{c} {lab.get(c, 0)}" for c in HEAD_LABELS[ex])
            lab_rows.append([names.get(sp, sp), ex, lab.get("n", ""), lab.get("none", ""), cols])
    if lab_rows:
        out += ["", "오류별 반복 수(한 반복에 오류는 하나):", ""]
        out += _table(["분할", "운동", "반복", "오류 없음", "오류별"], lab_rows)
    extra = []
    if ds.get("own_excluded"):
        extra.append("본인 녹화에서 뺀 것: " + ", ".join(f"{VIEW_NAMES.get(k, k)} — {v}" for k, v in ds["own_excluded"].items()))
    if ds.get("ec3d_excluded"):
        extra.append("EC3D에서 뺀 것: " + ", ".join(f"{k} {v}개(논문 표에 없는 클래스)" for k, v in ds["ec3d_excluded"].items()))
    if ds.get("zenodo_duplicates_removed") is not None:
        extra.append(f"Zenodo 중복 사본 제거: {ds['zenodo_duplicates_removed']}개")
    if extra:
        out += [""] + [f"- {e}" for e in extra]
    return out


def _table_stages(runs: Path, status: dict) -> list[str]:
    out = ["", "## 단계 실행 상태", ""]
    rows = []
    for st in STAGE_NAMES:
        info = status.get(st) or {}
        if st == "rules":
            done = (Path(runs) / "rules" / "metrics.json").is_file()
            rows.append([STAGE_NAMES[st], "끝남" if done else NOT_RUN, "—", "—", "—", "—", info.get("seconds", "")])
            continue
        seeds = load_seeds(runs, st)
        if not seeds:
            rows.append([STAGE_NAMES[st], _missing(st, status), "", "", "", "", ""])
            continue
        batches = sorted({m.get("batch_size") for m in seeds}, key=str)
        lrs = sorted({m.get("lr") for m in seeds}, key=str)
        ep = []
        for m in seeds:
            exs = m.get("exercises", {})
            ex = "squat" if "squat" in exs else next(iter(exs), None)
            ti = (exs.get(ex) or {}).get("train_info", {}) if ex else {}
            ep.append(f"{ti.get('best_epoch', '?')}" + ("" if ti.get("stopped_by") != "fixed_epochs" else "(고정)"))
        rows.append([STAGE_NAMES[st], "끝남", ", ".join(str(m.get("seed")) for m in seeds),
                     ", ".join(str(b) for b in batches), ", ".join(str(x) for x in lrs), ", ".join(ep),
                     info.get("seconds_total", "")])
    out += _table(["단계", "상태", "시드", "배치", "학습률", "고른 epoch(시드별)", "시간(초)"], rows)
    out += ["", "고른 epoch: 스쿼트가 있는 단계는 스쿼트 val 손실로 조기 종료한 epoch, 런지·플랭크만 있는 단계는 고정 epoch."]
    return out


def render_report(runs: Path) -> str:
    """runs 폴더의 집계 결과 → 마크다운(표 부분)."""
    runs = Path(runs)
    status = _status(runs)
    dsp = runs / "dataset_summary.json"
    ds = _read(dsp) if dsp.is_file() else None
    lines = ["> 이 절은 `ml/runs/`의 집계 결과로 자동 생성된다. MotionBERT 단계에 결과가 없으면 "
             f"'{PENDING}'으로 표시하고, 가중치를 넣고 `run_all` → `report`를 다시 돌리면 채워진다.", ""]
    lines += _table_own(runs, status)
    lines += _table_rules_extra(runs)
    lines += _table_ec3d(runs, status, ds)
    lines += _table_data(ds)
    lines += _table_stages(runs, status)
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- 보고서 파일
def update_doc(doc: str | None, generated: str) -> str:
    """START~END 사이를 generated로 바꾼다. doc이 None이면 새 틀. 표식이 없으면 ValueError(사람 글을 덮지 않게)."""
    block = f"{START}\n\n{generated.strip()}\n\n{END}"
    if doc is None:
        return f"# 파인튜닝 실험 결과\n\n{block}\n\n## 해석\n\n(사람이 쓴다)\n"
    i, j = doc.find(START), doc.find(END)
    if i < 0 or j < 0 or j < i:
        raise ValueError("보고서에 자동 생성 표식(START/END)이 없음 — 사람 글을 덮지 않으려고 멈춤")
    return doc[:i] + block + doc[j + len(END):]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="실험 결과 보고서 표 생성")
    ap.add_argument("--runs", type=Path, default=paths.RUNS)
    ap.add_argument("--doc", type=Path, default=DOC)
    ap.add_argument("--stdout", action="store_true", help="파일을 고치지 않고 화면에만")
    a = ap.parse_args(argv)
    gen = render_report(a.runs)
    sys.stdout.reconfigure(encoding="utf-8")  # 윈도우 콘솔(cp949)에서 한글이 깨지지 않게
    if a.stdout:
        print(gen)
        return 0
    old = a.doc.read_text(encoding="utf8") if a.doc.is_file() else None
    a.doc.write_text(update_doc(old, gen), encoding="utf8")
    print(f"갱신: {a.doc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

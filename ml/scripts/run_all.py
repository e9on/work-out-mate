"""단계별 실험 실행: rules → small → mb_probe → mb_partial → mb_full → mb_full_lunge_plank.

설정은 configs/experiments.yaml. 실행(저장소 루트에서): python ml/scripts/run_all.py [--dry-run] [--stages ...]
결과(git 제외, 집계 지표만):
  runs/rules/metrics.json
  runs/<stage>/seed<k>/<운동>/{model.pt, val_metrics.json, metrics.json}
  runs/<stage>/seed<k>/metrics.json(운동별 최종 지표 + 시작점·사전학습 로드·시간·VRAM), done.json(끝 표시)
  runs/<stage>/summary.json(시드 평균·편차), runs/run_all_status.json(단계 상태)

평가 오염 방지(R9·R15)
- 모든 학습 단계는 train 분할로 학습하고, 조기 종료·체크포인트 선택은 val(스쿼트)로만, val이 없는 런지·플랭크는
  고정 epoch. 설정이 test_ec3d·test_own을 학습·선택에 쓰면 validate가 ValueError.
- train_model에는 {"train", "val"}만 넘긴다. test 분할은 학습이 끝난 뒤 final_eval에만 넘기고 결과는 파일에만.
  터미널에는 val 지표만 찍는다.

이어받기: partial은 probe(시드별) 체크포인트, full은 partial, mb_full_lunge_plank는 mb_full에서 시작.
이미 끝난 단계·시드(done.json 있음)는 건너뛴다.

가중치(R18): ml/weights/motionbert_lite.bin이 없으면 mb_* 단계는 무작위 몸통으로 돌지 않고 받는 법을 출력한 뒤
'skipped_no_weights'로 기록하고 종료 코드 2로 끝난다(rules·small 결과는 남는다). 가중치를 넣고 같은 명령을
다시 실행하면 끝난 단계는 건너뛰고 mb_*만 이어 돈다.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wom_ml import train as tr  # noqa: E402  (CUBLAS 환경변수를 torch보다 먼저 정한다)
import torch  # noqa: E402
import yaml  # noqa: E402

from wom_ml import paths  # noqa: E402
from wom_ml.sources import HEAD_LABELS  # noqa: E402

CONFIG = paths.ML_ROOT / "configs" / "experiments.yaml"
STAGES = ("rules", "small", "mb_probe", "mb_partial", "mb_full", "mb_full_lunge_plank")
TEST_SPLITS = ("test_ec3d", "test_own")
BATCH_CAP = {"full": 16, "partial": 32}  # R17(task-7-report VRAM 측정: full 16=6.41GB, partial 32=5.18GB)
BODY_LR_RATIO = 0.1                      # 설계 ③: full 몸통 = 머리 × 0.1
ORIG_HEAD_KEYS = {"head.weight", "head.bias"}  # 업스트림 3D 출력 머리(버리는 키)
FROM_PROBE = "from_mb_probe"
EXIT_NO_WEIGHTS = 2


# ---------------------------------------------------------------- 설정
def load_config(path: Path) -> dict:
    cfg = yaml.safe_load(Path(path).read_text(encoding="utf8"))
    validate(cfg)
    return cfg


def validate(cfg: dict) -> None:
    """설정 검사. 문제가 있으면 ValueError."""
    stages = cfg.get("stages", {})
    if set(stages) != set(STAGES):
        raise ValueError(f"stages는 정확히 {STAGES}: {sorted(stages)}")
    for i, name in enumerate(STAGES):
        s = stages[name]
        kind = s.get("kind")
        if kind not in ("rules", "small", "mb"):
            raise ValueError(f"{name}: kind는 rules/small/mb")
        if kind == "rules":
            continue
        split = s.get("train_split", "train")
        if split != "train":  # test_* 는 물론 val로도 학습하지 않는다
            raise ValueError(f"{name}: 학습 분할은 train만 가능(받은 값 {split})")
        exs = s.get("exercises") or []
        if not exs or any(ex not in HEAD_LABELS for ex in exs):
            raise ValueError(f"{name}: exercises가 비었거나 모르는 운동: {exs}")
        for ex in exs:
            sel = (s.get("select") or {}).get(ex)
            if sel not in ("val", "fixed"):  # test_ec3d·test_own으로 고르는 것 금지(R9)
                raise ValueError(f"{name}/{ex}: select는 val 또는 fixed(받은 값 {sel})")
            if sel == "fixed":
                v = (s.get("fixed_epochs") or {}).get(ex)
                if not (v == FROM_PROBE or (isinstance(v, int) and v > 0)):
                    raise ValueError(f"{name}/{ex}: fixed_epochs는 양의 정수 또는 {FROM_PROBE}")
                if v == FROM_PROBE and (stages["mb_probe"].get("select") or {}).get("squat") != "val":
                    raise ValueError(f"{name}/{ex}: {FROM_PROBE}는 mb_probe 스쿼트가 val로 조기 종료해야 함")
        if not (s.get("lr", 0) > 0 and isinstance(s.get("batch_size"), int) and s["batch_size"] > 0):
            raise ValueError(f"{name}: lr·batch_size가 필요")
        if kind == "small":
            continue
        fr = s.get("freeze")
        if fr not in ("probe", "partial", "full"):
            raise ValueError(f"{name}: freeze는 probe/partial/full")
        if fr in BATCH_CAP and s["batch_size"] > BATCH_CAP[fr]:
            raise ValueError(f"{name}: {fr} 배치는 {BATCH_CAP[fr]} 이하(R17, 받은 값 {s['batch_size']})")
        if fr == "full" and s.get("body_lr_ratio") != BODY_LR_RATIO:
            raise ValueError(f"{name}: full은 body_lr_ratio {BODY_LR_RATIO}가 필요(몸통 = 머리의 1/10)")
        init = s.get("init_from")
        if init is not None:
            if init not in STAGES[:i] or stages[init].get("kind") != "mb":
                raise ValueError(f"{name}: init_from은 앞선 mb 단계여야 함(받은 값 {init})")


def plan(cfg: dict, stages=None) -> list[dict]:
    """단계별로 무엇을 어떤 분할로 학습·선택·평가하는지. dry-run 출력과 실제 실행이 같이 쓴다."""
    out = []
    for name in STAGES:
        if stages is not None and name not in stages:
            continue
        s = cfg["stages"][name]
        p = {"stage": name, "kind": s["kind"], "freeze": s.get("freeze"), "init_from": s.get("init_from"),
             "needs_weights": s["kind"] == "mb", "seeds": None if s["kind"] == "rules" else list(cfg["seeds"])}
        if s["kind"] == "rules":
            p["exercises"] = [{"exercise": "squat", "train": None, "select": None, "fixed_epochs": None,
                               "eval": ["test_own"]}]
        else:
            p["exercises"] = [{"exercise": ex, "train": s.get("train_split", "train"), "select": s["select"][ex],
                               "fixed_epochs": (s.get("fixed_epochs") or {}).get(ex)
                               if s["select"][ex] == "fixed" else None,
                               "eval": ["val", *TEST_SPLITS]} for ex in s["exercises"]]
        out.append(p)
    return out


# ---------------------------------------------------------------- 모델·검사
def make_model(scfg: dict, heads: dict, weights: Path | None):
    if scfg["kind"] == "small":
        from wom_ml.models.small import SmallGRU
        return SmallGRU(heads, hidden=scfg.get("hidden", 128))
    from wom_ml.models.motionbert import MotionBertClassifier
    if weights is None or not Path(weights).is_file():  # 무작위 몸통(weights=None)으로 실험하지 않는다
        raise FileNotFoundError(f"MotionBERT 가중치 없음: {weights}")
    return MotionBertClassifier(heads, Path(weights), scfg["freeze"], partial_blocks=scfg.get("partial_blocks", 2))


def check_pretrained(model) -> dict:
    """사전학습 가중치가 실제로 몸통에 들어갔는지 단언. 기록용 dict 반환."""
    rep = getattr(model, "load_report", None)
    if rep is None:
        raise RuntimeError("사전학습 가중치가 로드되지 않음(load_report 없음) — 무작위 몸통으로 실험하지 않는다")
    if rep.get("missing"):
        raise RuntimeError(f"몸통 키 누락 {len(rep['missing'])}개")
    extra = set(rep.get("unexpected", [])) - ORIG_HEAD_KEYS
    if extra:
        raise RuntimeError(f"예상 밖 체크포인트 키: {sorted(extra)[:10]}")
    return {"loaded": True, "missing": 0, "unexpected": sorted(rep.get("unexpected", []))}


def check_param_groups(model, tcfg: dict, body_lr_ratio: float | None) -> None:
    """full 모드는 cfg["param_groups"]로 몸통 학습률 = 머리 × body_lr_ratio가 실제로 들어가야 한다."""
    if getattr(model, "freeze", None) != "full":
        return
    fn = tcfg.get("param_groups")
    if not callable(fn) or body_lr_ratio is None:
        raise ValueError("full 모드는 param_groups(몸통 lr = 머리 × 0.1)가 필요")
    head_ids = {id(p) for p in model.heads.parameters()}
    body_lrs = [g["lr"] for g in fn(model) if any(id(p) not in head_ids for p in g["params"])]
    want = tcfg["lr"] * body_lr_ratio
    if not body_lrs or any(not math.isclose(lr, want, rel_tol=1e-9) for lr in body_lrs):
        raise ValueError(f"full 몸통 학습률이 {want}가 아님: {body_lrs}")


def train_cfg(cfg: dict, scfg: dict, ex: str, fixed: dict) -> dict:
    t = {**tr.DEFAULT_CFG, **(cfg.get("common") or {}), "exercise": ex, "lr": scfg["lr"],
         "batch_size": scfg["batch_size"], "fixed_epochs": {**tr.DEFAULT_CFG["fixed_epochs"], **fixed}}
    if cfg.get("device"):
        t["device"] = cfg["device"]
    for k in ("weight_decay", "max_epochs", "patience", "min_delta", "pos_weight"):
        if k in scfg:
            t[k] = scfg[k]
    lr = scfg["lr"]
    if scfg["kind"] == "mb":
        if scfg["freeze"] == "probe":  # 그 운동 머리만 학습(다른 머리·몸통은 그대로)
            t["param_groups"] = lambda m, ex=ex, lr=lr: [{"params": list(m.heads[ex].parameters()), "lr": lr}]
        else:  # partial: 몸통 = 머리 lr(R16), full: 몸통 = 머리 × 0.1(MotionBertClassifier.param_groups)
            t["param_groups"] = lambda m, lr=lr: m.param_groups(lr)
    return t


# ---------------------------------------------------------------- 실행 보조
def load_data(cfg: dict) -> dict:
    return tr.build_data(cfg.get("data_seed", 0))


def _load_rules_baseline():
    spec = importlib.util.spec_from_file_location("wom_rules_baseline", Path(__file__).with_name("rules_baseline.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_rules(runs: Path) -> None:
    """rules_baseline과 같은 계산. 지표는 터미널에 찍지 않고 파일에만(R15)."""
    rb = _load_rules_baseline()
    d = runs / "rules"
    d.mkdir(parents=True, exist_ok=True)
    reps = rb.own_src.load_own(paths.PRIVATE_OWN)
    inp, out = d / "input.json", d / "output.json"
    inp.write_text(json.dumps({"sets": rb.own_src.raw_sets(paths.PRIVATE_OWN)}), encoding="utf8")
    rb.run_node(inp, out)
    res = rb.make_metrics(reps, json.loads(out.read_text(encoding="utf8")))
    (d / "metrics.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf8")


def _file_info(p: Path) -> dict:
    h = hashlib.sha256(p.read_bytes()).hexdigest()
    return {"path": str(p), "bytes": p.stat().st_size, "sha256": h}


def _write(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf8")


def _read(p: Path):
    return json.loads(Path(p).read_text(encoding="utf8"))


def _is_cuda(cfg: dict) -> bool:
    return torch.cuda.is_available() and str(cfg.get("device", tr.DEFAULT_CFG["device"])).startswith("cuda")


def resolve_fixed(scfg: dict, runs: Path, seeds) -> dict:
    """고정 epoch 값을 정수로. from_mb_probe = mb_probe 스쿼트 val 최적 epoch의 시드 최대값(val만 근거)."""
    out = {}
    for ex in scfg["exercises"]:
        if scfg["select"][ex] != "fixed":
            continue
        v = scfg["fixed_epochs"][ex]
        if v == FROM_PROBE:
            bests = []
            for s in seeds:
                f = runs / "mb_probe" / f"seed{s}" / "squat" / "val_metrics.json"
                if not f.exists():
                    raise FileNotFoundError(f"고정 epoch을 정할 mb_probe 결과가 없음: {f}")
                bests.append(int(_read(f)["train_info"]["best_epoch"]))
            v = max(1, max(bests))
        out[ex] = int(v)
    return out


def _val_line(stage, seed, ex, r) -> str:
    i, v = r["train_info"], r["val"]
    line = f"[{stage}] seed {seed} {ex}: epochs {i['epochs_run']} best {i['best_epoch']} ({i['stopped_by']}, {i['seconds']}s)"
    if v is not None:
        line += f" | val loss {v['loss']:.4f} F1 " + " ".join(f"{c}={m['f1']:.3f}" for c, m in v["per_error"].items())
    return line


def run_seed(name: str, cfg: dict, seed: int, data: dict, runs: Path, weights: Path, wfile: dict | None) -> dict:
    """한 단계·한 시드. 운동별로 학습(train·val만) → final_eval(test는 파일에만). 반환은 done 정보."""
    scfg = cfg["stages"][name]
    out = runs / name / f"seed{seed}"
    heads = {ex: len(c) for ex, c in HEAD_LABELS.items()}
    fixed = resolve_fixed(scfg, runs, cfg["seeds"])
    cuda = _is_cuda(cfg)
    if cuda:
        torch.cuda.reset_peak_memory_stats()
    t0 = time.time()
    rec = {"stage": name, "seed": seed, "kind": scfg["kind"], "freeze": scfg.get("freeze"), "lr": scfg["lr"],
           "batch_size": scfg["batch_size"], "fixed_epochs": fixed, "init_from": None, "exercises": {}}
    if scfg.get("freeze") == "full":
        rec["body_lr"] = scfg["lr"] * scfg["body_lr_ratio"]
    model = None
    for ex in scfg["exercises"]:
        if scfg["kind"] == "small" or model is None:  # 방식 A는 운동마다 처음부터, mb는 한 모델을 이어서
            tr.set_seed(seed)
            model = make_model(scfg, heads, weights)
            if scfg["kind"] == "mb":
                rec["pretrained"] = check_pretrained(model)
                rec["weights"] = wfile
            if scfg.get("init_from"):
                prev = cfg["stages"][scfg["init_from"]]
                src = runs / scfg["init_from"] / f"seed{seed}" / prev["exercises"][-1] / "model.pt"
                if not src.exists():
                    raise FileNotFoundError(f"{name} seed{seed}가 시작할 체크포인트가 없음: {src}")
                model.load_state_dict(torch.load(src, map_location="cpu", weights_only=True))
                rec["init_from"] = str(src)
        tcfg = train_cfg(cfg, scfg, ex, fixed)
        check_param_groups(model, tcfg, scfg.get("body_lr_ratio"))
        # 학습에는 train·val만. val은 조기 종료 운동(스쿼트)에만, 고정 epoch 운동은 None(R9)
        tdata = {"train": data[scfg.get("train_split", "train")],
                 "val": data["val"] if scfg["select"][ex] == "val" else None}
        r = tr.train_model(model, tdata, tcfg, seed, out / ex)
        path = tr.final_eval(model, {k: data[k] for k in TEST_SPLITS}, tcfg, r, out / ex)
        rec["exercises"][ex] = _read(path)
        print(_val_line(name, seed, ex, r), flush=True)  # 터미널에는 val만(R15)
    rec["seconds"] = round(time.time() - t0, 1)
    rec["vram"] = ({"peak_allocated_gib": round(torch.cuda.max_memory_allocated() / 2**30, 2),
                    "peak_reserved_gib": round(torch.cuda.max_memory_reserved() / 2**30, 2)} if cuda else None)
    _write(out / "metrics.json", rec)
    done = {"stage": name, "seed": seed, "seconds": rec["seconds"], "vram": rec["vram"]}
    _write(out / "done.json", done)  # 마지막에 쓴다: 이게 있으면 끝난 것
    return done


def summarize_stage(name: str, cfg: dict, runs: Path) -> Path:
    scfg = cfg["stages"][name]
    s = {}
    for ex in scfg["exercises"]:
        s[ex] = tr.summarize([_read(runs / name / f"seed{k}" / ex / "metrics.json") for k in cfg["seeds"]])
    p = runs / name / "summary.json"
    _write(p, s)
    return p


# ---------------------------------------------------------------- 진입점
def _print_plan(cfg, stages, runs, weights) -> None:
    print(f"설정 시드 {cfg['seeds']}, 가중치 {weights} ({'있음' if weights.is_file() else '없음'})")
    for p in plan(cfg, stages):
        name = p["stage"]
        if p["kind"] == "rules":
            st = "완료" if (runs / name / "done.json").exists() else "미완료"
            print(f"[{name}] 규칙 판정(학습 없음) 상태: {st}")
        else:
            done = sum((runs / name / f"seed{k}" / "done.json").exists() for k in p["seeds"])
            init = f"{p['init_from']}/seed<k> 체크포인트" if p["init_from"] else "처음(사전학습 가중치)" \
                if p["kind"] == "mb" else "처음(무작위 초기화)"
            fr = f" freeze={p['freeze']}" if p["freeze"] else ""
            print(f"[{name}] kind={p['kind']}{fr} 시드 {p['seeds']} 시작: {init} 상태: 완료 {done}/{len(p['seeds'])}")
        for e in p["exercises"]:
            if e["train"] is None:
                print(f"  {e['exercise']}: 학습 없음 | 평가: {', '.join(e['eval'])}")
                continue
            fe = e["fixed_epochs"]
            if fe == FROM_PROBE:
                fe = "= mb_probe 스쿼트 val 최적 epoch의 시드 최대값, 실행 때 계산"
            sel = "선택: val 조기 종료" if e["select"] == "val" else f"선택: 없음(고정 epoch {fe})"
            print(f"  {e['exercise']}: 학습: {e['train']} | {sel} | 최종 평가(학습 뒤 한 번, 파일에만): "
                  f"{', '.join(e['eval'])}")


def _no_weights_message(weights: Path) -> str:
    from wom_ml.models.motionbert import _missing_weights_message
    return (_missing_weights_message(weights) + "\n가중치를 넣은 뒤 같은 명령을 다시 실행하면 끝난 단계는 건너뛰고 "
            "mb_* 단계만 이어서 돈다.")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="단계별 파인튜닝 실험 실행")
    ap.add_argument("--config", type=Path, default=CONFIG)
    ap.add_argument("--runs", type=Path, default=paths.RUNS)
    ap.add_argument("--stages", nargs="+", choices=STAGES, default=list(STAGES))
    ap.add_argument("--seeds", type=int, nargs="+", default=None)
    ap.add_argument("--dry-run", action="store_true", help="단계와 각 단계가 읽는 분할만 출력")
    a = ap.parse_args(argv)

    cfg = load_config(a.config)
    if a.seeds is not None:
        cfg["seeds"] = a.seeds
    weights = Path(cfg["weights"])
    weights = weights if weights.is_absolute() else paths.ML_ROOT / weights
    stages = [s for s in STAGES if s in a.stages]
    if a.dry_run:
        _print_plan(cfg, stages, a.runs, weights)
        return 0

    runs = a.runs
    runs.mkdir(parents=True, exist_ok=True)
    status_path = runs / "run_all_status.json"
    status = _read(status_path) if status_path.exists() else {}
    if _is_cuda(cfg):
        torch.cuda.set_per_process_memory_fraction(float(cfg.get("vram_fraction", 0.9)))  # R17
    data, wfile, code, warned = None, None, 0, False
    for name in stages:
        scfg = cfg["stages"][name]
        if scfg["kind"] == "rules":
            if (runs / "rules" / "done.json").exists():
                print("[rules] 이미 끝남 — 건너뜀")
            else:
                t0 = time.time()
                run_rules(runs)
                _write(runs / "rules" / "done.json", {"stage": "rules", "seconds": round(time.time() - t0, 1)})
                print(f"[rules] 규칙 판정 끝, 지표는 파일에만: {runs / 'rules' / 'metrics.json'}")
            status["rules"] = {"status": "done", **_read(runs / "rules" / "done.json")}
            _write(status_path, status)
            continue
        todo = [k for k in cfg["seeds"] if not (runs / name / f"seed{k}" / "done.json").exists()]
        if todo and scfg["kind"] == "mb" and not weights.is_file():
            if not warned:
                print(_no_weights_message(weights))
                warned = True
            print(f"[{name}] 가중치 없음으로 건너뜀")
            status[name] = {"status": "skipped_no_weights"}
            _write(status_path, status)
            code = EXIT_NO_WEIGHTS
            continue
        seeds_info = {}
        for k in cfg["seeds"]:
            done_p = runs / name / f"seed{k}" / "done.json"
            if done_p.exists():
                print(f"[{name}] seed {k} 이미 끝남 — 건너뜀")
            else:
                if data is None:
                    data = load_data(cfg)
                if scfg["kind"] == "mb" and wfile is None:
                    wfile = _file_info(weights)
                run_seed(name, cfg, k, data, runs, weights, wfile)
            seeds_info[str(k)] = _read(done_p)
        summ = summarize_stage(name, cfg, runs)
        print(f"[{name}] 요약 저장(시드 평균·편차, 평가 지표는 파일에만): {summ}")
        status[name] = {"status": "done", "seeds": seeds_info,
                        "seconds_total": round(sum(v["seconds"] for v in seeds_info.values()), 1),
                        "vram_peak_allocated_gib": max([v["vram"]["peak_allocated_gib"] for v in seeds_info.values()
                                                        if v.get("vram")] or [None], key=lambda x: x or 0)}
        _write(status_path, status)
    return code


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # Windows 콘솔(cp949)에서 한국어가 깨지지 않게
    sys.exit(main())

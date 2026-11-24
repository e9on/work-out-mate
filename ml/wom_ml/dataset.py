"""반복 샘플 → 분할 → 모델 입력 배열(정규화·증강).

흐름: 소스별 load_* → split → build_arrays.

평가 오염 방지(가장 중요)
- 본인 녹화(source="own")는 test_own에만, EC3D 피험자 "4"는 test_ec3d에만 간다.
- EC3D 피험자 1~3은 train(브리프). Zenodo는 사람(pNN) 단위로 80/20 train/val(시드 고정).
- check_split이 결과를 다시 검사해, 시험용이 train/val에 하나라도 있거나 같은 사람이 train과 val에
  걸치면 ValueError.

모델 입력 정규화(컨트롤러 R5): MotionBERT 사전학습과 같은 crop_scale — 시퀀스 전체의 유효 관절
경계상자를 종횡비를 유지한 채 [-1,1]로 옮기고 conf는 그대로(`third_party/MotionBERT/lib/utils/utils_data.py`
의 crop_scale을 읽고 같은 계산으로 새로 작성). 다른 점 하나: conf 0인 관절은 좌표를 0으로 둔다.

증강(train만): EC3D yaw 5방향 투영, 반복 안 속도 변화(0.8~1.2), ±10° 평면 회전, 0.9~1.1 크기,
좌우 반전(정규화 뒤, FLIP_PAIRS 교환). 반전은 같은 증강 사본을 뒤집은 짝으로 넣는다(라벨 그대로 —
모든 오류 칸이 좌우 대칭인 개념이라 반전해도 라벨이 바뀌지 않는다).

실행: `python -m wom_ml.dataset --summary` (ml 폴더에서) — 개수·라벨 분포만 출력하고
`runs/dataset_summary.json`에 저장. 개인 녹화의 좌표·수치는 출력하지 않는다.
"""
from __future__ import annotations

import argparse
import collections
import json
from pathlib import Path

import numpy as np

from wom_ml import paths
from wom_ml import skeleton as sk
from wom_ml.sources import HEAD_LABELS, Rep, empty_labels, make_labels  # noqa: F401 (다시 내보냄)
from wom_ml.sources.ec3d import load_ec3d
from wom_ml.sources.own import load_own
from wom_ml.sources.zenodo import load_zenodo

__all__ = ["HEAD_LABELS", "Rep", "load_ec3d", "load_zenodo", "load_own", "resample", "crop_scale",
           "split", "check_split", "build_arrays"]

SPLITS = ("train", "val", "test_ec3d", "test_own")
EC3D_TEST_SUBJECT = "4"
EC3D_TRAIN_SUBJECTS = {"1", "2", "3"}
DEFAULT_YAWS = (0, 30, 45, 60, 90)


# ---------------------------------------------------------------- 시간 맞추기
def _resample_at(seq: np.ndarray, pos: np.ndarray) -> np.ndarray:
    """프레임 위치 pos(실수)에서 값을 뽑는다. 마지막 채널이 conf.

    이웃 두 프레임의 관절이 모두 유효하면 선형 보간, 하나라도 없으면 가까운 프레임 값을 그대로 쓴다
    (없는 관절의 좌표 0이 섞여 원점 쪽으로 끌려가지 않게).
    """
    F = len(seq)
    pos = np.clip(pos, 0, F - 1)
    i0 = np.floor(pos).astype(int)
    i1 = np.minimum(i0 + 1, F - 1)
    w = (pos - i0)[:, None, None]
    a, b = seq[i0], seq[i1]
    both = ((a[..., -1] > 0) & (b[..., -1] > 0))[..., None]
    lerp = a * (1 - w) + b * w
    near = np.where(w < 0.5, a, b)
    return np.where(both, lerp, near)


def resample(seq: np.ndarray, T: int = 64) -> np.ndarray | None:
    """(F,17,C) → (T,17,C). 프레임 3개 미만이면 None(반복으로 보기에 너무 짧음)."""
    seq = np.asarray(seq, dtype=np.float64)
    if len(seq) < 3:
        return None
    return _resample_at(seq, np.linspace(0, len(seq) - 1, T))


def _speed_positions(F: int, T: int, f: float) -> np.ndarray:
    """반복 앞 절반을 f배, 뒤 절반을 1/f배 빠르기로 재생하는 위치(끝점 고정).

    반복 전체를 일정하게 빠르게/느리게 하면 T로 다시 맞출 때 사라지므로 반복 안의 빠르기 비를 바꾼다.
    """
    d1, d2 = 0.5 / f, 0.5 * f
    k = d1 / (d1 + d2)  # 출력 시간에서 앞 절반이 끝나는 지점
    s = np.linspace(0, 1, T)
    u = np.where(s <= k, 0.5 * s / k, 0.5 + 0.5 * (s - k) / (1 - k))
    return u * (F - 1)


# ---------------------------------------------------------------- 정규화
def crop_scale(seq: np.ndarray, ratio: float = 1.0) -> np.ndarray:
    """(T,17,3) → 같은 모양. 시퀀스 전체 유효 관절의 경계상자 긴 변 × ratio를 [-1,1] 폭으로.

    MotionBERT crop_scale과 같은 계산: scale = max(가로, 세로) × ratio, 상자 가운데를 0으로, clip [-1,1].
    유효 관절이 4개 미만이거나 크기가 0이면 전부 0. conf는 그대로, conf 0 관절의 좌표는 0.
    """
    seq = np.asarray(seq, dtype=np.float64)
    c = seq[..., 2]
    ok = (c > 0) & np.isfinite(seq[..., :2]).all(-1)
    out = np.zeros_like(seq)
    v = seq[ok][:, :2]
    if len(v) < 4:
        return out
    (xmin, ymin), (xmax, ymax) = v.min(0), v.max(0)
    scale = max(xmax - xmin, ymax - ymin) * ratio
    if not np.isfinite(scale) or scale <= 0:
        return out
    corner = np.array([xmin + xmax - scale, ymin + ymax - scale]) / 2
    xy = ((seq[..., :2] - corner) / scale - 0.5) * 2
    xy = np.clip(xy, -1, 1)
    out[..., :2] = np.where(ok[..., None], xy, 0.0)
    out[..., 2] = np.where(ok, c, 0.0)
    return out


def _rotate(seq: np.ndarray, deg: float) -> np.ndarray:
    """유효 관절 경계상자 가운데를 축으로 이미지 평면 회전."""
    ok = seq[..., 2] > 0
    if not ok.any():
        return seq
    v = seq[ok][:, :2]
    ctr = (v.min(0) + v.max(0)) / 2
    t = np.deg2rad(deg)
    R = np.array([[np.cos(t), -np.sin(t)], [np.sin(t), np.cos(t)]])
    out = seq.copy()
    out[..., :2] = np.where(ok[..., None], (seq[..., :2] - ctr) @ R.T + ctr, 0.0)
    return out


# ---------------------------------------------------------------- conf 처리(R14)
def clip_conf(seq: np.ndarray) -> np.ndarray:
    """모델 입력 conf = clip(score, 0, 1). 모든 소스 공통(RTMPose score는 1을 넘을 수 있음).

    근거: MotionBERT 사전학습 입력의 conf는 [0,1] 범위이고, 소스마다 범위가 다르면 안 된다.
    잘라서 0이 된 관절은 무효로 보고 좌표도 0.
    """
    out = np.array(seq, dtype=np.float64, copy=True)
    out[..., -1] = np.clip(np.nan_to_num(out[..., -1], nan=0.0), 0.0, 1.0)
    out[..., :-1] = np.where((out[..., -1] > 0)[..., None], out[..., :-1], 0.0)
    return out


def fill_empty_frames(x: np.ndarray) -> np.ndarray:
    """(T,17,3) 정규화 뒤. 유효 관절이 하나도 없는 프레임의 좌표를 앞뒤 유효 프레임으로 선형 보간(conf 0).

    시퀀스 양끝의 빈 프레임은 가장 가까운 유효 프레임 좌표로 채운다. 유효 프레임이 없으면 그대로.
    (빈 프레임을 원점 (0,0)으로 남기면 소스마다 다른 '사람이 사라지는' 패턴이 입력에 생긴다.)
    """
    valid = (x[..., 2] > 0).any(axis=1)
    if valid.all() or not valid.any():
        return x
    out = x.copy()
    vi = np.flatnonzero(valid)
    for f in np.flatnonzero(~valid):
        nxt = vi[vi > f]
        prv = vi[vi < f]
        if len(prv) and len(nxt):
            a, b = prv[-1], nxt[0]
            w = (f - a) / (b - a)
            out[f, :, :2] = (1 - w) * x[a, :, :2] + w * x[b, :, :2]
        else:
            out[f, :, :2] = x[(prv[-1] if len(prv) else nxt[0]), :, :2]
        out[f, :, 2] = 0.0
    return out


def _jitter_conf(x: np.ndarray, rng) -> np.ndarray:
    """conf가 상수인 소스(EC3D, 0/1)용 train 증강: 유효 관절의 conf를 관절·프레임별 U(0.5,1)로."""
    out = x.copy()
    ok = out[..., 2] > 0
    out[..., 2] = np.where(ok, rng.uniform(0.5, 1.0, ok.shape), 0.0)
    return out


# ---------------------------------------------------------------- 분할
def _person(r: Rep) -> tuple[str, str]:
    return (r.source, r.subject)


def check_split(sp: dict[str, list[Rep]]) -> None:
    """평가 오염 검사. 어긋나면 ValueError."""
    if set(sp) != set(SPLITS):
        raise ValueError(f"분할 키가 다름: {sorted(sp)}")
    for k in ("train", "val"):
        for r in sp[k]:
            if r.source == "own":
                raise ValueError(f"본인 녹화가 {k}에 들어감: {r.meta}")
            if r.source == "ec3d" and r.subject == EC3D_TEST_SUBJECT:
                raise ValueError(f"EC3D 피험자 4가 {k}에 들어감: {r.meta}")
    if any(r.source != "own" for r in sp["test_own"]):
        raise ValueError("test_own에 본인 녹화가 아닌 것이 있음")
    if any(r.source != "ec3d" or r.subject != EC3D_TEST_SUBJECT for r in sp["test_ec3d"]):
        raise ValueError("test_ec3d에 EC3D 피험자 4가 아닌 것이 있음")
    tr = {_person(r) for r in sp["train"]}
    va = {_person(r) for r in sp["val"]}
    if tr & va:
        raise ValueError(f"같은 사람이 train과 val에 걸침: {sorted(tr & va)}")
    seen: dict[int, str] = {}
    for k in SPLITS:
        for r in sp[k]:
            if id(r) in seen and seen[id(r)] != k:
                raise ValueError(f"같은 반복이 {seen[id(r)]}와 {k}에 함께 있음")
            seen[id(r)] = k


def split(reps: list[Rep], val_frac: float = 0.2, seed: int = 0) -> dict[str, list[Rep]]:
    """keys: train, val, test_ec3d, test_own. 규칙은 모듈 docstring."""
    out: dict[str, list[Rep]] = {k: [] for k in SPLITS}
    zen = sorted({r.subject for r in reps if r.source == "zenodo"})
    n_val = int(round(len(zen) * val_frac)) if len(zen) >= 2 else 0
    perm = np.random.default_rng(seed).permutation(len(zen))
    val_people = {zen[i] for i in perm[:n_val]}
    for r in reps:
        if r.source == "own":
            out["test_own"].append(r)
        elif r.source == "ec3d":
            if r.subject == EC3D_TEST_SUBJECT:
                out["test_ec3d"].append(r)
            elif r.subject in EC3D_TRAIN_SUBJECTS:
                out["train"].append(r)
            else:
                raise ValueError(f"알 수 없는 EC3D 피험자: {r.subject}")
        elif r.source == "zenodo":
            out["val" if r.subject in val_people else "train"].append(r)
        else:
            raise ValueError(f"알 수 없는 소스: {r.source}")
    check_split(out)
    return out


# ---------------------------------------------------------------- 배열 만들기
def build_arrays(reps: list[Rep], train: bool, yaws=DEFAULT_YAWS, seed: int = 0, T: int = 64
                 ) -> tuple[np.ndarray, dict[str, np.ndarray], list[dict]]:
    """→ X (N,T,17,3) 정규화된 [x,y,conf], 운동별 라벨 {운동: (N, 칸 수) int8}, meta 목록.

    라벨 배열에서 그 운동이 아닌 샘플의 행은 -1(손실·평가에서 가림).
    EC3D는 yaws 방향마다 한 샘플(train·평가 모두, meta["yaw"]). 다른 소스는 yaw None.
    train=True면 무작위 증강(seed 고정)과 반전 짝을 더한다. train=False면 무작위 없음.
    프레임 3개 미만인 반복은 뺀다.
    """
    rng = np.random.default_rng(seed)
    xs, metas, labs = [], [], []
    aug_id = 0
    for r in reps:
        views = [(y, sk.project(r.seq, y)) for y in yaws] if r.source == "ec3d" else [(None, r.seq)]
        for yaw, s2 in views:
            s2 = clip_conf(s2)
            if len(s2) < 3:
                continue
            if train:
                f = rng.uniform(0.8, 1.2)
                rot = rng.uniform(-10, 10)
                size = rng.uniform(0.9, 1.1)
                x = _resample_at(s2, _speed_positions(len(s2), T, f))
                x = fill_empty_frames(crop_scale(_rotate(x, rot), ratio=1.0 / size))
                if r.source == "ec3d":
                    x = _jitter_conf(x, rng)
                variants = [(False, x), (True, sk.flip(x))]
            else:
                variants = [(False, fill_empty_frames(crop_scale(resample(s2, T))))]
            for flipped, x in variants:
                xs.append(x)
                labs.append(r)
                metas.append({"source": r.source, "exercise": r.exercise, "subject": r.subject,
                              "yaw": yaw, "flip": flipped, "aug_id": aug_id, **r.meta})
            aug_id += 1
    X = np.stack(xs) if xs else np.zeros((0, T, 17, 3))
    Y = {}
    for ex, cols in HEAD_LABELS.items():
        y = np.full((len(xs), len(cols)), -1, dtype=np.int8)
        for i, r in enumerate(labs):
            if r.exercise == ex:
                if list(r.labels) != cols:
                    raise ValueError(f"라벨 칸 순서가 HEAD_LABELS와 다름: {list(r.labels)}")
                y[i] = [r.labels[c] for c in cols]
        Y[ex] = y
    return X, Y, metas


# ---------------------------------------------------------------- 요약
def _label_dist(reps: list[Rep]) -> dict:
    out = {}
    for ex, cols in HEAD_LABELS.items():
        rs = [r for r in reps if r.exercise == ex]
        if rs:
            out[ex] = {"n": len(rs), "none": sum(1 for r in rs if not any(r.labels.values())),
                       **{c: sum(r.labels[c] for r in rs) for c in cols}}
    return out


def summary(write: bool = True) -> dict:
    from wom_ml.sources import ec3d as ec3d_src
    from wom_ml.sources import own as own_src
    from wom_ml.sources import zenodo as zen_src

    ec3d_root, zen_root = paths.DATA_RAW / "ec3d", paths.DATA_RAW / "zenodo"
    d = ec3d_src.safe_load(ec3d_root / "data_3D.pickle")
    mapping = ec3d_src.verify_mapping(ec3d_src.sequence_counts(np.asarray(d["labels"]).astype(str)))
    del d
    # 본인 녹화: 기본 목록(R7 제외 반영). 목록 안 녹화가 실패하면 예외로 멈춘다(조용한 축소 금지).
    reps = load_ec3d(ec3d_root) + load_zenodo(zen_root) + load_own(paths.PRIVATE_OWN)
    _, zen_dup = zen_src.scan(zen_root)
    sp = split(reps)
    res: dict = {
        "ec3d_subjects": ec3d_src.SUBJECTS,
        "ec3d_mapping": mapping,
        "ec3d_excluded": ec3d_src.excluded_counts(ec3d_root),
        "zenodo_duplicates_removed": zen_dup,
        "zenodo_people": {k: sorted({r.subject for r in sp[k] if r.source == "zenodo"})
                          for k in ("train", "val")},
        "own_excluded": {f: "제외(R7)" for f in sorted(own_src.EXCLUDED_FILES)},
        "too_short_reps": sum(1 for r in reps if len(r.seq) < 3),
        "splits": {},
    }
    for k in SPLITS:
        rs = sp[k]
        cnt = collections.Counter(f"{r.source}/{r.exercise}" for r in rs)
        entry = {"reps": dict(sorted(cnt.items())), "labels": _label_dist(rs)}
        if k == "test_own":
            entry["own_groups"] = dict(sorted(collections.Counter(
                f"{r.meta['file']}:{r.meta['group']}" for r in rs).items()))
        X, Y, meta = build_arrays(rs, train=(k == "train"))
        entry["samples"] = int(len(X))
        entry["samples_by_exercise"] = dict(collections.Counter(m["exercise"] for m in meta))
        res["splits"][k] = entry
    if write:
        paths.RUNS.mkdir(parents=True, exist_ok=True)
        (paths.RUNS / "dataset_summary.json").write_text(
            json.dumps(res, ensure_ascii=False, indent=2), encoding="utf8")
    return res


def main(argv=None):
    ap = argparse.ArgumentParser(description="반복 샘플 데이터 요약")
    ap.add_argument("--summary", action="store_true", help="개수·라벨 분포 출력 및 runs/dataset_summary.json 저장")
    a = ap.parse_args(argv)
    if a.summary:
        print(json.dumps(summary(), ensure_ascii=False, indent=2))
    else:
        ap.print_help()


if __name__ == "__main__":
    main()

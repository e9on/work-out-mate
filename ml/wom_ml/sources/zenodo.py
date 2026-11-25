"""Zenodo 18859797 스쿼트 CSV → 반복 1회 단위 Rep.

- 위치: root 아래 어디든 `pNN_<Standard|Shallow|GM>_MM.csv`. 02 zip은 00·01의 사본을 함께 담고
  있어서 **파일 내용 해시(sha256)로 중복을 뺀다**(사본이 train/val로 갈라지면 검증 점수가 부풀므로).
  이름이 같은데 내용이 다르면 어느 쪽이 맞는지 모르므로 예외.
- CSV 한 파일 = 반복 1회. 열: Frame + MediaPipe 33점 (x_i, y_i, z_i, v_i). x·y는 0~1 정규화 좌표.
- 라벨: Standard → 모두 0, Shallow → shallow, GM(굿모닝) → trunkLean.
- 피험자: 파일명 pNN.

화소 비율: 정규화 좌표는 가로를 영상 너비, 세로를 높이로 나눈 값이라 정사각이 아니면 몸이 찌그러진다.
원본 영상 크기는 공개되지 않았다. 사람이 세로 0.87, 가로 0.2를 차지하고(옆모습), 넓적다리·정강이
2D 길이가 프레임마다 가장 일정해지는 가로 배율이 중앙값 약 2.4(옆모습이 아니면 위로 치우치는 추정)라
가로 영상 16:9로 가정한다. 확실하지 않음 → 보고서 우려에 적음.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

import numpy as np

from wom_ml import skeleton as sk
from wom_ml.sources import Rep, make_labels

ASPECT_W_OVER_H = 16 / 9  # 가정(위 docstring)
_NAME = re.compile(r"^(p\d+)_(Standard|Shallow|GM)_(\d+)\.csv$")
_KIND = {"Standard": (), "Shallow": ("shallow",), "GM": ("trunkLean",)}


def scan(root: Path) -> tuple[list[Path], int]:
    """중복을 뺀 CSV 경로 목록(이름순)과 뺀 사본 수."""
    seen_hash: dict[str, Path] = {}
    seen_name: dict[str, str] = {}
    dup = 0
    for p in sorted(Path(root).rglob("*.csv")):
        if not _NAME.match(p.name):
            raise ValueError(f"Zenodo 파일 이름 형식이 다름: {p.name}")
        h = hashlib.sha256(p.read_bytes()).hexdigest()
        if p.name in seen_name and seen_name[p.name] != h:
            raise ValueError(f"이름이 같은데 내용이 다른 Zenodo 파일: {p.name}")
        if h in seen_hash:
            dup += 1
            continue
        seen_hash[h] = p
        seen_name[p.name] = h
    return sorted(seen_hash.values(), key=lambda p: p.name), dup


def read_csv(path: Path) -> np.ndarray:
    """→ (F,17,3) [x, y, conf]. x에 ASPECT_W_OVER_H를 곱해 화소 비율을 맞춘다."""
    a = np.loadtxt(path, delimiter=",", skiprows=1, ndmin=2)
    if a.shape[1] != 1 + 33 * 4:
        raise ValueError(f"열 수가 133이 아님: {path.name}")
    p = a[:, 1:].reshape(len(a), 33, 4)
    xy = p[..., :2] * np.array([ASPECT_W_OVER_H, 1.0])
    return sk.from_mediapipe33(xy, p[..., 3])


def load_zenodo(root: Path) -> list[Rep]:
    paths, _ = scan(root)
    reps = []
    for p in paths:
        subj, kind, num = _NAME.match(p.name).groups()
        reps.append(Rep(source="zenodo", exercise="squat", subject=subj, seq=read_csv(p),
                        labels=make_labels("squat", *_KIND[kind]),
                        meta={"file": p.name, "kind": kind, "rep": int(num)}))
    return reps

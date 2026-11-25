"""데이터 소스(EC3D, Zenodo, 본인 녹화)를 반복 1회 단위 `Rep`으로 읽는다.

`Rep`과 `HEAD_LABELS`는 여기 두고 `wom_ml.dataset`이 다시 내보낸다(소스 모듈이 dataset을
import하면 순환이 생기므로).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import numpy as np

# 운동별 머리의 오류 칸. 순서가 곧 라벨 배열의 열 순서다 — 바꾸지 말 것.
HEAD_LABELS: dict[str, list[str]] = {
    "squat": ["kneeIn", "shallow", "feetWide", "trunkLean"],
    "lunge": ["shallow", "kneeOverToe"],
    "plank": ["archedBack", "hunchBack"],
}


@dataclass
class Rep:
    """반복 1회.

    seq: 정규화 전 좌표.
      - zenodo·own: (F,17,3) [x, y, conf] 2D. 화소 비율(가로:세로)이 실제와 같게 맞춘 좌표.
      - ec3d: (F,17,4) [x, y, z, conf] 카메라식 3D(투영 전). yaw 투영은 dataset.build_arrays가 한다.
    labels: 그 운동 머리의 오류 칸 전부(HEAD_LABELS 순서), 값 0/1.
    meta: 소스별 부가 정보(own: file, index, group / ec3d: name, cls, rep / zenodo: file).
    """
    source: Literal["ec3d", "zenodo", "own"]
    exercise: Literal["squat", "lunge", "plank"]
    subject: str
    seq: np.ndarray
    labels: dict[str, int]
    meta: dict = field(default_factory=dict)


def empty_labels(exercise: str) -> dict[str, int]:
    """그 운동의 오류 칸을 모두 0으로(HEAD_LABELS 순서)."""
    return {k: 0 for k in HEAD_LABELS[exercise]}


def make_labels(exercise: str, *on: str) -> dict[str, int]:
    """on에 적힌 칸만 1. 없는 칸 이름이면 예외(오타로 라벨이 조용히 사라지지 않게)."""
    lab = empty_labels(exercise)
    for k in on:
        if k not in lab:
            raise ValueError(f"{exercise} 머리에 없는 라벨 칸: {k}")
        lab[k] = 1
    return lab

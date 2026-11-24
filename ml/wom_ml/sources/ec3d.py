"""EC3D(`data_3D.pickle`) → 반복 1회 단위 Rep.

파일 구조(Task 2 조사): dict{poses (N,3,25) float64, labels (N,5) 문자열}. labels 열은
[운동, 피험자 이름, 클래스 번호, 반복 번호, 전역 프레임]. (운동, 이름, 클래스, 반복)이 같은 프레임은
연속해 있고 이것이 시퀀스 하나다(371개).

시퀀스 하나 = 반복 1회로 본다. 근거: 스쿼트·런지 시퀀스마다 양 무릎 평균 각도가 (최솟값+90분위)/2
아래로 내려가는 횟수를 셌더니 스쿼트 141개 전부 1회, 런지 127개 중 124개 1회·3개 2회
(3개도 경계 근처 잡음으로 보이는 짧은 출렁임). 그래서 자르지 않고 시퀀스를 그대로 한 샘플로 쓴다.

피험자·클래스 매핑(컨트롤러 R2): 논문 Table 1의 피험자×라벨 시퀀스 개수와 실제 개수를 대조.
이름을 알파벳순(Hugues, Isinsu, Sena, Vidit)으로 1~4에 놓으면 표의 모든 칸이 정확히 일치한다.
(실제 개수, 피험자 1/2/3/4 순)
  SQUAT  1 Correct         10/10/11/10   표 10/10/11/10
  SQUAT  2 Feet too wide    5/ 8/ 5/ 5   표  5/ 8/ 5/ 5
  SQUAT  3 Knees inward     6/ 7/ 5/ 5   표  6/ 7/ 5/ 5
  SQUAT  4 Not low enough   5/ 7/ 5/ 4   표  5/ 7/ 5/ 4
  SQUAT  5 Front bent       5/ 6/ 6/ 7   표  5/ 6/ 6/ 7
  SQUAT 10 (표에 없음)       0/ 0/ 9/ 0   → 학습에서 뺀다
  Lunges 1 Correct         12/11/11/12   표 12/11/11/12
  Lunges 4 Not low enough  10/10/10/10   표 10/10/10/10
  Lunges 6 Knee passes toe 10/10/11/10   표 10/10/11/10  (4와 6 중 Sena 11인 쪽이 6)
  Plank  1 Correct          7/ 8/11/ 7   표  7/ 8/11/ 7
  Plank  7 Arched back      5/ 5/11/ 9   표  5/ 5/11/ 9
  Plank  8 Hunch back      10/10/11/ 9   표 10/10/11/ 9
유일성: 이름 4명의 24가지 순열 중 표 전체와 맞는 것은 위 하나뿐이고, 운동마다 클래스 번호↔의미의
모든 순열 중 맞는 것도 하나뿐이다(2026-11-25 실제 data_3D.pickle로 확인).
load_ec3d는 실제 데이터에서 이 대조를 다시 하고 하나라도 어긋나면 예외를 낸다.
피험자 4(Vidit)가 test_ec3d.
"""
from __future__ import annotations

import collections
import pickle
import warnings
from pathlib import Path

import numpy as np

from wom_ml import skeleton as sk
from wom_ml.sources import Rep, make_labels

SUBJECTS = {"Hugues": "1", "Isinsu": "2", "Sena": "3", "Vidit": "4"}

# (파일 운동명, 클래스 번호) -> (운동, 켜는 라벨 칸들)
CLASSES: dict[tuple[str, int], tuple[str, tuple[str, ...]]] = {
    ("SQUAT", 1): ("squat", ()),
    ("SQUAT", 2): ("squat", ("feetWide",)),
    ("SQUAT", 3): ("squat", ("kneeIn",)),
    ("SQUAT", 4): ("squat", ("shallow",)),
    ("SQUAT", 5): ("squat", ("trunkLean",)),
    ("Lunges", 1): ("lunge", ()),
    ("Lunges", 4): ("lunge", ("shallow",)),
    ("Lunges", 6): ("lunge", ("kneeOverToe",)),
    ("Plank", 1): ("plank", ()),
    ("Plank", 7): ("plank", ("archedBack",)),
    ("Plank", 8): ("plank", ("hunchBack",)),
}
# 표에 없어 학습에서 빼는 클래스
EXCLUDED = {("SQUAT", 10)}

# 논문 Table 1: (운동, 클래스) -> 피험자 1/2/3/4의 시퀀스 개수
PAPER_TABLE: dict[tuple[str, int], tuple[int, int, int, int]] = {
    ("SQUAT", 1): (10, 10, 11, 10), ("SQUAT", 2): (5, 8, 5, 5), ("SQUAT", 3): (6, 7, 5, 5),
    ("SQUAT", 4): (5, 7, 5, 4), ("SQUAT", 5): (5, 6, 6, 7),
    ("Lunges", 1): (12, 11, 11, 12), ("Lunges", 4): (10, 10, 10, 10), ("Lunges", 6): (10, 10, 11, 10),
    ("Plank", 1): (7, 8, 11, 7), ("Plank", 7): (5, 5, 11, 9), ("Plank", 8): (10, 10, 11, 9),
}

_ALLOWED = {
    ("numpy", "ndarray"), ("numpy", "dtype"),
    ("numpy.core.multiarray", "_reconstruct"), ("numpy._core.multiarray", "_reconstruct"),
    ("numpy.core.multiarray", "scalar"), ("numpy._core.multiarray", "scalar"),
    ("collections", "OrderedDict"), ("builtins", "dict"), ("builtins", "list"),
}


class _SafeUnpickler(pickle.Unpickler):
    """허용 목록(numpy 배열·기본 컨테이너)만 만든다. 받은 pickle은 신뢰하지 않는다."""

    def find_class(self, module, name):
        if (module, name) in _ALLOWED:
            return super().find_class(module, name)
        raise pickle.UnpicklingError(f"허용하지 않은 객체: {module}.{name}")


def safe_load(path: Path):
    with open(path, "rb") as f, warnings.catch_warnings():
        # 옛 numpy로 만든 pickle의 dtype(align=0) 경고는 내용과 무관
        warnings.simplefilter("ignore", category=getattr(np.exceptions, "VisibleDeprecationWarning", Warning))
        return _SafeUnpickler(f).load()


def sequence_counts(labels: np.ndarray) -> dict[tuple[str, str, int], int]:
    """(운동, 이름, 클래스) -> 시퀀스 개수."""
    seqs = {(str(r[0]), str(r[1]), int(r[2]), str(r[3])) for r in labels}
    return dict(collections.Counter((e, n, c) for e, n, c, _ in seqs))


def verify_mapping(counts: dict[tuple[str, str, int], int]) -> list[dict]:
    """실제 개수가 PAPER_TABLE과 SUBJECTS 배정에 맞는지 대조. 어긋나면 ValueError. 대조표를 돌려준다."""
    rows, bad = [], []
    for (ex, cl), want in PAPER_TABLE.items():
        got = tuple(counts.get((ex, name, cl), 0)
                    for name, _ in sorted(SUBJECTS.items(), key=lambda kv: kv[1]))
        rows.append({"exercise": ex, "class": cl, "actual": list(got), "paper": list(want),
                     "match": got == want})
        if got != want:
            bad.append(f"{ex} 클래스 {cl}: 실제 {got} != 표 {want}")
    if bad:
        raise ValueError("EC3D 피험자·클래스 매핑이 논문 표와 다르다: " + "; ".join(bad))
    return rows


def load_ec3d(root: Path, verify: bool = True) -> list[Rep]:
    """root/data_3D.pickle → Rep 목록(seq는 (F,17,4) 투영 전 3D). EXCLUDED 클래스는 뺀다."""
    d = safe_load(Path(root) / "data_3D.pickle")
    poses = np.asarray(d["poses"], dtype=np.float64)   # (N,3,25)
    labels = np.asarray(d["labels"]).astype(str)        # (N,5)
    if verify:
        verify_mapping(sequence_counts(labels))
    groups: dict[tuple, list[int]] = collections.defaultdict(list)
    for i, r in enumerate(labels):
        groups[(r[0], r[1], int(r[2]), r[3])].append(i)
    reps = []
    for (ex, name, cl, rnum), idx in groups.items():
        if (ex, cl) in EXCLUDED:
            continue
        if (ex, cl) not in CLASSES:
            raise ValueError(f"알 수 없는 EC3D 클래스: {ex} {cl}")
        if name not in SUBJECTS:
            raise ValueError(f"알 수 없는 EC3D 피험자: {name}")
        idx = np.asarray(idx)
        if not (np.diff(idx) == 1).all():
            raise ValueError(f"EC3D 시퀀스 프레임이 이어지지 않음: {ex} {name} {cl} {rnum}")
        exercise, on = CLASSES[(ex, cl)]
        xyz = poses[idx].transpose(0, 2, 1)  # (F,25,3)
        reps.append(Rep(source="ec3d", exercise=exercise, subject=SUBJECTS[name],
                        seq=sk.from_ec3d25_3d(xyz), labels=make_labels(exercise, *on),
                        meta={"name": name, "cls": cl, "rep": int(rnum)}))
    return reps


def excluded_counts(root: Path) -> dict[str, int]:
    """요약용: 뺀 클래스별 시퀀스 개수."""
    labels = np.asarray(safe_load(Path(root) / "data_3D.pickle")["labels"]).astype(str)
    c = sequence_counts(labels)
    out = collections.Counter()
    for (ex, _, cl), n in c.items():
        if (ex, cl) in EXCLUDED:
            out[f"{ex} {cl}"] += n
    return dict(out)

"""사용자 본인 녹화 → 반복 1회 단위 Rep (평가 전용, test_own에만 들어간다).

파일(모두 `paths.PRIVATE_OWN` 아래, git 밖):
- MediaPipe lite 33점: diag45-12.json(12회), diag45.json·side.json·front.json(각 6회).
  {frames:[{t(ms), image:[33×{x,y,z,visibility}], world:[33×{x,y,z,visibility}]}]}
- RTMPose-m Halpe26 2D: rtm-litebox-1.0.json(20회). {w,h,fps,frames:[{t(ms, 영상 시작 기준), k:[[x,y]×26]|null, s:[26]|null}]}

반복 구간
- lite: world 좌표의 무릎 각도(엉덩이-무릎-발목, 양쪽 평균)를 5프레임 중앙값으로 평활한 뒤,
  145° 아래로 내려가면 반복 시작 후보, 152° 위로 올라오면 끝. 그 사이 최솟값이 130° 미만일 때만 반복
  (form-analysis 설계 10절 시험과 같은 규칙). 구간 시작은 145°를 내려간 지점에서 거슬러 올라가
  마지막으로 152° 이상이던 프레임(직전 반복 끝보다 앞으로 가지 않음) — 내려가는 동작 전체를 담으려고.
  녹화마다 찾은 반복 수가 기대 개수와 다르면 ValueError.
- 영상: core 개인 회귀 테스트(`packages/core/test/squatRules.test.ts`)의 바닥 시각 20개, 바닥 ±0.8초.
  k가 null인 프레임은 conf 0인 프레임으로 둔다(시간 간격 유지).

라벨(설계 3절)
- diag45-12: 1~4 정상, 5~8 kneeIn, 9~12 무릎 앞으로(앱 기준 오류 아님 → 0)
- diag45·side·front: 1~2 정상, 3~4 kneeIn, 5~6 무릎 앞으로(0)
- 영상: 1~4 정상, 5~8 kneeIn, 9~12 뒤꿈치(모두 0, group="heel" — 평가 때 이 반복의 다른 칸만 본다),
  13~16 빨리(0, group="fast"), 17~20 shallow

화소 비율: lite image 좌표는 0~1 정규화. 시험 앱(apps/spike)은 640×480을 요청했고 세로 폰에서
480×640(가로 3 : 세로 4)으로 들어온다. 실제 녹화로 world→image 아핀 맞춤의 가로/세로 배율비가
1.28~1.32(≈4/3)로 이를 뒷받침한다. 그래서 x×480, y×640으로 화소 좌표를 만든다.
영상 k는 이미 화소 좌표(1080×1920).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from wom_ml import skeleton as sk
from wom_ml.sources import Rep, make_labels

LITE_WH = (480.0, 640.0)
LITE_FILES = {"diag45-12.json": 12, "diag45.json": 6, "side.json": 6, "front.json": 6}
VIDEO_FILE = "rtm-litebox-1.0.json"
# 컨트롤러 판단 R7: test_own에서 뺀다. 정면 녹화는 world 무릎 각도가 튀어(손이 골반을 가릴 때 무릎 점이 튐,
# form-analysis 설계 10절) 145/152/130 규칙이 5회만 찾고, 평활·신호를 바꿔도 반복 경계를 믿을 수 없다.
# 여기 없는 녹화가 반복 수 불일치로 실패하면 어디서든 예외로 멈춘다(조용히 빼지 않음).
EXCLUDED_FILES = {"front.json"}
VIDEO_BOTTOMS_S = [6.9, 9.5, 12, 14.4, 21.8, 24.3, 26.7, 29.2, 36.9, 40, 43.1, 46.1,
                   49.4, 51.6, 53.7, 55.6, 58.6, 60.8, 63, 65.2]
VIDEO_HALF_WINDOW_MS = 800.0
DOWN_DEG, UP_DEG, BOTTOM_DEG = 145.0, 152.0, 130.0
_MP_LEGS = ((23, 25, 27), (24, 26, 28))  # (엉덩이, 무릎, 발목) 왼쪽, 오른쪽


def lite_label(file: str, index: int) -> tuple[dict[str, int], str]:
    """lite 녹화 반복 번호(1부터) → (라벨, group)."""
    n = LITE_FILES[file]
    if not 1 <= index <= n:
        raise ValueError(f"{file} 반복 번호 범위 밖: {index}")
    q = n // 3  # 12회는 4개씩, 6회는 2개씩
    if index <= q:
        return make_labels("squat"), "normal"
    if index <= 2 * q:
        return make_labels("squat", "kneeIn"), "kneeIn"
    return make_labels("squat"), "kneeForward"


def video_label(index: int) -> tuple[dict[str, int], str]:
    """영상 20회 반복 번호(1부터) → (라벨, group)."""
    if not 1 <= index <= 20:
        raise ValueError(f"영상 반복 번호 범위 밖: {index}")
    if index <= 4:
        return make_labels("squat"), "normal"
    if index <= 8:
        return make_labels("squat", "kneeIn"), "kneeIn"
    if index <= 12:
        return make_labels("squat"), "heel"
    if index <= 16:
        return make_labels("squat"), "fast"
    return make_labels("squat", "shallow"), "shallow"


def _angle(a, b, c) -> np.ndarray:
    u, v = a - b, c - b
    cos = (u * v).sum(-1) / np.maximum(np.linalg.norm(u, axis=-1) * np.linalg.norm(v, axis=-1), 1e-9)
    return np.degrees(np.arccos(np.clip(cos, -1, 1)))


def _median5(a: np.ndarray) -> np.ndarray:
    pad = np.pad(a, 2, mode="edge")
    return np.median(np.stack([pad[i:i + len(a)] for i in range(5)]), axis=0)


def find_reps_by_knee(angle: np.ndarray) -> list[tuple[int, int]]:
    """프레임별 무릎 각도(도) → 반복 구간 [(시작, 끝)] (끝 포함). 규칙은 모듈 docstring.

    반복은 서기(152° 이상) → 145° 아래 → 다시 152° 위. 그래서 녹화 처음부터 굽혀 있던 구간
    (폰을 누르고 물러나는 동작 등)은 앞에 서 있는 프레임이 없으므로 반복이 아니다(앱 카운터의 재무장과 같은 생각).
    """
    a = _median5(np.asarray(angle, dtype=np.float64))
    reps, i, prev_end, armed = [], 0, 0, False
    while i < len(a):
        if a[i] >= UP_DEG:
            armed = True
        if armed and a[i] < DOWN_DEG:
            down = i
            j = i
            while j < len(a) and a[j] <= UP_DEG:
                j += 1
            if j >= len(a):
                break  # 끝까지 올라오지 않음 → 반복 아님
            if a[down:j].min() < BOTTOM_DEG:
                s = down
                while s - 1 >= prev_end and a[s - 1] < UP_DEG:
                    s -= 1
                s = max(s - 1, prev_end)  # 마지막으로 152° 이상이던 프레임
                reps.append((s, j))
                prev_end = j
            i = j  # j는 152° 위 → 다음 반복 무장
        else:
            i += 1
    return reps


def _lite_reps(path: Path, expected: int) -> list[Rep]:
    frames = json.loads(path.read_text(encoding="utf8"))["frames"]
    world = np.array([[[p["x"], p["y"], p["z"]] for p in f["world"]] for f in frames], dtype=np.float64)
    img = np.array([[[p["x"], p["y"]] for p in f["image"]] for f in frames], dtype=np.float64)
    vis = np.array([[p["visibility"] for p in f["image"]] for f in frames], dtype=np.float64)
    knee = np.mean([_angle(world[:, h], world[:, k], world[:, a]) for h, k, a in _MP_LEGS], axis=0)
    segs = find_reps_by_knee(knee)
    if len(segs) != expected:
        raise ValueError(f"{path.name}: 찾은 반복 {len(segs)}회, 기대 {expected}회")
    seq_all = sk.from_mediapipe33(img * np.array(LITE_WH), vis)
    out = []
    for n, (s, e) in enumerate(segs, start=1):
        lab, grp = lite_label(path.name, n)
        out.append(Rep(source="own", exercise="squat", subject="own", seq=seq_all[s:e + 1],
                       labels=lab, meta={"file": path.name, "index": n, "group": grp}))
    return out


def _video_reps(path: Path) -> list[Rep]:
    frames = json.loads(path.read_text(encoding="utf8"))["frames"]
    t = np.array([f["t"] for f in frames], dtype=np.float64)
    xy = np.zeros((len(frames), 26, 2))
    sc = np.zeros((len(frames), 26))
    for i, f in enumerate(frames):
        if f["k"] is not None and f["s"] is not None:
            xy[i] = f["k"]
            sc[i] = f["s"]
    seq_all = sk.from_halpe26(xy, sc)
    out = []
    for n, b in enumerate(VIDEO_BOTTOMS_S, start=1):
        m = (t >= b * 1000 - VIDEO_HALF_WINDOW_MS) & (t <= b * 1000 + VIDEO_HALF_WINDOW_MS)
        if m.sum() < 3:
            raise ValueError(f"{path.name}: {n}번째 반복 구간 프레임 부족")
        lab, grp = video_label(n)
        out.append(Rep(source="own", exercise="squat", subject="own", seq=seq_all[m],
                       labels=lab, meta={"file": path.name, "index": n, "group": grp}))
    return out


def default_files() -> list[str]:
    """기본으로 읽는 녹화: 전체에서 EXCLUDED_FILES(R7)를 뺀 것."""
    return [f for f in list(LITE_FILES) + [VIDEO_FILE] if f not in EXCLUDED_FILES]


def load_own(private_dir: Path, files: list[str] | None = None) -> list[Rep]:
    """본인 녹화 → Rep. 기본은 default_files()(R7 제외 반영). 반복 수가 기대와 다르면 ValueError."""
    private_dir = Path(private_dir)
    files = default_files() if files is None else list(files)
    reps = []
    for name in files:
        if name in LITE_FILES:
            reps += _lite_reps(private_dir / name, LITE_FILES[name])
        elif name == VIDEO_FILE:
            reps += _video_reps(private_dir / name)
        else:
            raise ValueError(f"알 수 없는 본인 녹화 파일: {name}")
    return reps

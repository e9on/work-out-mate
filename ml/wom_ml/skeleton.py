"""관절 형식 통일: 모든 입력을 MotionBERT의 H36M 17점 2D([x, y, conf])로 맞춘다.

H36M 순서는 `third_party/MotionBERT`의 `lib/data/dataset_action.py::coco2h36m`과
`lib/utils/utils_data.py::flip_data`를 그대로 따른다. 계획서의 이름 목록과 달리 MotionBERT에서는
8번이 어깨 중점(neck), 9번이 코(nose), 10번이 머리(head, 두 눈의 중점)다. 인덱스 위치는 같다.

규약
- 2D: x는 오른쪽, y는 아래(이미지 좌표). 신뢰도 0이거나 NaN/inf인 관절은 좌표 0, conf 0으로 채운다
  (출력에 NaN이 새지 않는다).
- 만들어 내는 점(pelvis, spine, neck, head)은 재료 점이 전부 유효할 때만 유효하고,
  conf는 재료 점 중 최솟값이다.
"""
from __future__ import annotations

import numpy as np

H36M = ["pelvis", "r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle",
        "spine", "neck", "nose", "head",
        "l_shoulder", "l_elbow", "l_wrist", "r_shoulder", "r_elbow", "r_wrist"]
_IDX = {n: i for i, n in enumerate(H36M)}

# MotionBERT flip_data의 left_joints=[4,5,6,11,12,13], right_joints=[1,2,3,14,15,16]
FLIP_PAIRS: list[tuple[int, int]] = [(1, 4), (2, 5), (3, 6), (11, 14), (12, 15), (13, 16)]

# MediaPipe Pose 33점 인덱스(공식)
_MP = dict(nose=0, l_eye=2, r_eye=5, l_shoulder=11, r_shoulder=12, l_elbow=13, r_elbow=14,
           l_wrist=15, r_wrist=16, l_hip=23, r_hip=24, l_knee=25, r_knee=26, l_ankle=27, r_ankle=28)

# Halpe26 인덱스: 0 코, 1/2 눈(왼/오), 5/6 어깨(왼/오), 7/8 팔꿈치, 9/10 손목, 11/12 엉덩이,
# 13/14 무릎, 15/16 발목, 17 머리 꼭대기. head는 다른 소스(MediaPipe·EC3D)와 같게 두 눈의 중점을 쓴다
# (17번 머리 꼭대기를 쓰면 소스마다 head 위치가 달라진다).
_HALPE = dict(nose=0, l_eye=1, r_eye=2, l_shoulder=5, r_shoulder=6, l_elbow=7, r_elbow=8,
              l_wrist=9, r_wrist=10, l_hip=11, r_hip=12, l_knee=13, r_knee=14,
              l_ankle=15, r_ankle=16)

# EC3D 25점 = OpenPose BODY_25 순서. 근거(받은 data_3D.pickle의 한 프레임, 단위 m):
#  - 8번이 원점(0,0,0)이고 9/12번이 x=-0.04/+0.04, z=0 -> 8 MidHip, 9 RHip, 12 LHip
#  - 0번이 z 최대 근처이고 y(앞)로 튀어나옴 -> 코. 15~18번은 z≈0.27로 머리 높이의 4점 -> 눈 2, 귀 2
#  - 1번은 x≈0이고 2/5번과 같은 높이 -> 1 Neck, 2 RShoulder, 5 LShoulder; 3/4와 6/7은 아래로 이어지는 팔
#  - 10/13은 z≈-0.14(무릎), 11/14는 z≈-0.28(발목); 19~24는 z≈-0.30의 발 6점
#  - 19/20/21은 x>0(왼쪽), 22/23/24는 x<0(오른쪽); 각 발에서 뒤꿈치가 y(앞)가 가장 작음
#    -> 19 LBigToe, 20 LSmallToe, 21 LHeel, 22 RBigToe, 23 RSmallToe, 24 RHeel
#  - 왼쪽 관절(5,6,7,12,13,14,19~21)은 x>0, 오른쪽은 x<0 -> 좌표계: x=피험자 왼쪽, y=앞, z=몸통 위쪽
#  - 주의: 원점이 골반이고 몸통이 프레임마다 위로 정렬돼 있어(플랭크도 몸통이 수직) 중력 기준 좌표가 아니다
#  (EC3D 저장소 코드는 받지 않았다. BODY_25 표준 순서와 위 관계가 일치하는 것으로 확인.)
_EC3D = dict(nose=0, r_eye=15, l_eye=16, r_shoulder=2, r_elbow=3, r_wrist=4,
             l_shoulder=5, l_elbow=6, l_wrist=7, r_hip=9, r_knee=10, r_ankle=11,
             l_hip=12, l_knee=13, l_ankle=14)


def _clean(xy: np.ndarray, conf: np.ndarray):
    """NaN/inf 좌표·신뢰도와 신뢰도<=0 관절을 좌표 0, conf 0으로 만든다."""
    xy = np.asarray(xy, dtype=np.float64)
    conf = np.asarray(conf, dtype=np.float64)
    ok = np.isfinite(conf) & (conf > 0) & np.isfinite(xy).all(axis=-1)
    return np.where(ok[..., None], xy, 0.0), np.where(ok, conf, 0.0)


def _mid(a, b):
    """두 (xy, conf)의 중점. 둘 다 유효할 때만 유효, conf는 최솟값."""
    (xa, ca), (xb, cb) = a, b
    ok = (ca > 0) & (cb > 0)
    return np.where(ok[..., None], (xa + xb) / 2, 0.0), np.where(ok, np.minimum(ca, cb), 0.0)


def _assemble(j: dict, head) -> np.ndarray:
    """j: 이름 -> (xy, conf). head: 머리 점 (xy, conf). -> (F,17,3)"""
    pelvis = _mid(j["l_hip"], j["r_hip"])
    neck = _mid(j["l_shoulder"], j["r_shoulder"])
    spine = _mid(pelvis, neck)
    pts = dict(j, pelvis=pelvis, neck=neck, spine=spine, head=head)
    out = []
    for name in H36M:
        xy, c = pts[name]
        out.append(np.concatenate([xy, c[..., None]], axis=-1))
    return np.stack(out, axis=-2)


def from_mediapipe33(xy: np.ndarray, vis: np.ndarray) -> np.ndarray:
    """(F,33,2),(F,33) -> (F,17,3) [x,y,conf]. head는 두 눈의 중점(MotionBERT의 coco2h36m과 같음)."""
    xy, vis = _clean(xy, vis)
    g = lambda k: (xy[:, _MP[k]], vis[:, _MP[k]])
    j = {n: g(n) for n in ["r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle", "nose",
                           "l_shoulder", "l_elbow", "l_wrist", "r_shoulder", "r_elbow", "r_wrist"]}
    return _assemble(j, _mid(g("l_eye"), g("r_eye")))


def from_halpe26(xy: np.ndarray, score: np.ndarray) -> np.ndarray:
    """(F,26,2),(F,26) -> (F,17,3). pelvis는 두 엉덩이 중점, neck은 두 어깨 중점, head는 두 눈(1·2)의 중점."""
    xy, score = _clean(xy, score)
    g = lambda k: (xy[:, _HALPE[k]], score[:, _HALPE[k]])
    j = {n: g(n) for n in ["r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle", "nose",
                           "l_shoulder", "l_elbow", "l_wrist", "r_shoulder", "r_elbow", "r_wrist"]}
    return _assemble(j, _mid(g("l_eye"), g("r_eye")))


def from_ec3d25_3d(xyz: np.ndarray) -> np.ndarray:
    """(F,25,3) EC3D 원좌표 -> (F,17,4) [x,y,z,1] (투영 전).

    EC3D 원좌표는 x=피험자 왼쪽, y=앞, z=위. 이를 카메라식 좌표로 바꾼다:
    x 그대로(피험자 왼쪽 = 정면 사진에서 이미지 오른쪽), y = -z(아래가 +), 깊이 z = -y(앞이 카메라 쪽).
    값이 NaN/inf인 관절은 좌표 0, 마지막 채널(conf) 0.
    """
    xyz = np.asarray(xyz, dtype=np.float64)
    cam = np.stack([xyz[..., 0], -xyz[..., 2], -xyz[..., 1]], axis=-1)
    ok = np.isfinite(cam).all(axis=-1)
    cam = np.where(ok[..., None], cam, 0.0)
    conf = ok.astype(np.float64)

    def g(k):
        i = _EC3D[k]
        return cam[:, i], conf[:, i]

    def mid(a, b):
        (xa, ca), (xb, cb) = a, b
        v = (ca > 0) & (cb > 0)
        return np.where(v[..., None], (xa + xb) / 2, 0.0), np.where(v, 1.0, 0.0)

    pelvis = mid(g("l_hip"), g("r_hip"))
    neck = mid(g("l_shoulder"), g("r_shoulder"))
    pts = {n: g(n) for n in ["r_hip", "r_knee", "r_ankle", "l_hip", "l_knee", "l_ankle", "nose",
                             "l_shoulder", "l_elbow", "l_wrist", "r_shoulder", "r_elbow", "r_wrist"]}
    pts.update(pelvis=pelvis, neck=neck, spine=mid(pelvis, neck), head=mid(g("l_eye"), g("r_eye")))
    out = [np.concatenate([pts[n][0], pts[n][1][..., None]], axis=-1) for n in H36M]
    return np.stack(out, axis=-2)


def project(xyz17: np.ndarray, yaw_deg: float) -> np.ndarray:
    """수직축(이미지 y축)으로 yaw_deg 회전한 뒤 깊이를 버리는 정사영. (F,17,4) -> (F,17,3).

    yaw 0 = 정면(피험자가 카메라를 봄), 90 = 옆면. conf는 마지막 채널을 그대로 쓴다.
    """
    t = np.deg2rad(yaw_deg)
    x, y, z, c = (xyz17[..., i] for i in range(4))
    x2 = x * np.cos(t) + z * np.sin(t)
    out = np.stack([x2, y, c], axis=-1)
    out[..., :2] = np.where(c[..., None] > 0, out[..., :2], 0.0)
    return out


def normalize(seq: np.ndarray) -> np.ndarray:
    """(F,17,3) -> 같은 모양. 프레임마다 골반을 원점으로 옮기고, 골반-목 거리의 중앙값으로 나눈다.

    골반이 없는 프레임은 가장 가까운 유효 프레임의 골반을 쓴다(없으면 0). 크기를 못 구하면 1.
    conf 0인 관절은 좌표 0으로 유지. 출력에 NaN 없음.
    """
    seq = np.asarray(seq, dtype=np.float64)
    xy, c = _clean(seq[..., :2], seq[..., 2])
    p, n = _IDX["pelvis"], _IDX["neck"]
    pel = xy[:, p].copy()
    valid = c[:, p] > 0
    if valid.any() and not valid.all():
        idx = np.where(valid)[0]
        near = idx[np.abs(np.arange(len(xy))[:, None] - idx[None]).argmin(axis=1)]
        pel = np.where(valid[:, None], pel, pel[near])
    elif not valid.any():
        pel = np.zeros_like(pel)
    both = (c[:, p] > 0) & (c[:, n] > 0)
    scale = 1.0
    if both.any():
        s = float(np.median(np.linalg.norm(xy[both, n] - xy[both, p], axis=-1)))
        if np.isfinite(s) and s > 1e-9:
            scale = s
    out_xy = (xy - pel[:, None]) / scale
    out_xy = np.where(c[..., None] > 0, out_xy, 0.0)
    return np.concatenate([out_xy, c[..., None]], axis=-1)


def flip(seq: np.ndarray) -> np.ndarray:
    """좌우반전: x 부호 반전 + FLIP_PAIRS 관절 교환 (MotionBERT flip_data와 같음). 원본은 건드리지 않는다."""
    out = np.array(seq, dtype=np.float64, copy=True)
    out[..., 0] *= -1
    for a, b in FLIP_PAIRS:
        out[..., [a, b], :] = out[..., [b, a], :]
    out[..., 0] += 0.0  # -0.0 -> 0.0
    return out

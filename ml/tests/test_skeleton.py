"""관절 형식 통일 테스트 — 전부 합성 관절로 한다(개인 녹화는 열지 않는다)."""
import numpy as np
import pytest

from wom_ml import skeleton as sk

I = {n: i for i, n in enumerate(sk.H36M)}


def halpe_frame():
    """서 있는 정면 사람(x 오른쪽, y 아래). Halpe26 한 프레임."""
    xy = np.zeros((26, 2))
    pts = {0: (0, -170), 5: (20, -150), 6: (-20, -150), 7: (25, -120), 8: (-25, -120),
           9: (28, -95), 10: (-28, -95), 11: (10, -90), 12: (-10, -90),
           13: (10, -45), 14: (-10, -45), 15: (10, 0), 16: (-10, 0), 17: (0, -180)}
    for k, v in pts.items():
        xy[k] = v
    return xy


def test_h36m_order_matches_motionbert():
    assert len(sk.H36M) == 17
    assert sk.H36M[0] == "pelvis" and sk.H36M[8] == "neck"
    assert sk.H36M[1] == "r_hip" and sk.H36M[4] == "l_hip"
    assert sorted(sk.FLIP_PAIRS) == [(1, 4), (2, 5), (3, 6), (11, 14), (12, 15), (13, 16)]


def test_from_halpe26_pelvis_is_hip_midpoint():
    xy = halpe_frame()[None]
    out = sk.from_halpe26(xy, np.ones((1, 26)))
    assert out.shape == (1, 17, 3)
    np.testing.assert_allclose(out[0, I["pelvis"], :2], (xy[0, 11] + xy[0, 12]) / 2)
    np.testing.assert_allclose(out[0, I["l_knee"], :2], xy[0, 13])
    np.testing.assert_allclose(out[0, I["r_ankle"], :2], xy[0, 16])
    np.testing.assert_allclose(out[0, I["neck"], :2], (xy[0, 5] + xy[0, 6]) / 2)
    assert (out[0, :, 2] == 1).all()


def test_from_mediapipe33_mapping():
    xy = np.zeros((1, 33, 2))
    xy[0, 23] = (1, 10); xy[0, 24] = (3, 10); xy[0, 25] = (1, 20); xy[0, 26] = (3, 20)
    xy[0, 11] = (0, 0); xy[0, 12] = (4, 0)
    out = sk.from_mediapipe33(xy, np.ones((1, 33)))
    assert out.shape == (1, 17, 3)
    np.testing.assert_allclose(out[0, I["pelvis"], :2], (2, 10))
    np.testing.assert_allclose(out[0, I["l_knee"], :2], (1, 20))
    np.testing.assert_allclose(out[0, I["r_knee"], :2], (3, 20))
    np.testing.assert_allclose(out[0, I["l_shoulder"], :2], (0, 0))


def synthetic_xyz17():
    """EC3D식 변환 결과와 같은 규약(x=피험자 왼쪽, y=아래, z=카메라에서 멀어지는 깊이)의 서 있는 사람."""
    p = np.zeros((1, 17, 4))
    p[..., 3] = 1
    p[0, I["l_knee"], :3] = (0.1, 0.5, 0.0)
    p[0, I["r_knee"], :3] = (-0.1, 0.5, 0.0)
    p[0, I["l_hip"], :3] = (0.1, 0.0, 0.0)
    p[0, I["r_hip"], :3] = (-0.1, 0.0, 0.0)
    return p


def test_project_yaw_changes_knee_gap():
    p = synthetic_xyz17()
    k = (I["l_knee"], I["r_knee"])
    gap0 = abs(sk.project(p, 0)[0, k[0], 0] - sk.project(p, 0)[0, k[1], 0])
    gap90 = abs(sk.project(p, 90)[0, k[0], 0] - sk.project(p, 90)[0, k[1], 0])
    assert gap0 == pytest.approx(0.2)
    assert gap90 == pytest.approx(0.0, abs=1e-9)
    out = sk.project(p, 0)
    assert out.shape == (1, 17, 3)
    assert out[0, I["l_knee"], 1] == pytest.approx(0.5)  # y(아래)는 회전해도 그대로
    assert (out[..., 2] == 1).all()


def test_from_ec3d25_3d_mapping():
    xyz = np.zeros((1, 25, 3))
    # EC3D 원좌표: x 피험자 왼쪽, y 앞, z 위
    xyz[0, 12] = (0.04, 0.0, 0.0)    # 왼엉덩이
    xyz[0, 9] = (-0.04, 0.0, 0.0)    # 오른엉덩이
    xyz[0, 13] = (0.04, 0.1, -0.14)  # 왼무릎: 앞 0.1, 아래 0.14
    out = sk.from_ec3d25_3d(xyz)
    assert out.shape == (1, 17, 4)
    np.testing.assert_allclose(out[0, I["pelvis"], :3], 0, atol=1e-12)
    np.testing.assert_allclose(out[0, I["l_hip"], :3], (0.04, 0, 0))
    # 변환 규약: x 그대로, y = -z(아래가 +), 깊이 = -y(앞이 카메라 쪽)
    np.testing.assert_allclose(out[0, I["l_knee"], :3], (0.04, 0.14, -0.1))
    assert (out[..., 3] == 1).all()


def test_normalize_pelvis_origin_and_unit_size():
    xy = halpe_frame()[None].repeat(5, 0) * 3 + 50
    seq = sk.from_halpe26(xy, np.ones((5, 26)))
    n = sk.normalize(seq)
    np.testing.assert_allclose(n[:, I["pelvis"], :2], 0, atol=1e-12)
    d = np.linalg.norm(n[:, I["neck"], :2] - n[:, I["pelvis"], :2], axis=-1)
    np.testing.assert_allclose(np.median(d), 1.0)
    assert (n[..., 2] == seq[..., 2]).all()


def test_flip_involution_and_swap():
    seq = sk.normalize(sk.from_halpe26(
        np.random.default_rng(0).normal(size=(4, 26, 2)) * 50 + 100, np.ones((4, 26))))
    f = sk.flip(seq)
    np.testing.assert_allclose(sk.flip(f), seq)
    np.testing.assert_allclose(f[:, I["l_knee"], 0], -seq[:, I["r_knee"], 0])
    np.testing.assert_allclose(f[:, I["l_knee"], 1], seq[:, I["r_knee"], 1])
    np.testing.assert_allclose(f[:, I["pelvis"]], seq[:, I["pelvis"]] * [-1, 1, 1], atol=1e-12)


def test_nan_and_zero_confidence_never_leak():
    xy = np.tile(halpe_frame()[None], (6, 1, 1))
    sc = np.ones((6, 26))
    xy[1, 13] = np.nan           # NaN 좌표
    sc[2, 15] = 0                # 신뢰도 0
    sc[3, 11] = 0                # 엉덩이 하나 없음 -> pelvis도 없음
    sc[4, [11, 12]] = np.nan     # 신뢰도 NaN
    xy[5, 5, 0] = np.inf
    seq = sk.from_halpe26(xy, sc)
    assert np.isfinite(seq).all()
    assert seq[1, I["l_knee"], 2] == 0 and (seq[1, I["l_knee"], :2] == 0).all()
    assert seq[3, I["pelvis"], 2] == 0
    n = sk.normalize(seq)
    assert np.isfinite(n).all()
    assert np.isfinite(sk.flip(n)).all()
    # 없는 관절은 conf 0, 좌표 0으로 남는다
    assert n[2, I["l_ankle"], 2] == 0 and (n[2, I["l_ankle"], :2] == 0).all()


def test_normalize_all_invalid_does_not_crash():
    seq = np.zeros((3, 17, 3))
    n = sk.normalize(seq)
    assert np.isfinite(n).all()


def test_ec3d_nan_gives_conf_zero():
    xyz = np.zeros((2, 25, 3))
    xyz[0, 13] = np.nan
    out = sk.from_ec3d25_3d(xyz)
    assert np.isfinite(out).all()
    assert out[0, I["l_knee"], 3] == 0


def test_from_halpe26_head_is_eye_midpoint():
    """다른 소스(MediaPipe·EC3D)와 같게 head는 두 눈(Halpe 1·2)의 중점이어야 한다(17번 머리 꼭대기 아님)."""
    xy = halpe_frame()
    xy[1] = (6, -174)   # 왼눈
    xy[2] = (-4, -172)  # 오른눈
    out = sk.from_halpe26(xy[None], np.ones((1, 26)))
    assert np.allclose(out[0, I["head"], :2], [1, -173])
    score = np.ones((1, 26))
    score[0, 2] = 0  # 눈 하나가 없으면 head도 없음
    out = sk.from_halpe26(xy[None], score)
    assert out[0, I["head"], 2] == 0

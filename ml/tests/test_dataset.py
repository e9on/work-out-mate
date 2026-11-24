"""반복 샘플·라벨·분할·증강 테스트 — 전부 합성 데이터로 한다(개인 녹화와 실제 공개 데이터는 열지 않는다)."""
import json
import pickle

import numpy as np
import pytest

from wom_ml import dataset as ds
from wom_ml import skeleton as sk
from wom_ml.sources import Rep, empty_labels
from wom_ml.sources import ec3d as ec3d_src
from wom_ml.sources import own as own_src
from wom_ml.sources import zenodo as zen_src

I = {n: i for i, n in enumerate(sk.H36M)}


# ---------------------------------------------------------------- 합성 도우미
def person2d(F=30, shift=0.0):
    """서 있다 앉는 합성 2D 사람 (F,17,3). 왼쪽/오른쪽 관절 좌표가 서로 다르다(반전 확인용)."""
    seq = np.zeros((F, 17, 3))
    base = {"pelvis": (0, 0), "r_hip": (-10, 0), "r_knee": (-12, 40), "r_ankle": (-12, 80),
            "l_hip": (10, 0), "l_knee": (15, 40), "l_ankle": (18, 80), "spine": (0, -25),
            "neck": (0, -50), "nose": (2, -62), "head": (1, -66), "l_shoulder": (20, -50),
            "l_elbow": (30, -25), "l_wrist": (35, -5), "r_shoulder": (-20, -50),
            "r_elbow": (-28, -28), "r_wrist": (-30, -8)}
    for f in range(F):
        dip = 20 * np.sin(np.pi * f / max(F - 1, 1))
        for n, (x, y) in base.items():
            yy = y + (dip if y < 40 else 0)
            seq[f, I[n]] = (x + shift, yy, 1.0)
    return seq


def rep(source, subject, exercise="squat", F=30, **lab):
    labels = empty_labels(exercise)
    labels.update(lab)
    seq = person2d(F)
    if source == "ec3d":  # 3D(투영 전) (F,17,4)
        seq = np.concatenate([seq[..., :2], np.zeros((F, 17, 1)), seq[..., 2:]], axis=-1)
        seq[..., 2] = np.linspace(-5, 5, 17)[None]
    return Rep(source=source, exercise=exercise, subject=subject, seq=seq, labels=labels, meta={})


def mixed_reps():
    reps = [rep("own", "me") for _ in range(5)]
    for s in "1234":
        reps += [rep("ec3d", s), rep("ec3d", s, "lunge"), rep("ec3d", s, "plank")]
    for p in range(1, 11):
        reps += [rep("zenodo", f"p{p:02d}") for _ in range(3)]
    return reps


# ---------------------------------------------------------------- 라벨 칸 순서
def test_head_labels_order_fixed():
    assert list(ds.HEAD_LABELS) == ["squat", "lunge", "plank"]
    assert ds.HEAD_LABELS == {"squat": ["kneeIn", "shallow", "feetWide", "trunkLean"],
                              "lunge": ["shallow", "kneeOverToe"],
                              "plank": ["archedBack", "hunchBack"]}
    assert list(empty_labels("squat")) == ds.HEAD_LABELS["squat"]


# ---------------------------------------------------------------- Review Focus 4: resample
def test_resample_short_returns_none_and_long_is_T():
    assert ds.resample(person2d(2)) is None
    out = ds.resample(person2d(500))
    assert out.shape == (64, 17, 3)
    s = person2d(500)
    assert np.allclose(out[0], s[0]) and np.allclose(out[-1], s[-1])


def test_resample_does_not_pull_missing_joints_to_origin():
    s = person2d(10)
    s[5, I["l_knee"]] = 0  # 한 프레임 관절 없음
    out = ds.resample(s, 19)  # 중간 위치들이 빈 프레임과 이웃
    ok = out[:, I["l_knee"], 2] > 0
    assert (np.abs(out[ok, I["l_knee"], 0]) > 1).all()  # 0과 섞인 좌표가 없다
    assert ((out[:, I["l_knee"], 2] == 0) == (np.abs(out[:, I["l_knee"], :2]).sum(-1) == 0)).all()


# ---------------------------------------------------------------- Review Focus 1: split
def test_split_routes_own_and_ec3d4_to_tests_only():
    reps = mixed_reps()
    sp = ds.split(reps)
    assert set(sp) == {"train", "val", "test_ec3d", "test_own"}
    assert all(r.source == "own" for r in sp["test_own"]) and len(sp["test_own"]) == 5
    assert all(r.source == "ec3d" and r.subject == "4" for r in sp["test_ec3d"])
    assert len(sp["test_ec3d"]) == 3
    for k in ("train", "val"):
        assert not any(r.source == "own" for r in sp[k])
        assert not any(r.source == "ec3d" and r.subject == "4" for r in sp[k])
    # EC3D 1~3은 train
    assert sorted({r.subject for r in sp["train"] if r.source == "ec3d"}) == ["1", "2", "3"]
    # Zenodo는 사람 단위로 갈리고 80/20
    tr = {r.subject for r in sp["train"] if r.source == "zenodo"}
    va = {r.subject for r in sp["val"] if r.source == "zenodo"}
    assert tr.isdisjoint(va) and len(tr) == 8 and len(va) == 2
    assert sum(len(v) for v in sp.values()) == len(reps)  # 빠지는 것 없음


def test_split_is_deterministic():
    a = ds.split(mixed_reps())
    b = ds.split(mixed_reps())
    assert [r.subject for r in a["val"]] == [r.subject for r in b["val"]]


def test_check_split_raises_on_person_overlap():
    z = rep("zenodo", "p01")
    with pytest.raises(ValueError):
        ds.check_split({"train": [z], "val": [rep("zenodo", "p01")], "test_ec3d": [], "test_own": []})
    e = rep("ec3d", "2")
    with pytest.raises(ValueError):
        ds.check_split({"train": [e], "val": [rep("ec3d", "2")], "test_ec3d": [], "test_own": []})


@pytest.mark.parametrize("bad, where", [(lambda: rep("own", "me"), "train"),
                                        (lambda: rep("own", "me"), "val"),
                                        (lambda: rep("ec3d", "4"), "train"),
                                        (lambda: rep("ec3d", "4"), "val")])
def test_check_split_raises_on_test_leak(bad, where):
    sp = {"train": [rep("zenodo", "p01")], "val": [rep("zenodo", "p02")], "test_ec3d": [], "test_own": []}
    sp[where].append(bad())
    with pytest.raises(ValueError):
        ds.check_split(sp)


def test_check_split_raises_when_test_ec3d_holds_other_subject():
    sp = {"train": [], "val": [], "test_ec3d": [rep("ec3d", "1")], "test_own": []}
    with pytest.raises(ValueError):
        ds.check_split(sp)


# ---------------------------------------------------------------- crop_scale 정규화
def test_crop_scale_keeps_aspect_and_fits_unit_box():
    s = person2d(20)
    s[..., 0] *= 3  # 가로로 넓힘
    n = ds.crop_scale(s)
    xy = n[n[..., 2] > 0][:, :2]
    assert xy.min() >= -1 and xy.max() <= 1
    w = xy[:, 0].max() - xy[:, 0].min()
    h = xy[:, 1].max() - xy[:, 1].min()
    assert np.isclose(max(w, h), 2.0)
    raw = s[s[..., 2] > 0][:, :2]
    rw, rh = np.ptp(raw[:, 0]), np.ptp(raw[:, 1])
    assert np.isclose(w / h, rw / rh)  # 종횡비 유지
    assert np.allclose(n[..., 2], s[..., 2])  # conf 그대로


def test_crop_scale_invalid_joints_stay_zero():
    s = person2d(10)
    s[3, I["r_wrist"]] = 0
    n = ds.crop_scale(s)
    assert (n[3, I["r_wrist"]] == 0).all()


# ---------------------------------------------------------------- Review Focus 2: 반전 증강
def test_flip_augmentation_keeps_labels_and_swaps_pairs():
    r = rep("zenodo", "p01", kneeIn=1, trunkLean=1)
    X, Y, meta = ds.build_arrays([r], train=True, seed=3)
    assert len(X) == 2
    o = next(i for i, m in enumerate(meta) if not m["flip"])
    f = next(i for i, m in enumerate(meta) if m["flip"])
    assert meta[o]["aug_id"] == meta[f]["aug_id"]
    assert np.allclose(X[f], sk.flip(X[o]))
    # 관절 짝이 바뀜: 반전된 r_knee의 x = -(원래 l_knee의 x)
    assert np.allclose(X[f][:, I["r_knee"], 0], -X[o][:, I["l_knee"], 0])
    assert np.allclose(X[f][:, I["l_wrist"], 1], X[o][:, I["r_wrist"], 1])
    assert (Y["squat"][o] == Y["squat"][f]).all()
    assert list(Y["squat"][f]) == [1, 0, 0, 1]


def test_build_arrays_eval_no_augmentation_and_label_masks():
    reps = [rep("zenodo", "p01", shallow=1), rep("ec3d", "4", "lunge", kneeOverToe=1)]
    X, Y, meta = ds.build_arrays(reps, train=False, yaws=(0, 45, 90))
    assert X.shape == (1 + 3, 64, 17, 3)
    assert [m["yaw"] for m in meta] == [None, 0, 45, 90]
    assert not any(m["flip"] for m in meta)
    assert np.abs(X[..., :2]).max() <= 1
    assert list(Y["squat"][0]) == [0, 1, 0, 0]
    assert (Y["squat"][1:] == -1).all()  # 다른 운동 샘플은 -1(가림)
    assert (Y["lunge"][1:] == [0, 1]).all() and (Y["lunge"][0] == -1).all()
    assert (Y["plank"] == -1).all()
    # 같은 입력이면 같은 결과(평가에는 무작위가 없다)
    X2, _, _ = ds.build_arrays(reps, train=False, yaws=(0, 45, 90), seed=99)
    assert np.allclose(X, X2)


def test_build_arrays_train_ec3d_uses_all_yaws_and_is_seeded():
    r = rep("ec3d", "1", kneeIn=1)
    X, Y, meta = ds.build_arrays([r], train=True)
    assert sorted({m["yaw"] for m in meta}) == [0, 30, 45, 60, 90]
    assert len(X) == 10  # 5방향 x 반전 유무
    X2, _, _ = ds.build_arrays([r], train=True)
    assert np.allclose(X, X2)
    X3, _, _ = ds.build_arrays([r], train=True, seed=1)
    assert not np.allclose(X, X3)
    assert np.isfinite(X).all() and np.abs(X[..., :2]).max() <= 1


def test_build_arrays_drops_too_short_reps():
    X, Y, meta = ds.build_arrays([rep("zenodo", "p01", F=2), rep("zenodo", "p02")], train=False)
    assert len(X) == 1 and meta[0]["subject"] == "p02"


# ---------------------------------------------------------------- EC3D
def write_ec3d(path, rows):
    """rows: [(운동, 이름, 클래스, 반복, 프레임수)] -> data_3D.pickle 모양의 합성 파일."""
    poses, labels, g = [], [], 0
    for ex, name, cl, r, n in rows:
        for _ in range(n):
            p = np.zeros((3, 25))
            p[2, 0] = 0.5  # 코가 위
            p[0, 12], p[0, 9] = 0.1, -0.1
            poses.append(p)
            labels.append([ex, name, str(cl), str(r), str(g)])
            g += 1
    with open(path, "wb") as f:
        pickle.dump({"poses": np.array(poses), "labels": np.array(labels)}, f)


def test_load_ec3d_labels_subjects_and_excludes_class10(tmp_path):
    write_ec3d(tmp_path / "data_3D.pickle", [
        ("SQUAT", "Hugues", 1, 1, 5), ("SQUAT", "Vidit", 3, 1, 6), ("SQUAT", "Sena", 10, 1, 5),
        ("Lunges", "Isinsu", 6, 2, 7), ("Plank", "Sena", 7, 1, 4), ("Plank", "Vidit", 8, 1, 4)])
    reps = ec3d_src.load_ec3d(tmp_path, verify=False)
    assert len(reps) == 5  # 클래스 10은 빠짐
    by = {(r.exercise, r.subject): r for r in reps}
    assert by[("squat", "1")].labels == {"kneeIn": 0, "shallow": 0, "feetWide": 0, "trunkLean": 0}
    assert by[("squat", "4")].labels["kneeIn"] == 1
    assert by[("lunge", "2")].labels == {"shallow": 0, "kneeOverToe": 1}
    assert by[("plank", "3")].labels == {"archedBack": 1, "hunchBack": 0}
    assert by[("plank", "4")].labels == {"archedBack": 0, "hunchBack": 1}
    assert by[("squat", "4")].seq.shape == (6, 17, 4)
    assert by[("squat", "4")].meta["name"] == "Vidit"


def test_ec3d_mapping_verification_matches_paper_table():
    counts = {}
    for (ex, cl), row in ec3d_src.PAPER_TABLE.items():
        for name, subj in ec3d_src.SUBJECTS.items():
            counts[(ex, name, cl)] = row[int(subj) - 1]
    ec3d_src.verify_mapping(counts)  # 예외 없음
    counts[("SQUAT", "Isinsu", 2)] = 5  # 한 칸이라도 다르면 예외
    with pytest.raises(ValueError):
        ec3d_src.verify_mapping(counts)


def test_ec3d_unpickler_refuses_code(tmp_path):
    class Evil:
        def __reduce__(self):
            import os
            return (os.getcwd, ())
    p = tmp_path / "data_3D.pickle"
    p.write_bytes(pickle.dumps({"poses": Evil()}))
    with pytest.raises(pickle.UnpicklingError):
        ec3d_src.safe_load(p)


# ---------------------------------------------------------------- Zenodo
def write_zen(path, F=10, seed=0):
    rng = np.random.default_rng(seed)
    head = "Frame," + ",".join(f"x_{i},y_{i},z_{i},v_{i}" for i in range(33))
    rows = [",".join([str(f + 1)] + [f"{v:.5f}" for v in rng.uniform(0.2, 0.8, 132)]) for f in range(F)]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(head + "\n" + "\n".join(rows) + "\n")


def test_load_zenodo_dedups_by_content_and_labels(tmp_path):
    write_zen(tmp_path / "00_Standard/00_Standard/p01_Standard_01.csv", seed=1)
    write_zen(tmp_path / "02_Err_GoodMorning/00_Standard/p01_Standard_01.csv", seed=1)  # 사본
    write_zen(tmp_path / "01_Err_Shallow/01_Err_Shallow/p02_Shallow_01.csv", seed=2)
    write_zen(tmp_path / "02_Err_GoodMorning/02_Err_GoodMorning/p03_GM_04.csv", seed=3)
    reps = zen_src.load_zenodo(tmp_path)
    assert len(reps) == 3
    by = {r.subject: r for r in reps}
    assert by["p01"].labels == {"kneeIn": 0, "shallow": 0, "feetWide": 0, "trunkLean": 0}
    assert by["p02"].labels["shallow"] == 1
    assert by["p03"].labels["trunkLean"] == 1
    assert by["p01"].seq.shape == (10, 17, 3)
    assert all(r.exercise == "squat" and r.source == "zenodo" for r in reps)


def test_load_zenodo_raises_on_same_name_different_content(tmp_path):
    write_zen(tmp_path / "a/a/p01_Standard_01.csv", seed=1)
    write_zen(tmp_path / "b/b/p01_Standard_01.csv", seed=2)
    with pytest.raises(ValueError):
        zen_src.load_zenodo(tmp_path)


# ---------------------------------------------------------------- 본인 녹화(합성)
def knee_profile(n_reps, shallow_dips=0, fps=30):
    """서기 170°, 바닥 100°인 반복 n회 + 바닥 135°(130 미만 아님)인 얕은 굽힘."""
    a = [170.0] * 20
    for _ in range(n_reps):
        a += list(np.linspace(170, 100, 25)) + list(np.linspace(100, 170, 25)) + [170.0] * 10
    for _ in range(shallow_dips):
        a += list(np.linspace(170, 135, 15)) + list(np.linspace(135, 170, 15)) + [170.0] * 10
    a[5] = 60.0  # 서 있는 중 한 프레임 튐(중앙값 평활로 무시돼야 함)
    return a


def lite_frames(angles, dt=33.3):
    frames = []
    for i, th in enumerate(angles):
        t = np.deg2rad(th)
        world = [{"x": 0.0, "y": 0.0, "z": 0.0, "visibility": 0.9} for _ in range(33)]
        image = [{"x": 0.5, "y": 0.5, "z": 0.0, "visibility": 0.9} for _ in range(33)]
        for hip, knee, ank, side in ((23, 25, 27, 0.1), (24, 26, 28, -0.1)):
            world[hip].update(x=side, y=0.0)
            world[knee].update(x=side, y=0.45)
            world[ank].update(x=side, y=0.45 - 0.45 * np.cos(t), z=0.45 * np.sin(t))
            for j in (hip, knee, ank):
                image[j].update(x=0.5 + world[j]["x"], y=0.3 + world[j]["y"] / 2)
        frames.append({"t": i * dt, "image": image, "world": world})
    return {"frames": frames}


def halpe_file(bottoms_s, fps=30, dur=70):
    frames = []
    for i in range(int(dur * fps)):
        t = i * 1000 / fps
        if i % 50 == 7:
            frames.append({"t": t, "k": None, "s": None})
            continue
        k = [[500 + j, 900 + 10 * j] for j in range(26)]
        frames.append({"t": t, "k": k, "s": [0.9] * 26})
    return {"fps": fps, "w": 1080, "h": 1920, "frames": frames}


def write_own(d, counts=(12, 6, 6, 6)):
    for name, n in zip(["diag45-12.json", "diag45.json", "side.json", "front.json"], counts):
        (d / name).write_text(json.dumps(lite_frames(knee_profile(n, shallow_dips=1))))
    (d / "rtm-litebox-1.0.json").write_text(json.dumps(halpe_file(own_src.VIDEO_BOTTOMS_S)))


def test_find_reps_lite_rule():
    reps = own_src.find_reps_by_knee(np.array(knee_profile(4, shallow_dips=2)))
    assert len(reps) == 4  # 130° 미만이 아닌 얕은 굽힘과 한 프레임 튐은 반복이 아니다
    for s, e in reps:
        assert s < e


def test_load_own_groups_and_labels(tmp_path):
    write_own(tmp_path)
    reps = own_src.load_own(tmp_path)
    assert all(r.source == "own" and r.exercise == "squat" for r in reps)
    vid = sorted([r for r in reps if r.meta["file"] == "rtm-litebox-1.0.json"], key=lambda r: r.meta["index"])
    assert [r.meta["index"] for r in vid] == list(range(1, 21))
    for r in vid:
        i = r.meta["index"]
        assert r.labels["kneeIn"] == int(5 <= i <= 8)
        assert r.labels["shallow"] == int(17 <= i <= 20)
        assert r.labels["feetWide"] == 0 and r.labels["trunkLean"] == 0
        if 9 <= i <= 12:
            assert r.meta["group"] == "heel" and sum(r.labels.values()) == 0
        if 13 <= i <= 16:
            assert r.meta["group"] == "fast"
        # 바닥 ±0.8초 구간 = 약 48프레임(30fps), 빈 프레임은 conf 0
        assert 40 <= len(r.seq) <= 50
    d12 = sorted([r for r in reps if r.meta["file"] == "diag45-12.json"], key=lambda r: r.meta["index"])
    assert len(d12) == 12
    assert [r.labels["kneeIn"] for r in d12] == [0] * 4 + [1] * 4 + [0] * 4
    for name in ("diag45.json", "side.json", "front.json"):
        rs = sorted([r for r in reps if r.meta["file"] == name], key=lambda r: r.meta["index"])
        assert [r.labels["kneeIn"] for r in rs] == [0, 0, 1, 1, 0, 0]
        assert all(r.labels["shallow"] == 0 for r in rs)
        assert all(r.seq.shape[1:] == (17, 3) for r in rs)
    assert len(reps) == 20 + 12 + 18


def test_find_reps_needs_standing_before_first_rep():
    """녹화가 이미 굽힌 자세로 시작하면(폰을 누르고 물러나는 등) 그 첫 굽힘은 반복이 아니다."""
    a = list(np.linspace(110, 170, 20)) + knee_profile(3)
    assert len(own_src.find_reps_by_knee(np.array(a))) == 3
    # 끝까지 올라오지 않은 마지막 굽힘도 반복이 아니다
    b = knee_profile(2) + list(np.linspace(170, 100, 25))
    assert len(own_src.find_reps_by_knee(np.array(b))) == 2


def test_load_own_files_subset(tmp_path):
    write_own(tmp_path, counts=(12, 6, 5, 6))
    reps = own_src.load_own(tmp_path, files=["diag45.json", "rtm-litebox-1.0.json"])
    assert sorted({r.meta["file"] for r in reps}) == ["diag45.json", "rtm-litebox-1.0.json"]
    with pytest.raises(ValueError):
        own_src.load_own(tmp_path, files=["없는파일.json"])


def test_load_own_wrong_rep_count_raises(tmp_path):
    write_own(tmp_path, counts=(12, 6, 5, 6))
    with pytest.raises(ValueError, match="side.json"):
        own_src.load_own(tmp_path)


def test_own_label_rules_direct():
    lab, grp = own_src.video_label(5)
    assert lab["kneeIn"] == 1 and grp == "kneeIn"
    lab, grp = own_src.video_label(18)
    assert lab["shallow"] == 1 and grp == "shallow"
    lab, grp = own_src.video_label(10)
    assert grp == "heel" and sum(lab.values()) == 0
    with pytest.raises(ValueError):
        own_src.video_label(21)

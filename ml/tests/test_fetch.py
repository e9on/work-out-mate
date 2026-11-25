"""받기 스크립트 테스트(네트워크 없이)."""
import hashlib
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import fetch_data  # noqa: E402


def test_check_weights_없으면_README_안내(tmp_path):
    missing = tmp_path / "motionbert_lite.bin"
    with pytest.raises(FileNotFoundError) as e:
        fetch_data.check_weights(missing)
    assert "README" in str(e.value)
    assert str(missing) in str(e.value)


def test_check_weights_있으면_통과(tmp_path):
    f = tmp_path / "w.bin"
    f.write_bytes(b"")
    assert fetch_data.check_weights(f) is None


def _boom(*a, **k):
    raise AssertionError("다시 받으면 안 됨")


def _block_network(monkeypatch):
    monkeypatch.setattr(fetch_data, "_download", _boom)
    monkeypatch.setattr(fetch_data, "_run", _boom)
    monkeypatch.setattr(urllib.request, "urlopen", _boom)


@pytest.mark.parametrize("fn", ["fetch_zenodo", "fetch_ec3d", "fetch_motionbert"])
def test_완료_표시가_있으면_다시_받지_않는다(tmp_path, monkeypatch, fn):
    dest = tmp_path / "x"
    dest.mkdir()
    (dest / "dummy.txt").write_text("hi")
    (dest / ".done").write_text("ok")
    _block_network(monkeypatch)
    assert getattr(fetch_data, fn)(dest) == dest


def _zip_bytes():
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("a.csv", "1,2\n")
    return b.getvalue()


def _fake_zenodo(monkeypatch, fail_on=None, bad_md5=False):
    data = _zip_bytes()
    md5 = "0" * 32 if bad_md5 else hashlib.md5(data).hexdigest()
    rec = {"files": [
        {"key": f"{n}.zip", "checksum": f"md5:{md5}", "links": {"self": f"http://x/{n}"}}
        for n in ("f1", "f2")
    ]}

    class R(io.BytesIO):
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    monkeypatch.setattr(urllib.request, "urlopen", lambda url: R(json.dumps(rec).encode()))
    calls = []

    def dl(url, out):
        calls.append(url)
        if fail_on and url.endswith(fail_on):
            raise OSError("끊김")
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(data)

    monkeypatch.setattr(fetch_data, "_download", dl)
    return calls


def test_zenodo_도중_실패하면_다음에_다시_받는다(tmp_path, monkeypatch):
    dest = tmp_path / "z"
    _fake_zenodo(monkeypatch, fail_on="f2")
    with pytest.raises(OSError):
        fetch_data.fetch_zenodo(dest)
    assert not (dest / ".done").exists()
    calls = _fake_zenodo(monkeypatch)
    fetch_data.fetch_zenodo(dest)
    assert len(calls) == 2  # 첫 파일 포함 전부 다시
    assert (dest / ".done").is_file()
    assert (dest / "f2" / "a.csv").is_file()


def test_zenodo_체크섬_불일치면_완료_표시_없음(tmp_path, monkeypatch):
    dest = tmp_path / "z"
    _fake_zenodo(monkeypatch, bad_md5=True)
    with pytest.raises(RuntimeError):
        fetch_data.fetch_zenodo(dest)
    assert not (dest / ".done").exists()


def test_ec3d_도중_실패하면_다음에_다시_받는다(tmp_path, monkeypatch):
    dest = tmp_path / "e"
    state = {"fail": True, "n": 0}

    def run(cmd, cwd=None):
        state["n"] += 1
        d = Path(cmd[cmd.index("-O") + 1])
        d.mkdir(parents=True, exist_ok=True)
        (d / "part.pickle").write_bytes(b"x")
        if state["fail"]:
            raise RuntimeError("끊김")

    monkeypatch.setattr(fetch_data, "_run", run)
    with pytest.raises(RuntimeError):
        fetch_data.fetch_ec3d(dest)
    assert not (dest / ".done").exists()
    state["fail"] = False
    fetch_data.fetch_ec3d(dest)
    assert state["n"] == 2
    assert (dest / ".done").is_file()


def test_motionbert_checkout_실패하면_완료_표시_없고_다시_받는다(tmp_path, monkeypatch):
    dest = tmp_path / "m"
    state = {"fail": True, "clones": 0}

    def run(cmd, cwd=None):
        if cmd[1] == "clone":
            state["clones"] += 1
            d = Path(cmd[3])
            d.mkdir(parents=True)
            (d / "train.py").write_text("x")
        elif state["fail"]:
            raise RuntimeError("checkout 실패")

    monkeypatch.setattr(fetch_data, "_run", run)
    with pytest.raises(RuntimeError):
        fetch_data.fetch_motionbert(dest)
    assert not (dest / ".done").exists()
    state["fail"] = False
    fetch_data.fetch_motionbert(dest)
    assert state["clones"] == 2
    assert (dest / ".done").is_file()

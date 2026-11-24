"""받기 스크립트 테스트(네트워크 없이)."""
import sys
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


@pytest.mark.parametrize("fn", ["fetch_zenodo", "fetch_ec3d", "fetch_motionbert"])
def test_이미_받은_폴더는_다시_받지_않는다(tmp_path, fn):
    dest = tmp_path / "x"
    dest.mkdir()
    (dest / "dummy.txt").write_text("hi")
    # 네트워크·git·gdown을 부르면 실패하도록 막는다
    def boom(*a, **k):
        raise AssertionError("다시 받으면 안 됨")
    fetch_data._download = boom
    fetch_data._run = boom
    assert getattr(fetch_data, fn)(dest) == dest

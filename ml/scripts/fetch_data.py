"""데이터·코드 받기: Zenodo(스쿼트), EC3D(Google Drive), MotionBERT 코드, 경량 가중치 확인.

사용: python ml/scripts/fetch_data.py   (저장소 루트에서)
이미 받은 폴더(비어 있지 않음)는 다시 받지 않는다.
"""
import hashlib
import json
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ML_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_ROOT))
from wom_ml import paths  # noqa: E402

ZENODO_API = "https://zenodo.org/api/records/18859797"
EC3D_FOLDER_ID = "1Y00Qw6QyAnhrxUWelyFcTm2a7tnZB93y"
EC3D_FOLDER_URL = f"https://drive.google.com/drive/folders/{EC3D_FOLDER_ID}"
MOTIONBERT_URL = "https://github.com/Walter0807/MotionBERT"
# 받을 때 고정한 커밋(README에도 기록). 받은 시점(2026-11-25) main의 HEAD.
MOTIONBERT_SHA = "705d3a95354db8bdb696b3492e47a3b5537174ff"
LITE_ONEDRIVE = "https://1drv.ms/f/s!AvAdh0LSjEOlgS27Ydcbpxlkl0ng?e=rq2Btn"


def _download(url: str, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(url, out)


def _run(cmd: list, cwd=None) -> None:
    subprocess.run(cmd, cwd=cwd, check=True)


def _already(dest: Path) -> bool:
    return dest.is_dir() and any(dest.iterdir())


def fetch_zenodo(dest: Path = paths.DATA_RAW / "zenodo") -> Path:
    if _already(dest):
        return dest
    dest.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(ZENODO_API) as r:
        rec = json.load(r)
    for f in rec["files"]:
        zpath = dest / f["key"]
        _download(f["links"]["self"], zpath)
        algo, _, want = f["checksum"].partition(":")
        got = hashlib.new(algo, zpath.read_bytes()).hexdigest()
        if got != want:
            raise RuntimeError(f"체크섬 불일치: {f['key']} ({got} != {want})")
        with zipfile.ZipFile(zpath) as z:
            z.extractall(dest / zpath.stem)
    return dest


def fetch_ec3d(dest: Path = paths.DATA_RAW / "ec3d") -> Path:
    if _already(dest):
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    _run([sys.executable, "-m", "gdown", "--folder", EC3D_FOLDER_URL, "-O", str(dest)])
    return dest


def fetch_motionbert(dest: Path = paths.THIRD_PARTY / "MotionBERT", sha: str = MOTIONBERT_SHA) -> Path:
    if _already(dest):
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    _run(["git", "clone", MOTIONBERT_URL, str(dest)])
    _run(["git", "checkout", sha], cwd=dest)
    return dest


def check_weights(path: Path = paths.WEIGHTS / "motionbert_lite.bin") -> None:
    if not Path(path).is_file():
        raise FileNotFoundError(
            f"MotionBERT-Lite 사전학습 가중치가 없습니다: {path}\n"
            f"ml/README.md의 '데이터·가중치' 절을 보고 직접 받아 넣어 주세요."
        )


if __name__ == "__main__":
    print(fetch_zenodo())
    print(fetch_ec3d())
    print(fetch_motionbert())
    check_weights(next(iter(paths.WEIGHTS.glob("*.bin")), paths.WEIGHTS / "motionbert_lite.bin"))

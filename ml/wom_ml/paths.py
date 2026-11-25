"""실험 전반에서 쓰는 경로 상수(저장소 루트 기준 절대 경로)."""
from pathlib import Path

ML_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ML_ROOT.parent
DATA_RAW = ML_ROOT / "data" / "raw"
DATA_PROC = ML_ROOT / "data" / "processed"
RUNS = ML_ROOT / "runs"
THIRD_PARTY = ML_ROOT / "third_party"
WEIGHTS = ML_ROOT / "weights"
PRIVATE_OWN = REPO_ROOT / "packages" / "core" / "test" / "fixtures" / "private" / "angle-test"

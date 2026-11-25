import pytest

from wom_ml import paths


def test_paths_are_inside_repo():
    root = paths.ML_ROOT.parent
    for name in ("ML_ROOT", "DATA_RAW", "DATA_PROC", "RUNS", "THIRD_PARTY", "WEIGHTS", "PRIVATE_OWN"):
        p = getattr(paths, name)
        assert p.is_absolute(), name
        assert p.is_relative_to(root), name
    assert (paths.ML_ROOT.parent / ".git").exists()


def test_gitignore_excludes_ml_artifacts():
    text = (paths.ML_ROOT.parent / ".gitignore").read_text(encoding="utf-8")
    lines = {l.strip() for l in text.splitlines()}
    for folder in ("ml/data/", "ml/runs/", "ml/third_party/", "ml/weights/"):
        assert folder in lines, folder


def test_torch_cuda():
    torch = pytest.importorskip("torch") if False else __import__("torch")
    assert torch.cuda.is_available(), "CUDA판 PyTorch가 아님"

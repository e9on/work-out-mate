# ml - 자세 오류 분류 파인튜닝 실험

## 환경

- 대상: 전역 Python 3.11(conda 환경은 건드리지 않음), GPU RTX 4060 Ti 8GB, 드라이버 616.92
- 설치: `powershell -File ml/setup_env.ps1` (다시 실행해도 안전, 이미 CUDA판이면 PyTorch 설치를 건너뜀)
- 확인: `python -m pytest ml/tests/test_env.py` (저장소 루트에서)
- `torch.cuda.get_device_name(0)` = `NVIDIA GeForce RTX 4060 Ti` ("4060" 포함 확인)

### PyTorch 교체 기록

- 같은 버전(2.11.0 / 0.26.0)의 cu126 빌드가 있어 그대로 교체했다. 가까운 다른 버전을 고르지 않았다.
- 교체 전 `pip list`: `torch 2.11.0`(CPU판, `2.11.0+cpu`), `torchvision 0.26.0`
- 교체 후 `pip list`: `torch 2.11.0+cu126`, `torchvision 0.26.0+cu126`
- 구형 pip(22.3)가 `--index-url`만 쓰면 빌드 의존성(flit_core)을 못 찾아 실패하므로 `--no-deps`로 설치한다(의존성은 PyPI에서 따로 설치).

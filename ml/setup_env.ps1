# 전역 Python 3.11에 CUDA판 PyTorch와 실험 패키지를 설치한다. 다시 실행해도 안전하다.
$ErrorActionPreference = 'Stop'
$torchVer = '2.11.0'
$tvVer = '0.26.0'
$index = 'https://download.pytorch.org/whl/cu126'

$isCuda = $false
try {
    $out = python -c "import torch; print(torch.__version__, torch.cuda.is_available())" 2>$null
    if ($out -match "^$([regex]::Escape($torchVer))\+cu\d+ True") { $isCuda = $true }
} catch {}

if ($isCuda) {
    Write-Host "이미 CUDA판 PyTorch($out) - 건너뜀"
} else {
    # 의존성은 이미 설치돼 있어 --no-deps(구형 pip가 PyTorch 인덱스만 보고 빌드 의존성을 못 찾는 문제 회피)
    python -m pip install --upgrade --force-reinstall --no-deps "torch==$torchVer" "torchvision==$tvVer" --index-url $index
}

# 나머지는 PyPI에서 없는 것만 설치(pip가 이미 있으면 건너뜀)
python -m pip install numpy scikit-learn pytest gdown tqdm pyyaml einops timm
python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"

# ml - 자세 오류 분류 파인튜닝 실험

설계: `docs/specs/2026-11-25-finetune-experiment-design.md` / 결과 보고서: `docs/finetune-experiment-results.md`

## 처음부터 끝까지 실행 순서

PowerShell, 저장소 루트(`C:\Coding\work-out-mate`) 기준. 각 단계의 자세한 설명은 아래 절에 있다.

| 순서 | 할 일 | 명령 | 확인 |
|---|---|---|---|
| 1 | 환경(CUDA판 PyTorch·패키지) | `powershell -File ml/setup_env.ps1` | `python -m pytest ml/tests/test_env.py` |
| 2 | 데이터·MotionBERT 코드 받기 | `python ml/scripts/fetch_data.py` | `ml/data/raw/{zenodo,ec3d}`, `ml/third_party/MotionBERT`에 `.done` |
| 3 | MotionBERT-Lite 가중치 **수동** 받기 | 브라우저로 받아 `ml/weights/motionbert_lite.bin`에 둔다(아래 '가중치' 절) | `python -m pytest ml/tests/test_motionbert.py`에서 실가중치 테스트가 skip 없이 통과 |
| 4 | 데이터 요약(분할·라벨 개수) | `cd ml; python -m wom_ml.dataset --summary; cd ..` | `ml/runs/dataset_summary.json` |
| 5 | 전체 단계 실행 | `python ml/scripts/run_all.py` (먼저 `--dry-run`으로 계획 확인) | `ml/runs/run_all_status.json`의 단계가 모두 `done` |
| 6 | 보고서 표 다시 만들기 | `cd ml; python -m wom_ml.report; cd ..` | `docs/finetune-experiment-results.md`의 자동 생성 절이 바뀜 |
| 7 | 해석 보완 | 보고서의 '해석' 절(사람이 씀)을 새 표에 맞게 갱신한다 | — |

- 개인 녹화(본인 스쿼트)는 `packages/core/test/fixtures/private/angle-test/`(git 제외)에 있어야 4·5단계의 test_own·규칙 판정이 돈다. 읽기만 한다.
- 5단계의 규칙 판정(rules)은 node와 `npx esbuild`(저장소 node_modules)를 쓴다.
- 3단계 없이 5단계를 돌리면 rules·small만 돌고 MotionBERT 단계는 `skipped_no_weights`로 남는다(종료 코드 2). 가중치를 넣고 5단계를 다시 돌리면 MotionBERT 단계만 이어서 돈다.
- 6단계는 `ml/runs/`의 집계 지표만 읽는다. 보고서 파일에서 `<!-- report:start ... -->`~`<!-- report:end -->` 사이만 바꾸고, 그 밖의 사람이 쓴 글은 그대로 둔다. 화면에만 보려면 `--stdout`.
- 전체 테스트: `python -m pytest ml/tests -q`

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

## 데이터·가중치

받기: `python ml/scripts/fetch_data.py` (저장소 루트에서). 이미 받은 폴더는 다시 받지 않는다. 데이터·가중치·코드는 모두 git 제외(`.gitignore`).
테스트: `python -m pytest ml/tests/test_fetch.py` (네트워크 없이).

### Zenodo 스쿼트 (`ml/data/raw/zenodo/`)

- 레코드 18859797, CC BY 4.0, MediaPipe 33점 2D 좌표+가시성 CSV. 최신 버전은 레코드 19550070(파일이 더 많음)이지만 **원래 레코드 18859797 그대로** 받았다.
- 파일(MD5는 Zenodo 값과 일치 확인, SHA256은 직접 계산):

| 파일 | 크기(바이트) | SHA256 |
|---|---|---|
| 00_Standard.zip | 18,038,210 | 2a7ca77dadd8ece3a1a7ec4e33fa313a6735c7b354c196395c69b26113597552 |
| 01_Err_Shallow.zip | 2,408,003 | 052feb313b6cd5f58a9d1909887fe738aac9bde627ffbbc877766d995f5efffa |
| 02_Err_GoodMorning.zip | 21,351,834 | 2cb84051442a3a10fa23711b6afe1eca0085a30ce5a28409f7479e66419f70e5 |

- 02 zip은 00·01 전체의 사본을 포함한다(합집합이므로 중복 주의). 고유 CSV는 표준 193 + 얕은 스쿼트 23 + 굿모닝 10 = 226개.

### EC3D (`ml/data/raw/ec3d/`)

- 출처: GitHub Jacoo-Zhao/3D-Pose-Based-Feedback-For-Physical-Exercises README의 Google Drive 폴더(gdown). 받은 날 2026-11-25.

| 파일 | 크기(바이트) | SHA256 |
|---|---|---|
| data_3D.pickle | 21,448,352 | a05c8b4f55f2f43637d2d6cbf40722807ea780f47e84090470bd100c927ebbdf |
| data.pickle | 961,198,097 | 0f6e7f86c67ba1eee320f209bd727cff022a0c079bcd06d30e1a2eb6fc77e92c |

### MotionBERT 코드 (`ml/third_party/MotionBERT/`)

- https://github.com/Walter0807/MotionBERT, 커밋 `705d3a95354db8bdb696b3492e47a3b5537174ff`("Update mesh.md")로 고정(detached HEAD).

### MotionBERT-Lite 사전학습 가중치 (`ml/weights/`) - 수동으로 받아야 함

OneDrive가 자동 다운로드를 막는다(403). 브라우저로 직접 받아 `ml/weights/`에 넣는다.

1. 링크(MotionBERT README의 `MotionBERT-Lite (61MB)` 행): https://1drv.ms/f/s!AvAdh0LSjEOlgS27Ydcbpxlkl0ng?e=rq2Btn
2. 폴더 안의 Lite 모델 체크포인트 `best_epoch.bin`(약 61MB)을 받는다.
3. **`ml/weights/motionbert_lite.bin`** 이름으로 둔다(`ml/weights/` 폴더가 없으면 만든다). 코드(`wom_ml/models/motionbert.py`)와 테스트가 이 경로를 쓴다.
4. 받은 뒤 크기·SHA256을 이 절에 적는다: `(미기록)`
5. 확인: `python -m pytest ml/tests/test_motionbert.py` — 파일이 있으면 `test_real_weights_key_mismatch_zero`가 건너뛰지 않고 돈다(몸통 키 누락 0개, 남는 키는 원래 3D 출력 머리 `head.*`뿐).
- 파일은 외부에서 받은 것이므로 `torch.load(..., weights_only=True)`로만 읽는다.

## 단계별 실험 실행 (`ml/scripts/run_all.py`)

설정: `ml/configs/experiments.yaml`(단계별 학습률·배치·고정 epoch과 근거). 단계 순서:
`rules → small → mb_probe → mb_partial → mb_full → mb_full_lunge_plank`, 시드 0·1·2.

- 미리 보기: `python ml/scripts/run_all.py --dry-run` — 단계별 시작점과 학습·선택·평가 분할을 출력(아무것도 만들지 않음)
- 실행: `python ml/scripts/run_all.py` (일부만: `--stages small mb_probe`). 이미 끝난 단계·시드(`done.json`)는 건너뛴다.
- 가중치(`ml/weights/motionbert_lite.bin`)가 없으면 mb_* 단계는 무작위 몸통으로 돌지 않고 받는 법을 출력한 뒤
  `run_all_status.json`에 `skipped_no_weights`로 남기고 종료 코드 2로 끝난다. 가중치를 넣고 같은 명령을 다시 실행하면 mb_*만 이어서 돈다.
- 학습은 train, 조기 종료·체크포인트 선택은 val(스쿼트)로만. 런지·플랭크는 val이 없어 고정 epoch.
  test_ec3d·test_own은 학습이 끝난 뒤 한 번만 평가해 파일에만 쓰고 터미널에는 val만 찍는다.
- VRAM: 프로세스 상한 = 시작 때 남은 VRAM - `vram_margin_gib`(0.5GiB), 넘치면 OOM 예외(배치는 줄이지 않음), full 배치 16 이하·partial 32 이하(설정 검사에서 막음).
- 결과(git 제외): `ml/runs/<stage>/seed<k>/<운동>/metrics.json`, `seed<k>/metrics.json`, `<stage>/summary.json`, `ml/runs/run_all_status.json`

### 실행 시간과 VRAM 최대치 (RTX 4060 Ti 8GB, 2026-11-25)

시간은 학습·평가만(데이터 만들기 제외). VRAM은 `torch.cuda.max_memory_allocated`(괄호는 reserved).

| 단계 | 시드 3개 합계 시간 | VRAM 최대 |
|---|---|---|
| rules | 1.7초(node 규칙 판정) | - (GPU 안 씀) |
| small (스쿼트·런지·플랭크) | 15.2초 | 0.24GiB (0.68GiB) |
| mb_probe | 3289.0초 | 2.22GiB (3.73GiB) |
| mb_partial | 1035.6초 | 5.24GiB (5.54GiB) |
| mb_full (배치 12, R21) | 1612.8초 | 4.91GiB (6.21GiB) |
| mb_full_lunge_plank | 4007.0초 | 2.28GiB (5.77GiB) |

# 자세 오류 분류 파인튜닝 실험 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 공개 데이터(EC3D, Zenodo)로 MotionBERT 경량판을 단계별(머리만 → 일부 → 전체)로 파인튜닝해 스쿼트 자세 오류를 분류하고, 사용자 본인 녹화로 규칙 판정·처음부터 학습한 작은 모델과 비교한 결과 보고서를 남긴다. 런지·플랭크 머리를 덤으로 붙인다.

**Architecture:** `ml/` 아래 Python 패키지 `wom_ml`. 데이터 받기 → 관절 형식을 H36M 17점 2D로 통일 → 반복 단위 샘플(고정 길이, 오류별 이진 라벨, 분할) → 모델(작은 GRU / MotionBERT 몸통 + 운동별 머리) → 학습·평가 → 집계 보고서. 규칙 판정 비교는 `@wom/core` TS 코드를 esbuild로 묶어 node로 돌린다.

**Tech Stack:** Python 3.11 전용 venv(`ml/.venv`), PyTorch CUDA 12.x판, numpy, scikit-learn, pytest, gdown(EC3D Google Drive), MotionBERT(Walter0807/MotionBERT, Apache-2.0 코드), node 22 + esbuild 0.28.2(이미 저장소에 있음).

**Spec:** `docs/specs/2026-11-25-finetune-experiment-design.md` (2026-11-25 승인)

## Global Constraints

- 사용자에게 보이는 글, 보고서, 주석은 한국어(코드 식별자는 그대로).
- **실험용**: 결과 모델을 앱에 넣지 않는다. ONNX 변환·폰 측정 없음.
- **평가 오염 금지**: EC3D 피험자 4와 사용자 본인 녹화는 학습·검증·하이퍼파라미터 선택에 절대 쓰지 않는다. Zenodo 검증 분할은 사람 단위.
- **개인 데이터**: 사용자 본인 녹화는 `packages/core/test/fixtures/private/angle-test/`(git 제외)에서 읽기만 한다. 파생물은 git 제외 폴더(`ml/data/`, `ml/runs/`)에만. 보고서에는 집계 지표만, 원본 좌표·수치 금지. PC 밖으로 보내지 않는다.
- git 제외: `ml/.venv/`, `ml/data/`, `ml/runs/`, `ml/third_party/`, `ml/weights/`. 코드·설정·테스트·README만 커밋.
- 기존 Python/conda 환경은 건드리지 않는다(모두 CPU판 PyTorch). 전용 venv에 CUDA판 설치. 다운로드는 사용자 허락 범위(PyTorch·패키지, MotionBERT 코드·경량 가중치, EC3D, Zenodo)만.
- 공통 입력: H36M 17점 2D + 신뢰도, 반복당 고정 길이 `T = 64`, 사람 크기로 정규화(거리 절댓값 안 씀).
- 라벨(오류별 이진): 스쿼트 `kneeIn, shallow, feetWide, trunkLean` / 런지 `shallow, kneeOverToe` / 플랭크 `archedBack, hunchBack`. 주 지표는 스쿼트 `kneeIn`, `shallow`.
- 본인 녹화 정답(설계 3절): 무릎 모으기→kneeIn, 얕게 앉기→shallow, 바른 자세·무릎 앞으로·빨리 내려가기→모두 0, 뒤꿈치 들기→4칸 모두 0(공개 데이터에 뒤꿈치 라벨이 없어 '뒤꿈치' 칸은 만들지 않고, 그 반복은 나머지 4칸만 평가).
- EC3D 가상 카메라 투영 방향: 0°, 30°, 45°, 60°, 90°.
- 시드 3개(0, 1, 2)로 반복해 평균±표준편차.
- 8GB VRAM: 배치·혼합 정밀도로 맞춘다.

## Review Focus

1. **평가 오염** — 분할 함수가 EC3D 4번·본인 녹화를 학습 집합에 넣으면 즉시 예외. Task 4 테스트가 고정한다.
2. **좌우 반전 증강 시 라벨·관절 짝** — 좌우 반전하면 왼/오 관절 인덱스를 맞바꿔야 한다(그대로 두면 무릎 모임 신호가 깨짐). Task 4 테스트.
3. **관절 일부 없음(신뢰도 0, NaN)** — 변환·정규화가 NaN을 퍼뜨리지 않고 0과 신뢰도 0으로 채운다. Task 3 테스트.
4. **반복 길이가 아주 짧거나 긴 경우** — T=64로 다시 샘플링할 때 길이 1~2 프레임 반복은 버리고, 아주 긴 것도 깨지지 않음. Task 4 테스트.
5. **MotionBERT 가중치 없음** — 가중치 파일이 없으면 무작위 초기화로 조용히 돌지 말고 분명한 오류(경로 안내). Task 7 테스트.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `ml/README.md` | 환경 만들기, 데이터·가중치 받기, 실험 실행 순서 |
| `ml/requirements.txt`, `ml/setup_env.ps1` | 전용 venv와 패키지 |
| `ml/pytest.ini`, `ml/tests/` | 테스트 |
| `ml/wom_ml/paths.py` | 폴더 경로 상수 |
| `ml/scripts/fetch_data.py` | EC3D·Zenodo 받기, MotionBERT 클론 |
| `ml/wom_ml/skeleton.py` | H36M 17점 정의, 형식 변환(EC3D 25 3D, MediaPipe 33, Halpe 26), 투영, 정규화, 좌우 반전 |
| `ml/wom_ml/sources/ec3d.py`, `zenodo.py`, `own.py` | 데이터별 읽기 → 반복 단위 원시 샘플 |
| `ml/wom_ml/dataset.py` | 라벨 맞추기, 분할, 다시 샘플링, 증강, 캐시 |
| `ml/wom_ml/metrics.py` | 오류별 정밀도·재현율·F1, 잡음/오탐 개수 |
| `ml/rules/run_rules.ts` | `@wom/core` 규칙 판정을 본인 녹화에 돌려 JSON 출력 |
| `ml/wom_ml/models/small.py` | 방식 A(GRU) |
| `ml/wom_ml/models/motionbert.py` | MotionBERT 몸통 + 운동별 머리, 고정 모드 |
| `ml/wom_ml/train.py`, `ml/scripts/run_all.py` | 학습·평가, 전체 실험 |
| `ml/wom_ml/report.py` | 결과 표 → `docs/finetune-experiment-results.md` |

---

### Task 1: 전용 환경과 ml 골격

**Files:**
- Create: `ml/requirements.txt`, `ml/setup_env.ps1`, `ml/README.md`(환경 절만), `ml/pytest.ini`, `ml/wom_ml/__init__.py`, `ml/wom_ml/paths.py`, `ml/tests/test_env.py`
- Modify: `.gitignore`(ml 제외 폴더 5개)

**Interfaces:**
- Produces: `paths.ML_ROOT, DATA_RAW (ml/data/raw), DATA_PROC (ml/data/processed), RUNS (ml/runs), THIRD_PARTY (ml/third_party), WEIGHTS (ml/weights), PRIVATE_OWN (packages/core/test/fixtures/private/angle-test)` (모두 `pathlib.Path`, 저장소 루트 기준 절대 경로)

- [ ] **Step 1: 테스트** — `test_paths_are_inside_repo`(모든 경로가 저장소 루트 아래), `test_gitignore_excludes_ml_artifacts`(`.gitignore`에 5개 폴더), `test_torch_cuda`(torch import, `torch.cuda.is_available()`가 False면 `pytest.skip`이 아니라 실패 메시지 "CUDA판 PyTorch가 아님"으로 FAIL — 이 실험은 GPU가 전제)
- [ ] **Step 2: 실패 확인** — `ml/.venv/Scripts/python -m pytest ml/tests/test_env.py`(venv 없으면 먼저 Step 3)
- [ ] **Step 3: 환경** — `setup_env.ps1`: `py -3.11 -m venv ml/.venv` → pip로 `torch`를 CUDA 12.x 인덱스(`--index-url https://download.pytorch.org/whl/cu126`)에서, 나머지(`numpy scikit-learn pytest gdown tqdm pyyaml einops timm`)는 PyPI에서. requirements.txt에 버전 고정(설치된 버전으로). 기존 환경은 건드리지 않음.
- [ ] **Step 4: 통과 확인** — 3개 PASS, `torch.cuda.get_device_name(0)`에 "4060" 포함을 README에 적기
- [ ] **Step 5: 커밋** — `chore(ml): 파인튜닝 실험 전용 환경과 폴더 구조`

### Task 2: 데이터와 MotionBERT 받기

**Files:**
- Create: `ml/scripts/fetch_data.py`, `ml/tests/test_fetch.py`
- Modify: `ml/README.md`(데이터·가중치 절)

**Interfaces:**
- Produces: `fetch_zenodo(dest: Path) -> Path`(Zenodo API `https://zenodo.org/api/records/18859797`로 파일 목록을 받아 내려받고 압축 해제, 폴더 경로 반환), `fetch_ec3d(dest: Path) -> Path`(EC3D GitHub README의 Google Drive 폴더를 gdown으로), `fetch_motionbert(dest: Path) -> Path`(`git clone https://github.com/Walter0807/MotionBERT` 고정 커밋), `check_weights(path: Path) -> None`(경량판 사전학습 체크포인트가 있는지, 없으면 README 절을 가리키는 한국어 예외)
- 결과 위치: `ml/data/raw/zenodo/`, `ml/data/raw/ec3d/`, `ml/third_party/MotionBERT/`, `ml/weights/motionbert_lite.bin`(이름은 받은 파일명 그대로 두고 README에 기록)

- [ ] **Step 1: 테스트**(네트워크 없이) — `check_weights`에 없는 경로를 주면 `FileNotFoundError`이고 메시지에 "README"와 경로 포함, 있는 빈 파일이면 통과. `fetch_*`는 이미 받은 폴더가 있으면 다시 받지 않는다(가짜 폴더로 확인).
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현과 실제 받기** — 스크립트 실행. MotionBERT 경량판 사전학습 가중치는 저장소 README의 OneDrive 링크다. 자동으로 받을 수 없으면 **사용자에게 직접 받아 `ml/weights/`에 넣어 달라고 요청하고 멈춘다**(BLOCKED로 보고). 받은 파일의 크기·SHA256을 README에 적는다.
- [ ] **Step 4: 통과 확인** — 테스트 PASS, 세 폴더와 가중치 존재
- [ ] **Step 5: 커밋** — `feat(ml): EC3D·Zenodo·MotionBERT 받기 스크립트`(데이터는 커밋 안 함)

### Task 3: 관절 형식 통일 (H36M 17점 2D)

**Files:**
- Create: `ml/wom_ml/skeleton.py`, `ml/tests/test_skeleton.py`

**Interfaces:**
- Produces:
  ```python
  H36M = ["pelvis","r_hip","r_knee","r_ankle","l_hip","l_knee","l_ankle","spine","thorax","neck","head","l_shoulder","l_elbow","l_wrist","r_shoulder","r_elbow","r_wrist"]  # MotionBERT 순서
  FLIP_PAIRS: list[tuple[int,int]]  # 좌우 짝 인덱스
  def from_mediapipe33(xy: np.ndarray, vis: np.ndarray) -> np.ndarray   # (F,33,2),(F,33) -> (F,17,3) [x,y,conf]
  def from_halpe26(xy: np.ndarray, score: np.ndarray) -> np.ndarray     # (F,26,2),(F,26) -> (F,17,3)
  def from_ec3d25_3d(xyz: np.ndarray) -> np.ndarray                     # (F,25,3) -> (F,17,4) [x,y,z,1] (투영 전)
  def project(xyz17: np.ndarray, yaw_deg: float) -> np.ndarray          # 수직축 회전 뒤 정사영 -> (F,17,3)
  def normalize(seq: np.ndarray) -> np.ndarray                          # 골반 원점, 사람 크기(골반-목 거리 중앙값)로 나눔
  def flip(seq: np.ndarray) -> np.ndarray                               # x 부호 반전 + FLIP_PAIRS 교환
  ```
- 없는 점(pelvis, spine, thorax, neck, head)은 주변 점으로 계산(pelvis=두 엉덩이 중점, thorax=두 어깨 중점 등). EC3D 25점의 인덱스 의미는 받은 데이터와 EC3D 코드로 확인해 주석으로 남긴다.

- [ ] **Step 1: 테스트** — 합성 관절로: `from_halpe26`의 pelvis = 두 엉덩이 중점, `project(yaw=0)`과 `project(yaw=90)`에서 좌우 무릎 사이 x거리가 각각 최대/거의 0, `normalize` 뒤 골반 (0,0)·크기 1, `flip` 두 번이면 원래대로이고 한 번이면 l_knee↔r_knee 교환, **Review Focus 3**: 신뢰도 0·NaN 관절이 있어도 출력에 NaN 없음(0으로 채우고 conf 0)
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과**
- [ ] **Step 5: 커밋** — `feat(ml): 관절 형식을 H36M 17점 2D로 통일`

### Task 4: 반복 샘플, 라벨, 분할, 증강

**Files:**
- Create: `ml/wom_ml/sources/ec3d.py`, `ml/wom_ml/sources/zenodo.py`, `ml/wom_ml/sources/own.py`, `ml/wom_ml/dataset.py`, `ml/tests/test_dataset.py`

**Interfaces:**
- Consumes: Task 3 함수들, `paths`
- Produces:
  ```python
  @dataclass
  class Rep:
      source: Literal["ec3d","zenodo","own"]; exercise: Literal["squat","lunge","plank"]
      subject: str; seq: np.ndarray  # (F,17,3) 정규화 전
      labels: dict[str, int]         # 그 운동 머리의 오류 칸 전부
      meta: dict                      # own: {"file","index","group"} 등
  def load_ec3d(root: Path) -> list[Rep]          # 3D → 투영 전 Rep(yaw는 dataset에서)
  def load_zenodo(root: Path) -> list[Rep]
  def load_own(private_dir: Path) -> list[Rep]    # 아래 own 규칙
  def resample(seq: np.ndarray, T: int = 64) -> np.ndarray | None   # 프레임 3개 미만이면 None
  def split(reps: list[Rep]) -> dict[str, list[Rep]]  # keys: train, val, test_ec3d, test_own
  def build_arrays(reps, train: bool, yaws=(0,30,45,60,90), seed=0) -> tuple[np.ndarray, dict[str,np.ndarray], list[dict]]  # X (N,T,17,3), 운동별 라벨, meta
  HEAD_LABELS = {"squat": ["kneeIn","shallow","feetWide","trunkLean"], "lunge": ["shallow","kneeOverToe"], "plank": ["archedBack","hunchBack"]}
  ```
- own 규칙(설계 3절): `diag45-12.json`(lite 33점) 반복 1~4 정상, 5~8 kneeIn, 9~12 정상 / `diag45.json`·`side.json`·`front.json` 1~2 정상, 3~4 kneeIn, 5~6 정상 / `rtm-litebox-1.0.json`(Halpe26) 바닥 시각 `[6.9, 9.5, 12, 14.4, 21.8, 24.3, 26.7, 29.2, 36.9, 40, 43.1, 46.1, 49.4, 51.6, 53.7, 55.6, 58.6, 60.8, 63, 65.2]`초, 반복 구간 = 바닥 ±0.8초, 1~4 정상, 5~8 kneeIn, 9~12 뒤꿈치(4칸 모두 0, meta.group="heel"), 13~16 정상(meta.group="fast"), 17~20 shallow. lite 녹화의 반복 구간은 world 무릎 각도(양쪽 평균)가 145° 아래로 내려갔다 152° 위로 올라오는 구간, 바닥이 130° 미만인 것만(설계 10절 시험과 같은 규칙) — 녹화마다 찾은 반복 수가 위 개수와 다르면 예외.
- EC3D: 피험자 1~3 train, 4 test_ec3d. 시퀀스가 반복 여러 개면 반복으로 자르고, 아니면 시퀀스 하나를 한 샘플로(받은 데이터 보고 판단해 주석). Zenodo: 사람 단위 80/20으로 train/val(시드 고정).
- 증강(train만): yaw 5방향 투영(EC3D), 좌우 반전, ±10° 평면 회전, 0.9~1.1 크기, 0.8~1.2 속도.

- [ ] **Step 1: 테스트** — 합성 Rep으로: **Review Focus 1** `split`이 own을 test_own에만, EC3D subject "4"를 test_ec3d에만 두고, 사람이 train과 val에 겹치면 예외 / **Review Focus 2** 좌우 반전 증강 뒤 라벨 그대로이고 관절 짝이 바뀜 / **Review Focus 4** `resample` 길이 2 → None, 길이 500 → (64,17,3) / own 그룹 규칙: 가짜 20반복 입력에 대해 5~8 kneeIn=1, 17~20 shallow=1, 9~12 meta.group=="heel" / HEAD_LABELS 키 순서 고정
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과** + 실제 데이터로 `python -m wom_ml.dataset --summary` 실행해 소스·운동·분할별 개수와 라벨 분포를 출력(보고서 재료, 개인 원본 수치 없음)
- [ ] **Step 5: 커밋** — `feat(ml): 반복 샘플·라벨·분할·증강`

### Task 5: 지표와 규칙 판정 기준선

**Files:**
- Create: `ml/wom_ml/metrics.py`, `ml/tests/test_metrics.py`, `ml/rules/run_rules.ts`, `ml/rules/README.md`, `ml/scripts/rules_baseline.py`

**Interfaces:**
- Produces:
  ```python
  def per_error(y_true: np.ndarray, y_pred: np.ndarray, names: list[str]) -> dict[str, dict]  # 칸별 precision, recall, f1, tp, fp, fn
  def app_style(y_true, y_pred, names) -> dict  # "일부러 만든 오류 중 잡은 수/전체", "오류 없는 반복 중 잘못 지적한 수/전체"
  ```
  `run_rules.ts`: 입력 = own 반복 목록 JSON(파일, 반복 시각, Halpe26 또는 MediaPipe 프레임), 출력 = 반복별 `{kneeIn: 0|1, shallow: 0|1}`(core의 `computeSquatRepMetrics` + `judgeSquat`; MediaPipe 33점은 엉덩이 23/24·무릎 25/26·발목 27/28·뒤꿈치 29/30·엄지발가락 31/32를 Halpe 11/12·13/14·15/16·24/25·20/21 자리에 넣어 KpFrame으로). `kneeIn`은 judge의 kneeIn 또는 kneeInRelative, `shallow`는 depth.
  실행: `npx esbuild ml/rules/run_rules.ts --bundle --platform=node --outfile=ml/runs/rules/run_rules.cjs` 후 `node ml/runs/rules/run_rules.cjs <in.json> <out.json>`.
- [ ] **Step 1: 테스트** — `per_error` 손계산 예(tp2 fp1 fn1 → p 0.667 r 0.667), 빈 양성일 때 0으로 나누지 않음, `app_style` 예
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과** + `rules_baseline.py`로 test_own에 규칙 판정을 돌려 `ml/runs/rules/metrics.json` 생성
- [ ] **Step 5: 커밋** — `feat(ml): 오류별 지표와 규칙 판정 기준선`

### Task 6: 방식 A — 작은 모델 처음부터

**Files:**
- Create: `ml/wom_ml/models/small.py`, `ml/wom_ml/train.py`, `ml/tests/test_models.py`

**Interfaces:**
- Produces:
  ```python
  class SmallGRU(nn.Module):  # 입력 (B,T,17,3) -> 운동별 로짓 dict
      def __init__(self, heads: dict[str,int], hidden: int = 128): ...
      def forward(self, x, exercise: str) -> torch.Tensor  # (B, len(HEAD_LABELS[exercise]))
  def train_model(model, data: dict, cfg: dict, seed: int, out_dir: Path) -> dict  # 검증 손실로 조기 종료, 최종 지표 dict 반환(val, test_ec3d, test_own)
  ```
  손실은 오류 칸별 BCE. 임계값 0.5. 학습은 train만, 조기 종료는 val만으로.
- [ ] **Step 1: 테스트** — 출력 형태, 작은 무작위 배치 20개를 몇백 step에 외울 수 있음(손실 감소), `train_model`이 test 분할을 학습에 쓰면 안 됨(가짜 데이터에 test 표식 넣고 학습 루프가 접근하면 예외)
- [ ] **Step 2~4** → 실제 학습(스쿼트, 시드 0·1·2) → `ml/runs/small/seed*/metrics.json`
- [ ] **Step 5: 커밋** — `feat(ml): 방식 A 작은 GRU 모델과 학습 루프`

### Task 7: MotionBERT 몸통과 운동별 머리

**Files:**
- Create: `ml/wom_ml/models/motionbert.py`, `ml/tests/test_motionbert.py`

**Interfaces:**
- Consumes: `ml/third_party/MotionBERT`(DSTformer, lite 설정), `ml/weights/` 체크포인트
- Produces:
  ```python
  class MotionBertClassifier(nn.Module):
      def __init__(self, heads: dict[str,int], weights: Path | None, freeze: Literal["probe","partial","full"], partial_blocks: int = 2): ...
      def forward(self, x, exercise: str) -> torch.Tensor   # 몸통 특징을 시간·관절 평균 풀링 → 운동별 선형 머리
      def trainable_parameters(self) -> list[nn.Parameter]
  ```
  probe: 몸통 전부 고정 / partial: 마지막 `partial_blocks`개 블록만 학습 / full: 전부 학습(몸통 학습률은 머리의 1/10). 입력 길이 64를 MotionBERT가 받는 형태(B,T,17,3)로.
- [ ] **Step 1: 테스트** — `weights=None`이면 테스트용으로만 무작위 초기화 허용하고, **Review Focus 5** 실험 경로(`weights` 경로 지정)에서 파일이 없으면 FileNotFoundError(README 안내 포함) / probe일 때 학습 가능 파라미터는 머리뿐, partial은 머리+마지막 블록, full은 전부 / 출력 형태(스쿼트 4, 런지 2, 플랭크 2) / 실제 가중치 로드 시 키 불일치가 0개(또는 머리 키만)
- [ ] **Step 2~4**
- [ ] **Step 5: 커밋** — `feat(ml): MotionBERT 몸통과 운동별 머리, 고정 모드`

### Task 8: 단계별 파인튜닝과 런지·플랭크 머리

**Files:**
- Create: `ml/scripts/run_all.py`, `ml/configs/experiments.yaml`, `ml/tests/test_run_all.py`

**Interfaces:**
- Consumes: Task 4~7
- Produces: `ml/runs/<stage>/seed<k>/metrics.json` (stage ∈ `rules, small, mb_probe, mb_partial, mb_full, mb_full_lunge_plank`)
- 순서: 스쿼트로 probe → partial(probe 머리에서 시작) → full(partial에서 시작), 시드 0·1·2. 그다음 mb_full 몸통을 고정하고 런지·플랭크 머리만 EC3D 피험자 1~3으로 학습, 피험자 4로 평가.
- [ ] **Step 1: 테스트** — `--dry-run`이 단계 목록과 각 단계가 읽는 분할을 출력하고, 어떤 단계도 test_own·test_ec3d로 학습하지 않음을 확인 / 단계 이어받기(partial이 probe 체크포인트를 읽는지) / 이미 끝난 단계는 건너뜀
- [ ] **Step 2~4** → 전체 실행(GPU). 실행 시간과 VRAM 최대치를 README에 기록
- [ ] **Step 5: 커밋** — `feat(ml): 단계별 파인튜닝 실행과 런지·플랭크 머리`

### Task 9: 결과 보고서

**Files:**
- Create: `ml/wom_ml/report.py`, `ml/tests/test_report.py`, `docs/finetune-experiment-results.md`
- Modify: `ml/README.md`(전체 실행 순서 완성)

**Interfaces:**
- Consumes: `ml/runs/**/metrics.json`
- Produces: `render_report(runs: Path) -> str`(마크다운). 표 1: 스쿼트 본인 녹화(test_own) — 방법별 kneeIn·shallow F1(평균±표준편차), 앱 방식 잡음/오탐. 표 2: EC3D 피험자 4 — 스쿼트 4칸, 런지 2칸, 플랭크 2칸. 데이터 개수 표(소스·분할별). 
- [ ] **Step 1: 테스트** — 가짜 metrics로 표가 만들어짐, 시드 평균±표준편차 계산, **개인 원본 좌표·프레임 값이 출력에 들어가지 않음**(가짜 metrics에 좌표 필드를 넣어도 출력에 없음)
- [ ] **Step 2~4** → 실제 보고서 생성. 그 아래에 사람이 쓴 해석 절: 단계별로 무엇이 달라졌는지, 규칙 판정과 비교, 45도 각도 차이 영향, 런지·플랭크 머리 결과, 한계(본인 녹화 약 50회, EC3D 4명, 실험용 가중치 라이선스), 다음에 할 것(FLEX·Fitness-AQA 승인 뒤 데이터 추가, 앱 내보내기 데이터로 재평가).
- [ ] **Step 5: 커밋** — `docs: 파인튜닝 실험 결과 보고서`

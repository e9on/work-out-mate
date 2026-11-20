# Work Out Mate — MVP 설계 보고서

- 작성일: 2026-11-18
- 상태: 승인됨(2026-11-18), Phase 0 진행
- 변경(2026-11-18): PC 앱 포장을 Tauri에서 Electron으로 바꿨다. 사유: Tauri는 Rust와 MSVC C++ 빌드 도구(수 GB) 설치가 필요하고, WebView2 카메라 권한 동작이 불확실했다. 이 PC의 Chromium(Chrome)에서 카메라와 한국어 음성(Microsoft Heami)이 이미 동작하는 것을 확인했다.
- 근거: `초기 기획.docx`(2026-11-11), 초기 개발 지침, 2026-11-18 대화, 같은 날 웹 조사

표기: **[확정]** 사용자가 정한 것 / **[제안]** 설계자가 정한 것(바꿀 수 있음) / **[확인 필요]** 아직 검증하지 않은 것

---

## 0. 왜 만드는가

집에서 홈트를 하다 보면 방금 몇 회를 했는지, 쉬는 시간을 지키고 있는지 헷갈린다(기획 배경).
그래서 MVP는 **카메라가 운동 횟수를 세고, 쉬는 시간 초를 세어 주는 것**에 집중한다.
자세 오류 분석, 자체 ML 모델, 영상 녹화·다시 보기, 교정 리포트는 MVP 다음 단계다.

## 1. 범위

### MVP 운동 [확정: 2026-11-18 사용자 결정]
1. 푸시업
2. 덤벨 벤치프레스
3. 스쿼트
4. 턱걸이 — 세 가지 방식
   - 매달리기(dead hang): 횟수가 아니라 **버틴 초**를 센다
   - 네거티브: 위에서 천천히 내려오는 동작의 횟수 + 내려온 시간
   - 턱걸이: 횟수

초기 지침의 런지·덤벨 컬·숄더 프레스는 MVP에서 빼고 이후 단계에서 다시 검토한다.

### 목표 (MVP) [확정: B안 "루틴 전체"]
1. 루틴 설정 화면: 운동을 고르고 운동별 세트 수, 목표(횟수 또는 초), 쉬는 시간을 정한다.
2. 사용자가 이름 붙인 루틴(예: "푸시데이", "풀데이", "하체데이")을 여러 개 만들고, 앱을 열면 오늘 할 루틴을 안내한다. [확정: 2026-11-18 사용자 결정]
3. 운동 중 카메라로 횟수를 세고 화면과 음성으로 알린다.
4. 목표 횟수를 채우거나 사용자가 세트 종료를 알리면 쉬는 시간 카운트다운을 시작한다.
5. 쉬는 시간 마지막 20초에 다음 운동(또는 다음 세트)을 안내한다.
6. 루틴이 끝나면 그날 기록(세트별 횟수, 운동 시간, 실제 쉰 시간)을 기기에 저장하고 보여 준다.

### 비목표 (MVP 이후)
- 자세 오류 판정·교정 안내, 운동 품질 점수
- 운동 영상 녹화·저장·다시 보기
- 자체 PyTorch 모델 (MVP 카운팅은 규칙 기반)
- 머리 위 박수 같은 제스처로 시작/종료 [제안: MVP는 화면 버튼·키보드·목표 횟수 자동 종료로 대신한다. 이유: 운동 동작과 구분하고 오인식을 막는 별도 작업이 필요하다]
- iOS [확정: 아이폰이 없어 검증할 수 없으므로 나중에 추가]
- 기기 간 동기화, 계정, 서버

### 안티 목표 (이렇게 되면 기능이 돌아가도 실패)
- 운동 중에 횟수가 헛돌거나(가만히 있는데 올라감) 자주 빠져서 결국 사용자가 직접 세게 되는 것
- 영상·관절 좌표가 기기 밖으로 나가는 것
- PC 전용 코드가 공통 로직에 섞여 Android·iOS 추가 때 다시 짜야 하는 것

## 2. 제약
- 서버·클라우드 없음. 추론·저장 모두 기기 안 [확정]
- PC(Windows)와 Android는 독립 실행, **데이터** 저장소도 따로(기기 간 동기화 없음) [확정]. 코드는 git 저장소 하나(모노레포: 공통 웹앱 + Electron `electron/` + Capacitor `android`)로 관리한다 [제안]
- 개발 PC는 Windows. Mac 없음 → iOS 빌드 불가 (iOS 단계에서 Mac 또는 클라우드 macOS 빌드 필요)
- 근거 없이 라이브러리·모델을 확정하지 않고, 검증하지 않은 성능 수치를 쓰지 않는다 (지침 8)

## 3. 만드는 방식 (Approaches)

| 안 | 내용 | 장점 | 단점 |
|---|---|---|---|
| **A. 웹 코드 + 앱 포장 [확정]** | TypeScript 웹앱 하나를 Capacitor로 감싸 Android, Electron으로 감싸 PC. iOS는 나중에 Capacitor로 | 화면·로직을 한 번만 만든다. iOS 추가 비용이 가장 작다. 느리면 자세 인식만 네이티브 플러그인으로 교체 가능 | WebView 안에서 자세 인식 속도 미검증. 음성·카메라 권한이 플랫폼마다 다르게 동작 |
| B. Flutter | Dart로 화면, 플랫폼 채널로 MediaPipe 네이티브 SDK 연결 | 모바일 성능이 유리할 수 있음 | Windows용 공식 MediaPipe Tasks SDK가 없어 PC를 따로 연결해야 함. iOS 때 연결 코드 재작성 |
| C. 플랫폼별 네이티브 | PC Python, Android Kotlin, iOS Swift | 성능 최고 | 화면·로직을 세 번 만들고 카운팅 결과를 계속 맞춰야 함 |
| (제외) PWA만 | 브라우저에서 바로 실행 | 설치 불필요 | 사용자가 Android·iPhone은 앱으로 만들기로 결정 |

A안을 고른 이유: MVP에서 일이 가장 많은 부분은 루틴·타이머 화면이다. 화면을 한 번만 만드는 방법은 A안뿐이다. 자세 인식이 느릴 때도 그 부분만 바꿔 끼울 수 있다.

## 4. 기술 아키텍처

```
┌────────────────────────── 공통 웹앱 (TypeScript) ──────────────────────────┐
│  UI 화면: 홈(N일차) · 루틴 설정 · 운동 중 · 쉬는 시간 · 결과/기록            │
│                                                                           │
│  core (플랫폼 무관, 순수 TS, 단위 테스트 대상)                               │
│   ├ pose/       랜드마크 정규화 · 관절 각도 · 스무딩 · 가시성 판정           │
│   ├ exercises/  운동별 정의(사용 관절, 상태 기계, 임계값, 카메라 방향)       │
│   ├ counter/    상태 기계 기반 반복 확정                                     │
│   ├ session/    루틴 진행 엔진(세트 → 쉬는 시간 → 다음 운동, 타이머)          │
│   └ records/    기록 모델                                                    │
│                                                                           │
│  ports (인터페이스)                                                         │
│   PoseSource · Speech · Storage · KeepAwake · Clock                        │
└───────────────────────────────────────────────────────────────────────────┘
        │ 구현(adapters)                          │
 ┌──────┴───────────────┐               ┌─────────┴─────────────────┐
 │ Android (Capacitor 8) │               │ PC (Electron 45, Chromium)│
 │ PoseSource: MediaPipe │               │ PoseSource: MediaPipe 웹  │
 │   웹(WebView) → 느리면│               │ Speech: speechSynthesis   │
 │   네이티브 SDK 플러그인│              │ Storage: main SQLite      │
 │ Speech: TTS 플러그인  │               │                           │
 │ Storage: SQLite 플러그인│             │                           │
 │ KeepAwake: 플러그인   │               │                           │
 └───────────────────────┘               └───────────────────────────┘
 (나중) iOS: Capacitor iOS + 같은 ports
```

설계 원칙
- `core`는 DOM·Capacitor·Electron을 import하지 않는다. 입력은 "시각 + 33개 랜드마크(+visibility)"뿐이다. 그래서 녹화한 랜드마크 파일로 PC에서 테스트를 돌릴 수 있다.
- `PoseSource`는 "프레임 → `{timestampMs, landmarks[33], worldLandmarks[33]}`" 형식만 내보낸다. 웹 MediaPipe든 네이티브 플러그인이든 같은 형식이다.
- 저장소는 `Storage` 포트 뒤에 둔다. [제안] Android는 Capacitor SQLite 플러그인, PC(Electron)는 main 프로세스 SQLite를 쓴다. 이유: 기록이 쌓이는 구조이고, IndexedDB보다 앱 삭제 전까지 보관이 확실하다.
- 웹앱 파일(MediaPipe wasm·모델 포함)은 앱 안에 번들한다. 실행 중 네트워크를 쓰지 않는다.

## 5. 기술 스택과 선정 이유

| 영역 | 선택 | 이유 / 근거 | 상태 |
|---|---|---|---|
| 언어 | TypeScript | 세 플랫폼 공통 코드 | [확정] |
| 빌드 | Vite | Capacitor·Electron 둘 다 정적 웹 산출물을 감싼다 | [제안] |
| UI 프레임워크 | React | 자료·플러그인 예제가 가장 많음. 빌더가 바꿔도 됨 | [제안] |
| 자세 인식 | `@mediapipe/tasks-vision` PoseLandmarker 1.2.x | 공식 웹판 존재. 33 랜드마크 + world 좌표 + visibility/presence 제공 | [확정 방향] / 속도 [확인 필요] |
| 모델 | pose_landmarker **lite** 부터 | 속도 우선. full/heavy와 Phase 0에서 비교 | [제안] |
| Android 포장 | Capacitor 8.x | getUserMedia 카메라 권한을 Capacitor가 처리(`BridgeWebChromeClient`) | 문서 확인됨, 실기기 [확인 필요] |
| PC 포장 | Electron 45 (`@electron/packager`) | Chromium을 같이 담아 카메라·`speechSynthesis`가 Chrome과 같게 동작. `app://` 프로토콜로 dist를 서빙, 외부 요청 전부 차단. 폴더 약 400MB | 자동 점검 통과, 실카메라는 [확인 필요] |
| 음성 (Android) | `@capacitor-community/text-to-speech` | Android WebView는 Web Speech API 미지원(MDN) | 확인됨 |
| 음성 (PC) | `speechSynthesis` (Electron의 Chromium) | Windows 한국어 음성 Microsoft Heami가 목록에 잡히는 것을 확인(자동 점검). 실제 발음은 사용자 확인 | 확인됨(목록), 발음 [확인 필요] |
| 저장 | Capacitor SQLite 플러그인 / Electron은 main 프로세스 SQLite(구현은 해당 단계에서 결정) | 위 4절 | [제안] |
| 화면 꺼짐 방지 | `@capacitor-community/keep-awake` | 운동 중 화면 꺼짐 방지 | 확인됨 |
| 테스트 | Vitest (core 단위 테스트, 녹화 랜드마크 재생 테스트) | | [제안] |
| (나중) ML 학습 | Python + PyTorch, `torch.onnx.export`(dynamo 기본) | 지침 | 이후 단계 |
| (나중) ML 추론 | ONNX Runtime Web (wasm, 되면 WebGPU) | 공통 코드 유지. Android 네이티브(ORT Mobile / LiteRT)는 웹이 부족할 때 비교 | 이후 단계 |

정확한 버전은 Phase 0에서 고정하고 lockfile로 관리한다. 참고로 조사 시점(2026-11-18) 최신 버전은 tasks-vision 1.2.3, Capacitor 8.6.2(9.0 RC 존재)였다. PC 포장은 Electron 45.2.2로 고정했다.

알아 둘 점
- 웹판 PoseLandmarker는 VIDEO 모드(동기 `detectForVideo`)만 있고 LIVE_STREAM이 없다. 그래서 프레임 루프에서 추론이 밀리면 이전 프레임을 건너뛰는 처리를 직접 해야 한다. [제안] 추론을 Web Worker로 옮길 수 있는지 Phase 0에서 확인한다.
- 네이티브 MediaPipe Android SDK는 minSdk 28(Android 9)을 요구한다. 플러그인으로 바꾸면 앱 최소 버전이 28로 올라간다.
- tasks-vision 1.2.x 릴리스 노트의 "app telemetry" 항목이 외부로 데이터를 보내는지 확인해야 한다. 보낸다면 끈다. [확인 필요]

## 6. 횟수 세기 설계 (규칙 기반 baseline)

"각도가 임계값을 한 번 넘으면 +1"이 아니다. 운동별 상태 기계가 정상 순서를 다 돌았을 때만 1회를 확정한다.

공통 상태: `준비(서 있음/시작 자세)` → `내려감(또는 들어 올림)` → `최저점(또는 최고점)` → `복귀` → `완료(+1)` → `준비`
- **히스테리시스**: 들어가는 임계값과 나오는 임계값을 다르게 둬서 경계에서 떨리며 여러 번 세는 것을 막는다.
- **최소 유지 시간 / 최소 반복 시간**: 너무 짧은 전이는 버린다.
- **가시성 게이트**: 판정에 쓰는 관절의 visibility가 낮으면 상태를 멈추고 "카메라에 몸이 다 보이게 해 주세요"라고 안내한다.
- **스무딩**: 각도에 짧은 이동 평균 또는 One-Euro 필터 [제안].
- **좌우 선택**: 카메라에 더 잘 보이는 쪽(visibility 높은 쪽) 관절을 쓴다.

운동별 초안 (임계값은 숫자를 정하지 않는다. Phase 1에서 직접 찍은 영상으로 정한다)

| 운동 | 측정 | 주 신호 | 보조 확인 | 권장 카메라 방향 [제안] | 난이도 예상 |
|---|---|---|---|---|---|
| 스쿼트 | 횟수 | 무릎 각도(엉덩이-무릎-발목) | 엉덩이 높이 하강 | 측면 또는 45° | 낮음 |
| 푸시업 | 횟수 | 팔꿈치 각도 | 어깨 높이 하강, 몸이 일직선 | 측면, 바닥 근처 높이 | 높음 (누운 자세 인식, 카메라 위치) |
| 덤벨 벤치프레스 (양팔 동시 [확정]) | 횟수 | 팔꿈치 각도 | 손목이 어깨 위로 올라감, 양팔 대칭 | 측면, 벤치 높이 | 높음 (누운 자세 인식, 벤치·덤벨에 가림) |
| 턱걸이 | 횟수 | 팔꿈치 각도만으로 판별 [확정: 턱이 철봉을 넘었는지는 보지 않음] | — | 정면 또는 뒤, 철봉까지 화면에 들어오게 | 중간~높음 (세로로 긴 화면 구성) |
| 네거티브 | 횟수 + 내려온 초 | 팔꿈치 각도가 "굽힘 → 펴짐"으로 가는 구간 | 올라갈 때는 세지 않음(점프·발판으로 올라감), 내려오는 시간 측정 | 턱걸이와 같음 | 중간~높음 |
| 매달리기 | 버틴 초 | 손목이 머리 위, 팔꿈치 펴짐 상태 유지 | 상태가 깨지면(손 놓음) 타이머 멈춤 | 턱걸이와 같음 | 중간 (매달린 것과 그냥 팔 든 것 구분) |

**준비 자세 보정** [확정: 2026-11-18 사용자 결정] 스쿼트·푸시업·덤벨 벤치프레스는 고정 각도 대신 각자의 준비 자세를 기준으로 센다. 세트를 시작하면 먼저 준비 자세로 잠시(0.7초) 멈춰 서고, 그때 각도 평균을 기준으로 삼는다(그동안 화면에 "준비 자세를 잡아 주세요"). 바닥은 "기준보다 몇 도 더 굽힘", 복귀는 "이번 최저점보다 몇 도 다시 펴짐"으로 상대 판정한다. 실측에서 반복 사이 맨 위가 준비 자세보다 약 10° 덜 펴졌고, 카메라 각도·사람에 따라 각도 전체가 위아래로 밀렸기 때문이다. 3초 안에 준비 자세를 못 잡으면 운동별 기본 기준으로 시작한다. 턱걸이·네거티브는 고정 임계값을 유지한다. 값과 근거는 Phase 0 계획 Task 6b.

세트 종료 조건: 목표(횟수/초) 도달 → 자동 종료 / 사용자가 버튼으로 종료 / [제안] 일정 시간 움직임이 없으면 "세트를 끝낼까요?" 안내. 매달리기는 손을 놓으면 세트가 끝난다.

[확인 필요] 푸시업·벤치프레스는 몸이 누운(수평) 자세다. MediaPipe 포즈 검출이 누운 자세에서 서 있는 자세만큼 안정적인지 공식 자료로 확인하지 못했다. Phase 0에서 직접 확인한다.
[확인 필요] 매달리기에서 "발이 바닥에서 떨어졌는지"는 카메라로 판단하기 어렵다. [제안] 손목이 머리 위 + 팔꿈치 펴짐 + 시작 버튼 이후로 판단하고, 오인식이 많으면 발목 높이 변화를 보조 신호로 추가한다.

## 7. 루틴 진행 설계

- 루틴 = 순서 있는 운동 목록. 운동마다 `세트 수, 목표 횟수, 쉬는 시간(초)`.
- 진행: `운동 안내 → 준비 확인(몸이 보이는지) → 세트 → 쉬는 시간 → (마지막 20초에 다음 안내) → …`
- 운동 사이 쉬는 시간도 같은 타이머를 쓴다. [제안] 운동 사이 쉬는 시간 값은 "다음 운동의 쉬는 시간"을 그대로 쓰고, 따로 둘지는 사용자 피드백으로 정한다.
- 음성 안내: 횟수마다 숫자, 세트 시작/끝, 쉬는 시간 10초 단위 + 마지막 5초, 마지막 20초에 다음 운동 이름.
- **이름 붙인 루틴** [확정]: 루틴마다 사용자가 이름을 정한다(예: 푸시데이, 풀데이, 하체데이). 루틴은 여러 개를 만들 수 있다.
  - [제안] 루틴 목록에는 순서가 있다. 홈 화면은 "마지막으로 끝낸 루틴의 다음 차례"를 오늘의 루틴으로 추천하고, 사용자는 다른 루틴을 골라도 된다. 추천은 끝까지 마친 세션 기준이며, 중간에 그만둔 세션은 차례를 넘기지 않는다.
  - [제안] 홈 화면에 루틴별 누적 횟수("하체데이 5번째")를 함께 보여 준다.
- 타이머는 `Clock` 포트를 써서 테스트에서 시간을 조작할 수 있게 한다.

## 8. 데이터

### 8.1 저장 (MVP)
- `routines`: 이름, 순서, 운동 목록(운동, 세트 수, 목표 횟수, 쉬는 시간)
- `workout_sessions`: 날짜, 루틴, 시작/끝 시각, 끝까지 마쳤는지 여부
- `set_logs`: 운동, 세트 번호, 목표 종류(횟수/초), 목표값, 실제 횟수, 버틴 초(매달리기), 반복별 내려온 초(네거티브), 세트 시간, 실제 쉰 시간, 종료 방식(자동/수동)
- 영상·랜드마크는 MVP에서 저장하지 않는다. 단 **개발용 빌드**에는 랜드마크 녹화 기능을 두어 카운터 테스트 데이터를 만든다(본인 데이터만, 로컬 파일).

### 8.2 공개 데이터셋 분석 (조사 결과 요약)

| 데이터셋 | 5종과 겹침 | RGB | 라벨 | 라이선스 | 판단 |
|---|---|---|---|---|---|
| UI-PRMD | 스쿼트(deep squat), 런지 비슷한 동작(inline lunge, 일반 런지와 같은지 확인 필요) | 없음 (Vicon, Kinect 22관절) | 정상/오류, 10회 단위 분할 | PDDL(퍼블릭 도메인) | 규칙·카운팅 참고용. **공식 페이지 404, 다운로드 경로 확인 필요** |
| KIMORE | 스쿼트(재활용) | 있음 (Kinect v2) | 임상 점수 | 명시 없음, 문의 필요 | 스쿼트 품질 검증 참고용 |
| NTU RGB+D 60/120 | 사실상 없음 ("squat down"은 일상 동작) | 있음 | 동작 클래스만 | 학술·비상업 전용, **개인 프로젝트 신청 불가** | **제외** |
| InfiniteRep (추가) | 스쿼트·푸시업·덤벨 컬·오버헤드 프레스 | 있음(합성) | 프레임별 반복 횟수 | CC BY 4.0 표기는 미러에서만 확인, 공식 배포처 404 | 카운팅 검증에 가장 적합. **라이선스 확인 필요** |
| Fitness-AQA (추가) | 스쿼트, 바벨 오버헤드 프레스 | 있음 | 오류 7종 프레임 주석 | 비상업 전용 | 연구용 오류 판별 참고만 |
| RepCount (추가) | 스쿼트 확인, 나머지 확인 필요 | 있음(YouTube) | 반복 시작/끝 | 명시 없음 | 참고만 |

결론
- MVP(규칙 기반 카운팅)는 공개 데이터셋이 **없어도** 만들 수 있다. 검증은 직접 찍은 영상으로 한다.
- MVP 운동 기준으로 보면: 스쿼트는 여러 곳에 있고, 푸시업은 InfiniteRep(합성)에 있다. 턱걸이는 RepCount에 pull-up 클래스가 있다. 덤벨 벤치프레스, 매달리기, 네거티브가 들어 있는 공개 데이터는 이번 조사에서 찾지 못했다.
- ML 단계에서는 자체 수집이 주 데이터가 된다.
- 상업 서비스로 갈 경우 쓸 수 있는 것은 현재 UI-PRMD뿐(그나마 RGB 없음). 나머지는 라이선스 확인 전 학습에 쓰지 않는다.
- 출처 URL은 부록 A.

### 8.3 데이터 수집 계획 (Phase 2, MVP 이후)
1. **동의**: 참여자별 서면 동의(촬영 목적, 보관 기간, 삭제 요청 방법). 원본 영상은 암호화 저장소 한 곳에만 보관.
2. **촬영 규칙**: 운동별 권장 카메라 방향·거리·높이, 해상도·FPS 고정, 조명 메모.
3. **수집 단위**: 참여자 약 10명 × 5종 × 3세트 이상 × 8~12회, 정상 + 의도된 오류 동작. 이 수치는 시작점이며 충분하다는 보장이 아니다.
4. **자동 추출**: 오프라인 스크립트로 MediaPipe 랜드마크를 뽑는다. **앱과 같은 모델 파일·같은 런타임 계열을 쓴다.** Python판과 웹판의 좌표가 같다는 공식 보장이 없으므로 둘을 비교하는 검증을 먼저 한다.
5. **라벨링**: 반복 시작/끝 프레임, 단계(내려감/최저점/복귀), 오류 유형(운동별 유효한 것만). 도구는 Phase 2 시작 때 고른다.
6. **검수**: 두 번째 사람이 표본을 다시 라벨링해 일치율을 본다.
7. **분할**: 사용자 단위 Train/Val/Test. 같은 사람이 두 쪽에 들어가지 않는다.
8. **버전 관리**: 원본·랜드마크·라벨·분할 목록에 버전을 붙이고, 추출 스크립트 버전과 모델 파일 해시를 함께 기록한다.

## 9. ML 모델 개발 계획 (Phase 3, MVP 이후)
- 비교 대상: 규칙 기반 baseline(= MVP 카운터), GRU/LSTM, 1D CNN, TCN. 처음부터 하나로 정하지 않는다.
- 입력: 정규화 랜드마크 + 관절 각도 + 속도 시계열. 특징 추출 코드는 TS `core`와 Python이 같은 결과를 내는지 테스트로 묶는다(같은 테스트 벡터 공유).
- 평가: 상태 분류 Macro F1, 카운팅 MAE, 오류별 Precision/Recall/F1, 처음 보는 사용자 성능, 기기별 FPS·지연·메모리.
- 배포: PyTorch → ONNX(dynamo 경로) → ONNX Runtime Web. 웹에서 부족하면 Android 네이티브 ORT Mobile vs LiteRT를 그때 비교.

## 10. 주요 기술적 위험과 대응

| # | 위험 | 대응 |
|---|---|---|
| 1 | WebView 안 MediaPipe 웹판 속도가 저사양 Android에서 부족할 수 있음 (공식 수치 없음, LIVE_STREAM 없음) | Phase 0에서 실기기 측정. 부족하면 PoseSource만 네이티브 Android SDK 플러그인으로 교체(minSdk 28) |
| 2 | 음성: Android WebView는 Web Speech 미지원, PC는 한국어 오프라인 음성 미확인 | Speech 포트로 분리. Android는 TTS 플러그인, PC는 speechSynthesis(Electron). 안 되면 main에서 Windows TTS 호출. 음성 없으면 비프음 + 큰 화면 숫자 |
| 3 | 오프라인 번들: wasm(약 14.7MB) + 모델을 로컬에서 불러오는 공식 예시 없음, 텔레메트리 항목 | Phase 0에서 비행기 모드로 실행 확인, 네트워크 요청 모니터링 |
| 4 | Windows 카메라 권한: OS 카메라 개인정보 스위치가 꺼져 있으면 Electron도 카메라를 못 연다 (WebView2 방식은 Electron 전환으로 해소) | 권한 거부·장치 없음 시 안내 화면, 설정 여는 방법 안내 |
| 5 | 운동별 카운팅 오작동 (푸시업·벤치프레스의 누운 자세, 벤치·덤벨 가림, 턱걸이의 세로 화면 구성) | 운동별 카메라 배치 안내 화면, 가시성 게이트, 녹화 랜드마크로 회귀 테스트 |
| 6 | Python판과 웹판 좌표 차이 | ML 단계 전에 같은 영상으로 비교 검증. 학습용 추출을 웹판 기준으로 맞추는 방안도 검토 |
| 7 | 공개 데이터 라이선스·접근 | 확인 전에는 학습에 쓰지 않음. 자체 수집을 주 데이터로 계획 |
| 8 | iOS 추가 시 Mac·개발자 계정 필요 | iOS 단계에서 결정. 무료 계정은 7일마다 재설치, 유료 연 99달러. 공통 코드에 Android 전용 API 금지로 대비 |

## 11. 단계별 로드맵

**Phase 0 — 검증 스파이크 (버리는 코드)**
- 기준 기기 [확정]: Android는 사용자 폰 갤럭시 S23(사용자가 "갤럭시 23"이라고 함, S23으로 해석), PC는 개발 PC 웹캠. S23은 고사양 기기라서 저사양 Android 성능은 MVP에서 검증하지 않는다(이후 단계 위험으로 남김).
- "WebView로 충분한가"의 판단 기준 [제안]: S23의 WebView에서 각 운동이 위 MVP 완료 기준을 통과하면 WebView를 유지한다. 통과하지 못하고 원인이 속도(프레임 누락)이면 PoseSource만 네이티브로 바꾼다.
- 누운 자세(푸시업·벤치프레스)에서 랜드마크가 안정적으로 잡히는지 S23으로 확인
- 갤럭시 S23과 Windows PC 웹캠에서 lite/full 모델 FPS·지연 측정 (Capacitor/Electron 안에서)
- 앱 번들 오프라인 로딩, 네트워크 요청 없음 확인
- 카메라 권한(양쪽), TTS 한국어(양쪽) 확인
- 결과로 "WebView 그대로 / 네이티브 플러그인" 결정, 버전 고정
- 완료 조건: 위 항목별 측정 결과와 결정이 이 문서에 기록됨

**Phase 1 — 카운터 코어**
- `core`의 pose·counter·exercises 구현, 녹화 랜드마크 재생 테스트
- 운동 순서 [제안]: 스쿼트 → 턱걸이(매달리기 → 턱걸이 → 네거티브) → 푸시업 → 덤벨 벤치프레스 (쉬운 것부터, 누운 자세는 Phase 0 결과를 보고)
- 본인 영상으로 운동별 임계값 결정, 손으로 센 값과 비교한 오차 기록

**Phase 2 — 루틴 앱 (MVP 완성)**
- 루틴 설정, N일차, 운동 중/쉬는 시간 화면, 음성, 기록 저장·조회
- Android 앱 + PC 앱 빌드
- MVP 완료 기준 [확정]: 기준 기기(갤럭시 S23)와 PC 웹캠에서, 직접 찍은 10회 세트마다 손으로 센 횟수와 **±1회 이내**. 매달리기는 실제 버틴 시간과 **±1초 이내**. 네거티브는 횟수 기준만 적용하고 내려온 초는 참고값으로 기록한다. 운동마다 이 기준으로 통과/보류를 판정한다.

**Phase 3 — 데이터 수집 + 영상 녹화**
- 8.3절 파이프라인, 앱에 영상 저장(사용자 선택) 추가

**Phase 4 — ML 모델 + 자세 오류 분석**

**Phase 5 — iOS 추가**

## 12. 빌더에게 맡기는 것
- 폴더 구조 세부, 상태 관리 방식, 화면 디자인
- 스무딩 필터 종류와 파라미터, 운동별 임계값(근거 기록 필수)
- 라벨링 도구 선택(Phase 2 이후)

## 13. 확인 필요 목록 (요약)
- MediaPipe 웹판 FPS (갤럭시 S23 WebView, PC Electron)
- 누운 자세(푸시업·벤치프레스) 랜드마크 안정성
- 매달리기와 그냥 팔 든 자세 구분
- tasks-vision 오프라인 로딩 절차, 텔레메트리 여부
- Electron 앱의 카메라 권한 동작(실카메라)
- PC 한국어 TTS 오프라인 음성
- UI-PRMD 다운로드 경로, KIMORE·InfiniteRep·RepCount 라이선스
- Python판·웹판 MediaPipe 좌표 일치 여부

## 부록 A. 주요 출처
- MediaPipe Pose Landmarker: https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker , 웹: https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js , Android 설정: https://developers.google.com/edge/mediapipe/solutions/setup_android
- Capacitor Android: https://capacitorjs.com/docs/android , 카메라 권한 처리 소스: https://github.com/ionic-team/capacitor/blob/main/android/capacitor/src/main/java/com/getcapacitor/BridgeWebChromeClient.java
- SpeechSynthesis 호환표: https://github.com/mdn/browser-compat-data/blob/main/api/SpeechSynthesis.json , TTS 플러그인: https://github.com/capacitor-community/text-to-speech
- Electron: https://www.electronjs.org/docs/latest/ (protocol, session 권한 핸들러), 폐기된 Tauri 검토 자료: https://v2.tauri.app/blog/tauri-2.12/
- ONNX Runtime Web: https://onnxruntime.ai/docs/tutorials/web/ , LiteRT: https://developers.google.com/edge/litert , PyTorch ONNX: https://docs.pytorch.org/docs/2.15/onnx.html
- MediaPipe JS/Python 차이 이슈: https://github.com/google-ai-edge/mediapipe/issues/5402
- Apple 멤버십 비교: https://developer.apple.com/support/compare-memberships/
- UI-PRMD: https://pmc.ncbi.nlm.nih.gov/articles/PMC5773117/
- KIMORE: https://www.pubmed.gov/31217121/ , https://arxiv.org/html/2403.02772v1
- NTU RGB+D: https://rose1.ntu.edu.sg/dataset/actionRecognition/
- Fitness-AQA: https://github.com/ParitoshParmar/Fitness-AQA , RepCount: https://svip-lab.github.io/dataset/RepCount_dataset.html , InfiniteRep(미러): https://paperswithcode2.com/dataset/5605

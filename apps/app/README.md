# Work Out Mate 루틴 앱 (`apps/app`)

React + Vite 웹 앱을 Capacitor로 감싼 Android 앱이다(앱 id `com.workoutmate.app`, 시험용 앱 `com.workoutmate.spike`와 함께 설치된다). 같은 웹 빌드를 Electron으로 감싼 Windows PC 앱도 있다(아래 "PC 앱" 절). 모든 명령은 저장소 루트에서 실행한다.

## 개발 서버

```bash
npm run dev -w apps/app
```

음성은 브라우저(Web Speech)로, 앱(Android)에서는 네이티브 TTS로 나온다(`Capacitor.isNativePlatform()`으로 고른다).

## 테스트와 점검

```bash
npm test -w apps/app            # vitest
npm run typecheck -w apps/app
npm run build -w apps/app       # 타입 검사 + vite build
```

## MediaPipe 자산 복사 (copy-wasm)

```bash
npm run copy-wasm -w apps/app
```

- wasm은 `node_modules/@mediapipe/tasks-vision/wasm`에서, 모델 `pose_landmarker_lite.task`는 `apps/spike/public/mediapipe/`에서 `apps/app/public/mediapipe/`로 복사한다. 인터넷에서 받지 않는다.
- 복사된 자산은 git에 넣지 않는다. 모델이 없으면 경고만 하고 넘어간다(빌드·테스트·CI는 통과하지만 실제 카메라 실행에는 모델이 필요하다). 모델은 시험용 앱의 "준비" 절차로 먼저 받아 둔다.

## Android 빌드

```bash
npm run android:build -w apps/app   # copy-wasm + 웹 빌드 + cap sync android
```

그다음 APK 빌드. JDK(Android Studio의 JBR)와 SDK 경로는 **그 명령에서만** 지정한다. Git Bash 기준:

```bash
cd apps/app/android
JAVA_HOME="C:/Program Files/Android/Android Studio/jbr" ANDROID_HOME="$LOCALAPPDATA/Android/Sdk" ./gradlew.bat assembleDebug
```

- APK 위치: `apps/app/android/app/build/outputs/apk/debug/app-debug.apk`
- 권한 검사: `bash scripts/check-apk-perms.sh apps/app/android/app/build/outputs/apk/debug/app-debug.apk` (CAMERA 있음, INTERNET 없음, allowBackup=false). CI도 같은 스크립트를 쓴다.
- 이 앱은 INTERNET 권한이 없어서 `cap run --live-reload`는 쓸 수 없다. 개발은 개발 서버(브라우저)로 한다.
- 기기 설치는 `adb install -r app-debug.apk` (adb는 `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`).
- git에는 `android/` 소스만 들어간다. `build/`, `.gradle/`, `local.properties`, 복사된 웹 자산(`app/src/main/assets/public`)은 제외된다.

## PC 앱 (Windows, Electron)

같은 웹 빌드(`dist/`)를 Electron 창에 `app://wom/` 주소로 띄운다. Electron·esbuild·@electron/packager는 모노레포 `node_modules`에 이미 있다.

### 실행

```bash
npm run copy-wasm -w apps/app       # MediaPipe 자산(wasm·lite 모델)이 없으면 먼저
npm run electron:dev -w apps/app    # 웹 빌드 + main/preload 번들 + 창 열기
```

- `electron:build`: `electron/`(main·preload) 타입 검사 후 esbuild로 `electron-dist/`에 번들한다. CI도 이 명령을 돌린다(CI는 Electron 바이너리를 받지 않아 실행은 하지 않는다).
- 이미 빌드했다면 `apps/app`에서 `npx electron .`만 해도 된다(`package.json`의 `"main": "electron-dist/main.cjs"`).

### 포장

```bash
npm run electron:pack -w apps/app   # 웹 빌드 + electron:build + Windows x64 폴더 포장
```

- 결과: `apps/app/out/WorkOutMate-win32-x64/WorkOutMate.exe`. 앱에는 `package.json`, `dist/`, `electron-dist/`만 들어간다.
- `out/`, `electron-dist/`는 git에 넣지 않는다.

### 보안 설정 요약

- 렌더러는 `contextIsolation`·`sandbox`를 켜고 Node를 끈다. preload는 `window.wom = { isElectron, selftest }`만 노출한다.
- `app://wom/` 요청은 `dist/` 안의 파일만 돌려준다(`..` 등으로 밖을 가리키면 403).
- `app:`, `blob:`, `data:` 외의 요청(http·https·ws 등)은 main이 전부 취소한다. 권한은 앱 origin의 카메라(video)만 허용한다(마이크·위치·알림 등은 거부).
- 새 창, 다른 origin으로의 이동·리다이렉트, webview, 다운로드는 모두 막는다. origin은 접두사가 아니라 정확히 비교한다.

### 자가 점검 (`WOM_SELFTEST=1`)

카메라 없이 PC 앱의 보안·자산을 자동으로 확인한다. 웹 빌드와 `electron:build` 뒤 `apps/app`에서 실행한다.

```bash
cd apps/app
WOM_SELFTEST=1 npx electron .
echo $?    # 0 통과, 1 실패, 2 시간 초과(60초)
```

- 렌더러(`src/selftest.ts`, 점검 모드에서만 동적 import)가 아래를 시도하고 결과를 콘솔로 보내면, main이 자기 네트워크 기록과 합쳐 판정한다.
  - CSP 위반(인라인 스크립트·eval·외부 이미지·외부 fetch)이 `securitypolicyviolation`으로 3건 이상 잡혀야 한다.
  - MediaPipe PoseLandmarker를 `app://` 자산으로 실제로 만든다.
  - 외부 요청이 모두 실패하고, 점검용 워커의 외부 요청이 main 차단 목록에 남아야 하며, 실제로 나간 외부 요청은 0건이어야 한다.
- 평소 실행에는 영향이 없다(`window.wom.selftest`가 false면 점검 코드를 불러오지 않는다).

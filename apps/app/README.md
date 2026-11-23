# Work Out Mate 루틴 앱 (`apps/app`)

React + Vite 웹 앱을 Capacitor로 감싼 Android 앱이다(앱 id `com.workoutmate.app`, 시험용 앱 `com.workoutmate.spike`와 함께 설치된다). 모든 명령은 저장소 루트에서 실행한다.

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

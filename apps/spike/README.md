# 스파이크 앱 (Phase 0 검증용, 버리는 코드)

MediaPipe Pose Landmarker 웹판의 속도·정확도를 PC 웹캠과 폰에서 재고, 랜드마크를 녹화한다.

## 준비 (최초 1회)

모델과 wasm은 용량 때문에 git에 없다. 저장소 루트에서:

```bash
npm install
npm run copy-wasm -w apps/spike        # node_modules의 wasm을 public/mediapipe/wasm/ 로 복사
cd apps/spike/public/mediapipe
curl -fLO https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task   # 5,777,746 바이트
curl -fLO https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task   # 9,398,198 바이트
```

## 실행

```bash
npm run dev -w apps/spike     # http://localhost:5173
npm run build -w apps/spike   # 타입 검사 + 번들
```

카메라는 localhost 또는 https에서만 켜진다. 녹화 파일은 `wom-<운동>-<모델>-<날짜>.json`으로 다운로드되고,
`npm run replay -w packages/core -- <파일>` 로 재생해 count를 비교한다.

## Android 시험용 앱 (Capacitor)

웹 앱을 Capacitor로 감싼 APK다(앱 id `com.workoutmate.spike`). 카메라·한국어 TTS·녹화 파일 저장(문서 폴더)·화면 켜짐 유지를 폰에서 확인한다.
모델과 wasm은 `dist`를 통해 APK 안에 들어가므로 인터넷 없이도 돈다. 위의 "준비"를 먼저 끝내야 한다.

```bash
npm run android:build -w apps/spike     # 웹 빌드 + android 폴더로 복사(cap sync)
```

APK 빌드는 JDK(Android Studio에 들어 있는 JBR)와 Android SDK 경로를 **그 명령에서만** 지정한다(시스템 환경 변수는 건드리지 않는다). Git Bash 기준:

```bash
cd apps/spike/android
JAVA_HOME="C:/Program Files/Android/Android Studio/jbr" ANDROID_HOME="$LOCALAPPDATA/Android/Sdk" ./gradlew.bat assembleDebug
# 결과: apps/spike/android/app/build/outputs/apk/debug/app-debug.apk
```

폰에 설치: 폰에서 개발자 옵션 → USB 디버깅 켜기, USB 연결 후 허용 → `adb install -r app-debug.apk`
(adb는 `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`). 앱에서 녹화하면 폰의 `Documents/` 폴더에 저장을 시도하고, 안 되면 앱 전용 폴더로 저장한다(HUD에 어느 쪽인지 표시).

앱 전용 폴더에서 PC로 꺼내기(디버그 APK에서만 가능):

```bash
adb exec-out run-as com.workoutmate.spike cat files/<파일명> > <파일명>
```

Windows PowerShell의 `>`는 출력을 문자열로 바꿔 깨질 수 있으니 Git Bash나 cmd에서 실행한다(JSON 텍스트라 대개 문제없지만 인코딩이 바뀔 수 있다).

이 앱은 AndroidManifest에 INTERNET 권한이 없다(네트워크 요청 0건을 OS 수준에서 보장). 그래서 `cap run --live-reload`는 쓸 수 없다. 개발은 `dev:lan`(브라우저)으로 한다.

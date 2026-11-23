#!/usr/bin/env bash
# APK 권한 검사: CAMERA 있음, INTERNET 없음, allowBackup=false.
# 사용법: scripts/check-apk-perms.sh <APK 경로>
set -euo pipefail

APK="${1:?사용법: check-apk-perms.sh <APK 경로>}"
if [ ! -f "$APK" ]; then
  echo "APK가 없어요: $APK"
  exit 1
fi

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$LOCALAPPDATA/Android/Sdk}}"
AAPT2=$(ls "$SDK"/build-tools/*/aapt2* 2>/dev/null | grep -E 'aapt2(\.exe)?$' | sort -V | tail -1)
if [ -z "$AAPT2" ]; then
  echo "aapt2를 찾을 수 없어요 (SDK: $SDK)"
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

"$AAPT2" dump permissions "$APK" | tee "$TMP/perms.txt"
if grep -q 'android.permission.INTERNET' "$TMP/perms.txt"; then
  echo "INTERNET 권한이 들어 있어요"
  exit 1
fi
grep -q 'android.permission.CAMERA' "$TMP/perms.txt" || { echo "CAMERA 권한이 없어요"; exit 1; }
"$AAPT2" dump xmltree --file AndroidManifest.xml "$APK" | grep -A0 'allowBackup' | tee "$TMP/backup.txt"
grep -q '=false' "$TMP/backup.txt" || { echo "allowBackup=false 가 아니에요"; exit 1; }
echo "권한 검사 통과: $APK"

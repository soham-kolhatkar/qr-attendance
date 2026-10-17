#!/usr/bin/env bash
# Builds a signed release APK of the student app, for installing directly on phones
# (64-bit ARM, i.e. any Android phone from the last several years).
#
#   npm run build:android
#   EXPO_PUBLIC_ALLOW_SERVER_CHANGE=true npm run build:android   # testing build: the server can be changed in the app
#   EXPO_PUBLIC_API_URL=https://staging.example.com npm run build:android
#
# Needs the Android toolchain (scripts/setup-android.sh at the repo root). The release
# signing key lives outside the repo in ~/.qr-attendance and is created on first run.
# Keep a backup of it: phones only accept updates signed with the same key, and the
# server only accepts phones running an app signed with it (ANDROID_SIGNING_CERT_SHA256).
#
# Output: apps/mobile/dist/qr-attendance-<version>.apk
set -euo pipefail
cd "$(dirname "$0")/.."

export JAVA_HOME="${JAVA_HOME:-$HOME/opt/jdk-17}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
BUILD_TOOLS="$ANDROID_HOME/build-tools/37.0.0"
KEY_DIR="${QRA_KEY_DIR:-$HOME/.qr-attendance}"
KEYSTORE="$KEY_DIR/android-release.jks"
PROPS="$KEY_DIR/android-release.properties"

if [ ! -f "$KEYSTORE" ]; then
  echo "Creating the app's release signing key in $KEY_DIR — back this folder up."
  mkdir -p "$KEY_DIR"
  chmod 700 "$KEY_DIR"
  password=$(openssl rand -base64 33 | tr -d '/+=')
  QRA_KS_PASS="$password" "$JAVA_HOME/bin/keytool" -genkeypair -storetype PKCS12 -keystore "$KEYSTORE" \
    -alias upload -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=QR Attendance" \
    -storepass:env QRA_KS_PASS >/dev/null
  printf 'storePassword=%s\nkeyAlias=upload\n' "$password" >"$PROPS"
  chmod 600 "$KEYSTORE" "$PROPS"
fi
export QRA_KS_PASS
QRA_KS_PASS=$(sed -n 's/^storePassword=//p' "$PROPS")

npx expo prebuild --platform android --no-install
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --console=plain --quiet)

version=$(node -p "require('./app.json').expo.version")
mkdir -p dist
out="dist/qr-attendance-$version.apk"
"$BUILD_TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-key-alias upload --ks-pass env:QRA_KS_PASS \
  --out "$out" android/app/build/outputs/apk/release/app-release.apk
rm -f "$out.idsig"

digest=$("$BUILD_TOOLS/apksigner" verify --print-certs "$out" | sed -n 's/.*certificate SHA-256 digest: //p' | head -1)
echo
echo "Built $out ($(du -h "$out" | cut -f1))"
echo "Signing certificate SHA-256 (the server's ANDROID_SIGNING_CERT_SHA256): $digest"

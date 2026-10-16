#!/usr/bin/env bash
# Sets up everything needed to build the Android app locally (no sudo needed):
#   - JDK 17 (Eclipse Temurin)      → ~/opt/jdk-17
#   - Android SDK + required parts  → ~/Android/Sdk
#   - JAVA_HOME / ANDROID_HOME      → a marked block in ~/.bashrc
# Safe to re-run: only missing pieces are downloaded.
#
# Usage: scripts/setup-android.sh
set -euo pipefail

JDK_DIR="${JDK_DIR:-$HOME/opt/jdk-17}"
SDK_DIR="${ANDROID_HOME:-$HOME/Android/Sdk}"

# Versions required by Expo SDK 58 / React Native 0.88, from
# node_modules/react-native/gradle/libs.versions.toml (compileSdk 37, buildTools 37.0.0,
# ndkVersion 27.1.12297006). Since Android 16 platform packages carry a minor version,
# so compileSdk 37 is "android-37.0".
SDK_PACKAGES=(
  "platform-tools"
  "platforms;android-37.0"
  "build-tools;37.0.0"
  "ndk;27.1.12297006"
  "cmake;3.22.1"
)

log() { printf '\n==> %s\n' "$*"; }

# --- JDK 17 ------------------------------------------------------------------
if [ -x "$JDK_DIR/bin/java" ]; then
  log "JDK found: $("$JDK_DIR/bin/java" -version 2>&1 | head -1)"
else
  log "Downloading JDK 17 (Temurin) to $JDK_DIR"
  tmp="$(mktemp -d)"
  curl -fL --retry 3 -o "$tmp/jdk.tar.gz" \
    "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
  mkdir -p "$JDK_DIR"
  tar -xzf "$tmp/jdk.tar.gz" -C "$JDK_DIR" --strip-components=1
  rm -rf "$tmp"
fi
export JAVA_HOME="$JDK_DIR"

# --- Android command-line tools ------------------------------------------------
SDKMANAGER="$SDK_DIR/cmdline-tools/latest/bin/sdkmanager"
if [ -x "$SDKMANAGER" ]; then
  log "Android command-line tools found"
else
  log "Downloading Android command-line tools to $SDK_DIR"
  zip_name="$(curl -fsSL https://dl.google.com/android/repository/repository2-3.xml |
    grep -oE 'commandlinetools-linux-[0-9]+_latest\.zip' | sort -t- -k3 -n | tail -1)"
  tmp="$(mktemp -d)"
  curl -fL --retry 3 -o "$tmp/tools.zip" "https://dl.google.com/android/repository/$zip_name"
  unzip -q "$tmp/tools.zip" -d "$tmp"
  mkdir -p "$SDK_DIR/cmdline-tools"
  rm -rf "$SDK_DIR/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$SDK_DIR/cmdline-tools/latest"
  rm -rf "$tmp"
fi

# --- SDK packages ----------------------------------------------------------------
log "Accepting Android SDK licences"
yes | "$SDKMANAGER" --sdk_root="$SDK_DIR" --licenses >/dev/null || true
log "Installing SDK packages (already-installed ones are skipped)"
"$SDKMANAGER" --sdk_root="$SDK_DIR" "${SDK_PACKAGES[@]}"

# --- Environment -----------------------------------------------------------------
MARK_BEGIN='# >>> qr-attendance android toolchain >>>'
MARK_END='# <<< qr-attendance android toolchain <<<'
if ! grep -qF "$MARK_BEGIN" "$HOME/.bashrc" 2>/dev/null; then
  log "Adding JAVA_HOME / ANDROID_HOME to ~/.bashrc"
  cat >>"$HOME/.bashrc" <<EOF

$MARK_BEGIN
export JAVA_HOME="$JDK_DIR"
export ANDROID_HOME="$SDK_DIR"
export PATH="\$JAVA_HOME/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/cmdline-tools/latest/bin:\$PATH"
$MARK_END
EOF
else
  log "~/.bashrc already has the toolchain block"
fi

log "Done. Open a new terminal (or run: source ~/.bashrc) before building."

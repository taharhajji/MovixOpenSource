#!/usr/bin/env bash
# Installe dans WSL Ubuntu l'outillage de l'appli Android TV : JDK 17, kit
# Android (outils en ligne de commande, plateforme, build-tools), Gradle, et
# l'émulateur Android TV pour les tests (accélération KVM de WSL2).
# Tout va sous $HOME (android-sdk, tools) ; rien n'est installé côté Windows.
# À lancer une fois ; relançable sans risque (chaque étape est sautée si faite).
set -euo pipefail

SDK="$HOME/android-sdk"
TOOLS="$HOME/tools"
CMDLINE_ZIP="commandlinetools-linux-11076708_latest.zip"
GRADLE_VERSION="8.7"
API_LEVEL="34"
BUILD_TOOLS="34.0.0"

export DEBIAN_FRONTEND=noninteractive
if ! command -v java >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1; then
  echo "[setup] JDK 17 et unzip (apt)"
  apt-get update -y -q
  apt-get install -y -q openjdk-17-jdk-headless unzip
fi
# Bibliothèques dont l'émulateur a besoin même sans fenêtre. Les noms varient
# selon la version d'Ubuntu : chaque paquet est tenté séparément.
for pkg in libpulse0 libnss3 libx11-6 libx11-xcb1 libxcb1 libxkbfile1 libxcomposite1 libxcursor1 \
           libxdamage1 libxi6 libxtst6 libxrender1 libxfixes3 libgl1 libasound2 libasound2t64 libdrm2 libgbm1; do
  dpkg -s "$pkg" >/dev/null 2>&1 || apt-get install -y -q "$pkg" >/dev/null 2>&1 || echo "[setup] paquet absent de cette version : $pkg"
done
java -version 2>&1 | head -1

mkdir -p "$SDK/cmdline-tools" "$TOOLS"
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "[setup] outils en ligne de commande Android"
  curl -fsSL "https://dl.google.com/android/repository/$CMDLINE_ZIP" -o /tmp/cmdline-tools.zip
  rm -rf /tmp/cmdline-tools-unzip && mkdir -p /tmp/cmdline-tools-unzip
  unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools-unzip
  mv /tmp/cmdline-tools-unzip/cmdline-tools "$SDK/cmdline-tools/latest"
fi
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"

echo "[setup] licences du kit Android (acceptées)"
yes | "$SDKMANAGER" --licenses >/dev/null 2>&1 || true

echo "[setup] plateforme, build-tools, adb, émulateur"
"$SDKMANAGER" "platform-tools" "platforms;android-$API_LEVEL" "build-tools;$BUILD_TOOLS" "emulator" | tail -2

# Image système Android TV pour l'émulateur : la plus récente disponible en x86.
if ! ls "$SDK/system-images" >/dev/null 2>&1 || [ -z "$(find "$SDK/system-images" -name system.img 2>/dev/null | head -1)" ]; then
  IMAGE="$("$SDKMANAGER" --list 2>/dev/null | grep -oE 'system-images;android-[0-9]+;(android-tv|google-tv);x86(_64)?' | sort -t';' -k2 -V | tail -1)"
  echo "[setup] image émulateur : ${IMAGE:-aucune trouvée}"
  [ -n "$IMAGE" ] && "$SDKMANAGER" "$IMAGE" | tail -1
fi
find "$SDK/system-images" -maxdepth 3 -mindepth 3 -type d 2>/dev/null | sed "s|$SDK/||"

if [ ! -x "$TOOLS/gradle-$GRADLE_VERSION/bin/gradle" ]; then
  echo "[setup] Gradle $GRADLE_VERSION"
  curl -fsSL "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip" -o /tmp/gradle.zip
  unzip -q /tmp/gradle.zip -d "$TOOLS"
fi
"$TOOLS/gradle-$GRADLE_VERSION/bin/gradle" --version | grep -E "^Gradle|^JVM" | head -2
ls -la /dev/kvm
echo "[setup] terminé"

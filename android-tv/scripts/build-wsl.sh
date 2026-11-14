#!/usr/bin/env bash
# Construit l'APK Android TV depuis WSL Ubuntu (outillage : scripts/setup-wsl.sh).
#   bash android-tv/scripts/build-wsl.sh            APK signé, dans android-tv/dist/
#   bash android-tv/scripts/build-wsl.sh debug      APK de test (journal détaillé, touche F12 = état)
# La clé de signature est créée au premier lancement, hors du dépôt, et
# recopiée côté Windows : sans elle, plus aucune mise à jour ne s'installe
# par-dessus une version déjà distribuée. Ne jamais la perdre ni la publier.
set -euo pipefail

VARIANT="${1:-release}"
SRC="/mnt/c/Users/WIN11/Documents/claude/MovixOpenSource"
WORK="$HOME/mewflix-tv"
export ANDROID_HOME="$HOME/android-sdk" ANDROID_SDK_ROOT="$HOME/android-sdk"
export PATH="$HOME/tools/node/bin:$HOME/tools/gradle-8.7/bin:$PATH"
KEY_DIR="$HOME/.mewflix"
KEY_BACKUP="/mnt/c/Users/WIN11/.mewflix"

mkdir -p "$WORK/android-tv" "$WORK/desktop"
rsync -a --delete --exclude .gradle --exclude build --exclude dist "$SRC/android-tv/" "$WORK/android-tv/"
rsync -a --delete "$SRC/desktop/src/" "$WORK/desktop/src/"
mkdir -p "$WORK/userscript" && cp "$SRC/userscript/movix.user.js" "$WORK/userscript/movix.user.js"
cd "$WORK"
node android-tv/scripts/build-assets.mjs

if [ ! -f "$KEY_DIR/android-keystore.properties" ]; then
  if [ -f "$KEY_BACKUP/android-keystore.properties" ]; then
    echo "[tv] clé de signature restaurée depuis la copie Windows"
    mkdir -p "$KEY_DIR" && cp "$KEY_BACKUP/mewflix-tv.jks" "$KEY_BACKUP/android-keystore.properties" "$KEY_DIR/"
  else
    echo "[tv] création de la clé de signature"
    mkdir -p "$KEY_DIR" "$KEY_BACKUP"
    PASS="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
    keytool -genkeypair -keystore "$KEY_DIR/mewflix-tv.jks" -storetype JKS -alias mewflix-tv \
      -keyalg RSA -keysize 2048 -validity 10950 -storepass "$PASS" -keypass "$PASS" \
      -dname "CN=MEWFLIX, O=MEWFLIX" >/dev/null 2>&1
    {
      echo "storeFile=$KEY_DIR/mewflix-tv.jks"
      echo "storePassword=$PASS"
      echo "keyAlias=mewflix-tv"
      echo "keyPassword=$PASS"
    } > "$KEY_DIR/android-keystore.properties"
    chmod 600 "$KEY_DIR/android-keystore.properties" "$KEY_DIR/mewflix-tv.jks"
    cp "$KEY_DIR/mewflix-tv.jks" "$KEY_DIR/android-keystore.properties" "$KEY_BACKUP/"
  fi
fi

cd "$WORK/android-tv"
VERSION="$(grep -oE 'versionName "[^"]+"' app/build.gradle | cut -d'"' -f2)"
if [ "$VARIANT" = "debug" ]; then
  gradle --no-daemon -q testDebugUnitTest assembleDebug
  APK="app/build/outputs/apk/debug/app-debug.apk"
  OUT="MEWFLIX-TV-$VERSION-debug.apk"
else
  gradle --no-daemon -q testReleaseUnitTest assembleRelease
  APK="app/build/outputs/apk/release/app-release.apk"
  OUT="MEWFLIX-TV-$VERSION.apk"
fi
"$ANDROID_HOME/build-tools/34.0.0/apksigner" verify --print-certs "$APK" | head -2
mkdir -p "$SRC/android-tv/dist"
cp "$APK" "$SRC/android-tv/dist/$OUT"
ls -la "$SRC/android-tv/dist/$OUT"
echo "[tv] terminé"

#!/usr/bin/env bash
# Émulateur Android TV sans fenêtre dans WSL (accélération KVM), pour tester
# l'appli sans télé. Outillage : scripts/setup-wsl.sh.
#   emulator-wsl.sh start            crée l'appareil virtuel au besoin et le fait tourner (bloquant)
#   emulator-wsl.sh wait             attend la fin du démarrage d'Android
#   emulator-wsl.sh install <apk>    installe (ou met à jour) l'appli et la lance
#   emulator-wsl.sh key <nom>...     touches : up down left right ok back home menu play f12
#   emulator-wsl.sh open <chemin>    build de test : ouvre une page du site (ex. /watch/movie/27205)
#   emulator-wsl.sh shot <fichier>   capture d'écran PNG
#   emulator-wsl.sh state            état de l'interface (build de test : touche F12 + journal)
#   emulator-wsl.sh log [n]          dernières lignes du journal de l'appli
#   emulator-wsl.sh stop             arrête l'émulateur
set -euo pipefail

export ANDROID_HOME="$HOME/android-sdk" ANDROID_SDK_ROOT="$HOME/android-sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
AVD="mewflix_tv"
PACKAGE="com.mewflix.tv"
BOOT_TIMEOUT_S=420

keycode() {
  case "$1" in
    up) echo 19 ;; down) echo 20 ;; left) echo 21 ;; right) echo 22 ;;
    ok) echo 23 ;; back) echo 4 ;; home) echo 3 ;; menu) echo 82 ;;
    play) echo 85 ;; rewind) echo 89 ;; forward) echo 90 ;; f12) echo 142 ;;
    *) echo "touche inconnue : $1" >&2; exit 2 ;;
  esac
}

case "${1:-}" in
  start)
    if ! avdmanager list avd 2>/dev/null | grep -q "Name: $AVD"; then
      IMAGE_DIR="$(find "$ANDROID_HOME/system-images" -maxdepth 3 -mindepth 3 -type d | sort -V | tail -1)"
      IMAGE="system-images;$(echo "${IMAGE_DIR#"$ANDROID_HOME"/system-images/}" | tr '/' ';')"
      echo "[emu] création de $AVD ($IMAGE)"
      echo no | avdmanager create avd -n "$AVD" -k "$IMAGE" -d tv_1080p --force >/dev/null
    fi
    if adb devices | grep -q "emulator-"; then
      echo "[emu] déjà démarré"
      exit 0
    fi
    # Au premier plan : WSL arrête les processus d'une session dès qu'elle se
    # termine, l'émulateur doit donc garder la sienne (à lancer en tâche de fond
    # côté Windows, puis `emulator-wsl.sh wait` depuis une autre commande).
    exec emulator -avd "$AVD" -no-window -no-audio -no-boot-anim -no-snapshot \
      -gpu swiftshader_indirect -accel on -memory 2048
    ;;
  wait)
    adb wait-for-device
    for _ in $(seq 1 "$BOOT_TIMEOUT_S"); do
      [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
      sleep 1
    done
    [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ] || { echo "[emu] démarrage trop long"; exit 1; }
    echo "[emu] prêt : Android $(adb shell getprop ro.build.version.release | tr -d '\r'), WebView $(adb shell dumpsys webviewupdate 2>/dev/null | grep -oE 'Current WebView package[^)]*\)' | head -1)"
    ;;
  install)
    adb install -r "$2" | tail -1
    adb shell am force-stop "$PACKAGE"
    adb logcat -c
    adb shell monkey -p "$PACKAGE" -c android.intent.category.LEANBACK_LAUNCHER 1 >/dev/null 2>&1
    echo "[emu] appli lancée"
    ;;
  key)
    shift
    for name in "$@"; do
      adb shell input keyevent "$(keycode "$name")"
      sleep 0.4
    done
    ;;
  open)
    adb shell am start -n "$PACKAGE/.MainActivity" --es path "$2" >/dev/null
    ;;
  shot)
    adb exec-out screencap -p > "$2"
    ls -la "$2"
    ;;
  state)
    adb logcat -c
    adb shell input keyevent 142
    sleep 1
    adb logcat -d -s MewflixTV:I | grep "état" | tail -1
    ;;
  log)
    adb logcat -d -s MewflixTV | tail -"${2:-30}"
    ;;
  stop)
    adb emu kill 2>/dev/null || true
    ;;
  *)
    sed -n '2,11p' "$0"
    exit 2
    ;;
esac

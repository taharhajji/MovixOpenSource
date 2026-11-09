#!/usr/bin/env bash
# Construit la version Linux (.deb x64 + arm64, pour les Chromebooks avec Linux
# activé et les distributions Debian/Ubuntu) depuis WSL Ubuntu, dans le même
# répertoire de travail que build-mac-wsl.sh (node_modules partagés).
set -euo pipefail
SRC="/mnt/c/Users/WIN11/Documents/claude/MovixOpenSource"
WORK="$HOME/mewflix-mac"
export PATH="$HOME/tools/node/bin:$PATH"
node -v
mkdir -p "$WORK/desktop" "$WORK/userscript"
rsync -a --delete --exclude node_modules --exclude dist --exclude dist-mac --exclude '*.log' "$SRC/desktop/" "$WORK/desktop/"
cp "$SRC/userscript/movix.user.js" "$WORK/userscript/movix.user.js"
cd "$WORK/desktop"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run sync:userscript
export CSC_IDENTITY_AUTO_DISCOVERY=false
npx electron-builder --linux deb --x64 --arm64 --publish never -c.compression=normal
ls -la dist/*.deb
mkdir -p "$SRC/desktop/dist-linux"
cp dist/*.deb "$SRC/desktop/dist-linux/"
ls -la "$SRC/desktop/dist-linux"
echo "[linux] terminé"

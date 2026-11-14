#!/usr/bin/env bash
# Construit la version macOS (zip arm64 + x64, non signée) depuis WSL Ubuntu :
# le DMG exige `sips` (macOS) ; le .app zippé suffit à distribuer, le DMG vient du Mac/CI.
# electron-builder sait produire les cibles macOS depuis Linux, pas depuis Windows.
set -euo pipefail
SRC="/mnt/c/Users/WIN11/Documents/claude/MovixOpenSource"
WORK="$HOME/mewflix-mac"
NODE_VER="v22.12.0"
mkdir -p "$HOME/tools"
if [ ! -x "$HOME/tools/node/bin/node" ]; then
  echo "[mac] installation de Node $NODE_VER (tarball, sans sudo)"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" -o /tmp/node.tar.xz
  mkdir -p "$HOME/tools/node" && tar -xJf /tmp/node.tar.xz -C "$HOME/tools/node" --strip-components=1
fi
export PATH="$HOME/tools/node/bin:$PATH"
node -v; npm -v
mkdir -p "$WORK/desktop" "$WORK/userscript"
rsync -a --delete --exclude node_modules --exclude dist --exclude dist-mac --exclude '*.log' "$SRC/desktop/" "$WORK/desktop/"
cp "$SRC/userscript/movix.user.js" "$WORK/userscript/movix.user.js"
cd "$WORK/desktop"
# Dépendances : réinstallées seulement quand package-lock.json a changé.
LOCK_SUM="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ ! -d node_modules ] || [ "$(cat node_modules/.lock-sum 2>/dev/null || true)" != "$LOCK_SUM" ]; then
  npm install --no-audit --no-fund
  echo "$LOCK_SUM" > node_modules/.lock-sum
fi
npm run sync:userscript
# Icône .icns : sur Linux electron-builder ne sait pas la dériver du PNG (il
# appelle `sips`, outil macOS). png2icons (JS pur) la génère ici.
if [ ! -f build/icon.icns ]; then
  npx --yes png2icons build/icon.png build/icon -icns -bc
  ls -la build/icon.icns
  cp build/icon.icns "$SRC/desktop/build/icon.icns"
fi
export CSC_IDENTITY_AUTO_DISCOVERY=false
# Cible « dir » : seulement les .app (dist/mac-arm64, dist/mac). Les zips
# distribués sont faits par zip-mac-wsl.sh après la signature ; les faire
# aussi ici doublait le temps de build pour des archives aussitôt remplacées.
npx electron-builder --mac dir --arm64 --x64 --publish never
ls -d dist/mac*/MEWFLIX.app
echo "[mac] terminé — suite : sign-mac-wsl.sh puis zip-mac-wsl.sh"

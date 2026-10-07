#!/usr/bin/env bash
# Archive les .app macOS déjà empaquetés par electron-builder (dist/mac*/MEWFLIX.app)
# en zip (liens symboliques conservés, indispensables au framework Electron) et
# écrit latest-mac.yml pour l'auto-updater. Utilisé quand l'étape zip
# d'electron-builder échoue sous Linux.
set -euo pipefail
SRC="/mnt/c/Users/WIN11/Documents/claude/MovixOpenSource"
WORK="$HOME/mewflix-mac/desktop"
export PATH="$HOME/tools/node/bin:$PATH"
cd "$WORK"
VERSION="$(node -p "require('./package.json').version")"
OUT="$SRC/desktop/dist-mac"
mkdir -p "$OUT"
if ! command -v zip >/dev/null; then echo "zip manquant"; exit 1; fi
sha512b64() { openssl dgst -sha512 -binary "$1" | base64 -w0; }
entries=""
for pair in "mac-arm64:arm64" "mac:x64"; do
  dir="${pair%%:*}"; arch="${pair##*:}"
  [ -d "dist/$dir/MEWFLIX.app" ] || { echo "dist/$dir/MEWFLIX.app absent"; continue; }
  name="MEWFLIX-$VERSION-mac-$arch.zip"
  rm -f "dist/$name"
  (cd "dist/$dir" && zip -ryXq "../$name" "MEWFLIX.app")
  size=$(stat -c %s "dist/$name"); sha=$(sha512b64 "dist/$name")
  echo "$name : $size octets"
  cp "dist/$name" "$OUT/$name"
  entries="$entries  - url: $name
    sha512: $sha
    size: $size
"
done
first="MEWFLIX-$VERSION-mac-arm64.zip"
cat > "$OUT/latest-mac.yml" <<YML
version: $VERSION
files:
$entries
path: $first
sha512: $(sha512b64 "dist/$first")
releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
YML
ls -la "$OUT"
echo "[zip-mac] terminé"

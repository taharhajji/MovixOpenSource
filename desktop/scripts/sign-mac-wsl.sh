#!/usr/bin/env bash
# Signe « ad hoc » les .app macOS produits par build-mac-wsl.sh, depuis WSL,
# avec rcodesign (apple-platform-rs) : sans certificat Apple, mais avec un
# sceau de bundle valide. Sans ce sceau, macOS affiche « MEWFLIX est
# endommagé, placez-le dans la corbeille » pour une app téléchargée ; avec,
# il affiche le message habituel d'app non vérifiée, qu'on peut autoriser
# (Réglages → Confidentialité et sécurité → Ouvrir quand même).
# À lancer entre build-mac-wsl.sh et zip-mac-wsl.sh.
set -euo pipefail
WORK="$HOME/mewflix-mac/desktop"
TOOLS="$HOME/tools/rcodesign"
VERSION="0.29.0"
if [ ! -x "$TOOLS/rcodesign" ]; then
  mkdir -p "$TOOLS"
  curl -fsSL -o /tmp/rcodesign.tgz \
    "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${VERSION}/apple-codesign-${VERSION}-x86_64-unknown-linux-musl.tar.gz"
  tar -xzf /tmp/rcodesign.tgz -C "$TOOLS" --strip-components=1
fi
RC="$TOOLS/rcodesign"
"$RC" --version
cd "$WORK/dist"
for dir in mac-arm64 mac; do
  app="$dir/MEWFLIX.app"
  [ -d "$app" ] || { echo "absent: $app"; continue; }
  echo "== signature ad hoc : $app"
  "$RC" sign "$app" > "/tmp/sign-$dir.log" 2>&1 || { tail -5 "/tmp/sign-$dir.log"; exit 1; }
  tail -1 "/tmp/sign-$dir.log"
  ls "$app/Contents/_CodeSignature/"
  "$RC" print-signature-info "$app/Contents/MacOS/MEWFLIX" 2>/dev/null | grep -E "flags:|identifier:" | head -2
done
echo "[sign-mac] terminé"

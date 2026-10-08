#!/usr/bin/env bash
# Archive les .app macOS empaquetés par electron-builder (dist/mac*/MEWFLIX.app)
# en zip avec liens symboliques conservés (python zipfile), et écrit
# latest-mac.yml pour l'auto-updater. Sous Linux, l'archiveur d'electron-builder
# remplace les liens par des copies ; les archives produites ici sont fidèles.
set -euo pipefail
SRC="/mnt/c/Users/WIN11/Documents/claude/MovixOpenSource"
WORK="$HOME/mewflix-mac/desktop"
OUT="$SRC/desktop/dist-mac"
mkdir -p "$OUT"
cd "$WORK"
python3 - "$OUT" <<'PY'
import os, sys, zipfile, hashlib, base64, json, time, stat
out = sys.argv[1]
version = json.load(open("package.json"))["version"]
def add_tree(z, root, base):
    for dirpath, dirnames, filenames in os.walk(root):
        # dossiers : liens symboliques traités comme des entrées, non parcourus
        keep = []
        for d in dirnames:
            full = os.path.join(dirpath, d)
            if os.path.islink(full):
                add_link(z, full, os.path.relpath(full, base))
            else:
                keep.append(d)
        dirnames[:] = keep
        for f in filenames:
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, base)
            if os.path.islink(full):
                add_link(z, full, rel)
            else:
                zi = zipfile.ZipInfo(rel, time.localtime(os.path.getmtime(full))[:6])
                zi.external_attr = (os.stat(full).st_mode & 0xFFFF) << 16
                zi.compress_type = zipfile.ZIP_DEFLATED
                with open(full, "rb") as fh:
                    z.writestr(zi, fh.read())
def add_link(z, full, rel):
    zi = zipfile.ZipInfo(rel, time.localtime(os.lstat(full).st_mtime)[:6])
    zi.external_attr = (stat.S_IFLNK | 0o777) << 16
    z.writestr(zi, os.readlink(full))
entries = []
for d, arch in (("mac-arm64", "arm64"), ("mac", "x64")):
    app = os.path.join("dist", d, "MEWFLIX.app")
    if not os.path.isdir(app):
        print("absent:", app); continue
    links = sum(1 for p, ds, fs in os.walk(app) for n in ds + fs if os.path.islink(os.path.join(p, n)))
    name = f"MEWFLIX-{version}-mac-{arch}.zip"
    path = os.path.join(out, name)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        add_tree(z, app, os.path.join("dist", d))
    h = hashlib.sha512()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""): h.update(chunk)
    size = os.path.getsize(path)
    entries.append((name, base64.b64encode(h.digest()).decode(), size))
    print(f"{name}: {size} octets, {links} liens symboliques dans l'app")
with open(os.path.join(out, "latest-mac.yml"), "w") as f:
    f.write(f"version: {version}\nfiles:\n")
    for name, sha, size in entries:
        f.write(f"  - url: {name}\n    sha512: {sha}\n    size: {size}\n")
    f.write(f"path: {entries[0][0]}\nsha512: {entries[0][1]}\nreleaseDate: '{time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())}'\n")
print("latest-mac.yml écrit")
PY
ls -la "$OUT"
echo "[zip-mac] terminé"

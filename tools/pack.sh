#!/usr/bin/env bash
# 打 0.3.0 分发包：目录 + zip（正斜杠路径）
set -e
cd "$(dirname "$0")/.."
V=$(node -p "require('./package.json').version")
OUT="dist/dsh-tlock-$V"
rm -rf "$OUT" "dist/dsh-tlock-$V.zip"
mkdir -p "$OUT/lib" "$OUT/app" "$OUT/desktop"
cp package.json cordis.patch.yml README.md MARKETPLACE.md LICENSE "$OUT/"
cp lib/index.mjs lib/client.js "$OUT/lib/"
cp app/icon.ico app/icon-preview.png "$OUT/app/"
cp app/TLock.exe app/icon.ico "$OUT/desktop/"
cp dist-src/install.ps1 dist-src/安装.bat dist-src/使用说明.txt "$OUT/"
python - "$OUT" "$V" <<'PY'
import os, sys, zipfile
out, ver = sys.argv[1], sys.argv[2]
target = f"dist/dsh-tlock-{ver}.zip"
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(out):
        for name in files:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, out).replace("\\", "/")
            zf.write(full, f"dsh-tlock-{ver}/{rel}")
print(target, os.path.getsize(target), "bytes")
PY

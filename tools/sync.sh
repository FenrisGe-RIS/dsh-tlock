#!/usr/bin/env bash
# 把工作区里的插件同步到「插件目录」和「已安装的 profile」两处
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST1="$HOME/.dsh/plugins/dsh-tlock"
DEST2="$HOME/.dsh/profiles/desktop/node_modules/dsh-tlock"
for d in "$DEST1" "$DEST2"; do
  mkdir -p "$d/lib"
  cp "$SRC/lib/index.mjs" "$SRC/lib/client.js" "$d/lib/"
  cp "$SRC/package.json" "$SRC/cordis.patch.yml" "$d/"
done
echo "synced -> $DEST1, $DEST2"

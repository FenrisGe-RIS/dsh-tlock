#!/usr/bin/env bash
# 一键发布 T约束（dsh-tlock）：建 GitHub 仓库 → 推代码和 tag → 发 npm 包
#
# 用法：
#   GH_TOKEN=ghp_xxx NPM_TOKEN=npm_xxx bash tools/publish.sh <github用户名>
#
# 只需要在 tlock/ 目录下跑一次。凭据只在本次进程内使用，不落盘（npm 用临时 .npmrc）。
set -euo pipefail

OWNER="${1:-}"
if [ -z "$OWNER" ]; then
  echo "用法: GH_TOKEN=... NPM_TOKEN=... bash tools/publish.sh <github用户名>" >&2
  exit 1
fi
if [ -z "${GH_TOKEN:-}" ]; then echo "缺少 GH_TOKEN（GitHub Personal Access Token）" >&2; exit 1; fi

cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"
REPO="dsh-tlock"
echo "==> 发布 $OWNER/$REPO v$VERSION"

# 1. 把 package.json 里的 OWNER 占位替换成真实用户名
node -e "
const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));
j.repository={type:'git',url:'https://github.com/$OWNER/$REPO.git'};
j.homepage='https://github.com/$OWNER/$REPO#readme';
j.bugs={url:'https://github.com/$OWNER/$REPO/issues'};
fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
"
git add package.json
git commit -q -m "chore: 指向真实仓库 $OWNER/$REPO" || echo "(无改动可提交)"

# 2. 建仓库（已存在则跳过）
CODE=$(curl -s -o /tmp/gh-repo.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/user/repos \
  -d "{\"name\":\"$REPO\",\"description\":\"T约束 —— 给每一轮生成装上刹车：token 到量就断、时间到点就断\",\"private\":false,\"has_issues\":true}")
if [ "$CODE" = "201" ]; then
  echo "==> 仓库已创建：https://github.com/$OWNER/$REPO"
elif [ "$CODE" = "422" ]; then
  echo "==> 仓库已存在，继续推送"
else
  echo "创建仓库失败 HTTP $CODE:"; cat /tmp/gh-repo.json; exit 1
fi

# 3. 推送 main 与 tag
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:$GH_TOKEN@github.com/$OWNER/$REPO.git"
git push -u origin main
git push origin "v$VERSION"
git remote set-url origin "https://github.com/$OWNER/$REPO.git"   # 清掉 token
echo "==> 代码与 tag 已推送"

# 4. 发 npm（临时 .npmrc，退出即删）
if [ -n "${NPM_TOKEN:-}" ]; then
  TMPRC="$(mktemp)"
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$TMPRC"
  npm publish --access public --userconfig "$TMPRC" || { rm -f "$TMPRC"; exit 1; }
  rm -f "$TMPRC"
  echo "==> npm 已发布：https://www.npmjs.com/package/dsh-tlock"
else
  echo "==> 跳过 npm（未提供 NPM_TOKEN）"
fi

cat <<EOF

完成。接下来：
  1) dshfind 每小时自动抓取，收录条件 = npm 包 + 仓库对得上，明早通常会出现在
     https://dshfind.com/zh/plugins/$OWNER/$REPO
  2) DSH 里安装：dsh plugin --profile desktop add https://codeload.github.com/$OWNER/$REPO/tar.gz/v$VERSION
  3) 别忘了在 GitHub 仓库 Settings 里加 topics: dsh, dsh-plugin, cordis
EOF

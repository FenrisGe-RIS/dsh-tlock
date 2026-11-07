#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

OWNER="FenrisGe-RIS"
REPO="dsh-tlock"
VERSION="$(node -p "require('./package.json').version")"

TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p' | tr -d '\r\n')"
if [ -z "$TOKEN" ]; then echo "没有拿到 GitHub 凭据" >&2; exit 1; fi
echo "==> 已取得 GitHub 凭据（长度 ${#TOKEN}，不显示）"

# 1) 创建仓库（已存在则跳过）
CODE=$(curl -s -o /tmp/gh-create.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/user/repos \
  -d "{\"name\":\"$REPO\",\"description\":\"T约束 —— 给每一轮生成装上刹车：token 到量就断、时间到点就断，断了的内容自动归档\",\"private\":false,\"has_issues\":true,\"has_wiki\":false}")
echo "==> 建仓库 HTTP $CODE"
if [ "$CODE" != "201" ] && [ "$CODE" != "422" ]; then
  sed 's/"token":[^,}]*//' /tmp/gh-create.json | head -c 400; echo; exit 1
fi

# 2) 推送 main + tag（token 只存在于本次 remote URL，推完清掉）
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:$TOKEN@github.com/$OWNER/$REPO.git"
git push -q -u origin main
git push -q origin "v$VERSION"
git remote set-url origin "https://github.com/$OWNER/$REPO.git"
echo "==> 已推送 main + v$VERSION"

# 3) 仓库元信息：description 已有，补 topics
curl -s -o /dev/null -w "==> topics HTTP %{http_code}\n" -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$OWNER/$REPO/topics" \
  -d '{"names":["dsh","dsh-plugin","cordis","token-budget","ai-agent","timeout","windows"]}'

# 4) 打一个 release，附 zip
if [ -f "dist/dsh-tlock-$VERSION.zip" ]; then
  REL=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$OWNER/$REPO/releases" \
    -d "{\"tag_name\":\"v$VERSION\",\"name\":\"T约束 v$VERSION\",\"body\":\"首个公开版本：token / 时间双闸、三种归档模式、DSH 悬浮球、Windows 桌面控制台。\",\"draft\":false,\"prerelease\":false}")
  UP=$(echo "$REL" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).upload_url||'')}catch(e){console.log('')}})")
  if [ -n "$UP" ]; then
    UP="${UP%%\{*}"
    curl -s -o /dev/null -w "==> 上传 zip HTTP %{http_code}\n" -X POST \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/zip" \
      --data-binary "@dist/dsh-tlock-$VERSION.zip" \
      "${UP}?name=dsh-tlock-$VERSION.zip"
  else
    echo "==> release 创建失败，跳过附件"
  fi
fi

echo "==> 完成：https://github.com/$OWNER/$REPO"

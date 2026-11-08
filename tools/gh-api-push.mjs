// 用 GitHub REST API 把本地仓库快照提交上去（github.com:443 被墙、SSH key 又没有 admin:public_key 权限时的兜底）
// 用法：GH_TOKEN=xxx node tools/gh-api-push.mjs
import fs from 'node:fs'
import path from 'node:path'

const TOKEN = process.env.GH_TOKEN
if (!TOKEN) { console.error('缺少 GH_TOKEN'); process.exit(1) }
const OWNER = 'FenrisGe-RIS'
const REPO = 'dsh-tlock'
const ROOT = '.'
const API = 'https://api.github.com'

const MESSAGE = process.env.MESSAGE_FILE ? fs.readFileSync(process.env.MESSAGE_FILE, 'utf8').trim() : `T约束 v0.2.1：每轮 token/时间双闸 + 桌面归档 + DSH 悬浮球

- 宿主：token 与时间两道闸，到量/超时硬断，断点快照落盘
- 归档：简洁描述 / AI联动分析 / 两份都要，另存 meta.json 与 history.json
- 客户端：黑色悬浮球、滑条（6 整点 + 1/5 吸附 + 手动输入）、三页签、输入前询问
- 桌面控制台：WinForms 单文件，与插件共享 settings.json
- 英文界面完整化；sim 测试 42 项通过`

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'dsh-tlock-publish',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* ignore */ }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`)
  return json
}

const listFile = process.env.FILE_LIST || 'tools/files.txt'
const rawList = fs.readFileSync(listFile, 'utf8')
const files = rawList.split(String.fromCharCode(10)).map(function (s) { return s.trim() }).filter(Boolean)
console.log(`==> ${files.length} 个文件`)

const entries = []
for (const rel of files) {
  const buf = fs.readFileSync(path.join(ROOT, rel))
  const blob = await call('POST', `${API}/repos/${OWNER}/${REPO}/git/blobs`, {
    content: buf.toString('base64'),
    encoding: 'base64',
  })
  entries.push({ path: rel.split(path.sep).join('/'), mode: '100644', type: 'blob', sha: blob.sha })
}
console.log('==> blobs 上传完成')

const tree = await call('POST', `${API}/repos/${OWNER}/${REPO}/git/trees`, { tree: entries })
console.log('==> tree', tree.sha.slice(0, 8))

let parent = null
if (process.env.ROOT_COMMIT !== '1') try {
  const cur = await call('GET', `${API}/repos/${OWNER}/${REPO}/git/ref/heads/main`)
  parent = cur.object && cur.object.sha ? cur.object.sha : null
} catch { parent = null }

const commit = await call('POST', `${API}/repos/${OWNER}/${REPO}/git/commits`, {
  message: MESSAGE,
  tree: tree.sha,
  author: { name: 'T约束', email: 'tlock@users.noreply.github.com', date: new Date().toISOString() },
  parents: parent ? [parent] : [],
})
console.log('==> commit', commit.sha.slice(0, 8))

async function ensureRef(ref, sha) {
  try {
    await call('POST', `${API}/repos/${OWNER}/${REPO}/git/refs`, { ref, sha })
  } catch (err) {
    if (!String(err.message).includes('422')) throw err
    await call('PATCH', `${API}/repos/${OWNER}/${REPO}/git/refs/${ref.replace('refs/', '')}`, { sha, force: true })
  }
}
await ensureRef('refs/heads/main', commit.sha)
const VERSION = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
await ensureRef('refs/tags/v' + VERSION, commit.sha)
console.log('==> main 与 v0.2.1 已创建')
console.log(`https://github.com/${OWNER}/${REPO}/tree/${commit.sha}`)

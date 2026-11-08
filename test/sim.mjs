/**
 * dsh-tlock 本地模拟测试：不用 DSH 也能把整条链路跑一遍。
 *
 * 用一个假 ctx 复刻宿主形状（session/event、agent/assistant-stream、agents 服务），
 * 假 Agent 记录 cancel / followup 的参数，时钟是假的，桌面/状态目录临时建。
 *
 *   node test/sim.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTlock, KIND_LABEL, DEFAULTS } from '../lib/index.mjs'

const SID = 'sess_test_0001'
let passed = 0
const failures = []
async function checkAsync(title, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${title}`)
  } catch (error) {
    failures.push({ title, error })
    console.log(`  ✗ ${title}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}
function check(title, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${title}`)
  } catch (error) {
    failures.push({ title, error })
    console.log(`  ✗ ${title}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 一套隔离的测试环境。 */
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlock-sim-'))
  const desktop = path.join(root, 'Desktop')
  const state = path.join(root, 'state')
  fs.mkdirSync(desktop, { recursive: true })
  fs.mkdirSync(state, { recursive: true })

  let now = Date.UTC(2026, 0, 1, 9, 30, 0)
  const clock = { now: () => now }
  const advance = (ms) => {
    now += ms
  }

  const handlers = new Map()
  const cancels = []
  const followups = []
  const agent = {
    id: SID,
    session: { id: SID },
    status: 'running',
    cancel(cause, options) {
      cancels.push({ cause, options })
    },
    followup(message, target) {
      followups.push({ message, target })
    },
  }
  const agents = {
    get(id) {
      return id === SID ? agent : undefined
    },
  }

  const ctx = {
    logger: { info() {} },
    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, [])
      handlers.get(type).push(handler)
      return () => {}
    },
    inject(names, callback) {
      callback({ agents })
    },
    effect(fn) {
      fn()
      return () => {}
    },
  }

  process.env.TLOCK_DESKTOP = desktop
  const rt = createTlock({ ctx, config: {}, clock, stateDirOverride: state, laxLimits: true })
  rt.start()

  const api = {
    rt,
    root,
    desktop,
    state,
    clock,
    advance,
    cancels,
    followups,
    agent,
    settingsFile: path.join(state, 'settings.json'),
    statusFile: path.join(state, 'status.json'),
    commandsFile: path.join(state, 'commands.json'),
    archives: path.join(desktop, 'DSH限定生成内容'),
    emit(type, data, sid = SID) {
      const event = { type, seq: ++api.seq, time: clock.now(), data }
      for (const handler of handlers.get('session/event') ?? []) handler({ id: sid }, event)
      return event
    },
    seq: 0,
    frame(chunk, sid = SID) {
      const payload = {
        agent: { ...agent, session: { id: sid } },
        frame: { type: 'chunk', revision: 1, attemptId: 'a1', turn: 1, step: 1, index: 0, time: clock.now(), chunk },
      }
      for (const handler of handlers.get('agent/assistant-stream') ?? []) handler(payload)
    },
    frameStart(sid = SID) {
      const payload = {
        agent: { ...agent, session: { id: sid } },
        frame: { type: 'start', revision: 1, attemptId: 'a1', turn: 1, step: 1, index: 0, time: clock.now() },
      }
      for (const handler of handlers.get('agent/assistant-stream') ?? []) handler(payload)
    },
    assistantMessage(text, { interrupted = false, outputTokens = 0, reasoning = '', tools = [] } = {}) {
      const content = []
      if (reasoning !== '') content.push({ type: 'reasoning', text: reasoning })
      for (const tool of tools) content.push({ type: 'tool-call', id: `tc_${tools.indexOf(tool)}`, name: tool.name, arguments: tool.args })
      if (text !== '') content.push({ type: 'text', text })
      const usage = outputTokens > 0 ? { inputTokens: 1000, outputTokens, totalTokens: 1000 + outputTokens } : undefined
      return api.emit('assistant/message', {
        turn: 1,
        step: 1,
        stream: 'main',
        ...(interrupted ? { interrupted: true } : {}),
        ...(usage === undefined ? {} : { usage }),
        message: { role: 'assistant', content, ...(usage === undefined ? {} : { usage }) },
      })
    },
    writeCommands(commands) {
      fs.writeFileSync(api.commandsFile, JSON.stringify({ commands }), 'utf8')
      rt._pollCommands()
    },
    readStatus() {
      return JSON.parse(fs.readFileSync(api.statusFile, 'utf8'))
    },
    readSettings() {
      return JSON.parse(fs.readFileSync(api.settingsFile, 'utf8'))
    },
    folders(kind = KIND_LABEL.token) {
      const base = path.join(api.archives, kind)
      if (!fs.existsSync(base)) return []
      return fs.readdirSync(base).map((name) => path.join(base, name))
    },
    cleanup() {
      rt.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
  return api
}

console.log('dsh-tlock sim\n')

// 1 ─ 默认设置 ────────────────────────────────────────────────────────────
{
  const h = harness()
  check('启动后写出默认 settings.json', () => {
    const settings = h.readSettings()
    assert.equal(settings.tokenLimit, DEFAULTS.tokenLimit)
    assert.equal(settings.timeLimitSec, DEFAULTS.timeLimitSec)
    assert.equal(settings.enabled, true)
  })
  check('状态目录结构正确', () => {
    assert.equal(h.rt._files.dir, h.state)
    assert.ok(fs.existsSync(h.statusFile))
  })
  h.cleanup()
}

// 2 ─ token 闸（流式估算）────────────────────────────────────────────────
{
  const h = harness()
  h.rt.applySettings({ tokenLimit: 100 })
  h.emit('turn/start', { turn: 1 })
  h.emit('session/title', { title: '帮我写一段介绍' })
  h.frameStart()
  check('未到量时不打断', () => {
    h.frame({ type: 'text-delta', text: '字'.repeat(40) }) // 20 token
    assert.equal(h.cancels.length, 0)
  })
  check('到量立刻 cancel(hook) ', () => {
    h.frame({ type: 'text-delta', text: '字'.repeat(200) }) // +100 token → 120 ≥ 100
    assert.equal(h.cancels.length, 1)
    assert.deepEqual(h.cancels[0].cause, { kind: 'hook', reason: 'tlock:token-limit' })
    assert.deepEqual(h.cancels[0].options, { keepInbox: true })
  })
  check('快照归档出现在 桌面/DSH限定生成内容/token限定版/', () => {
    const folders = h.folders()
    assert.equal(folders.length, 1)
    assert.match(path.basename(folders[0]), /^\d{8}-\d{6}_帮我写一段介绍$/)
    assert.ok(fs.existsSync(path.join(folders[0], '生成说明.md')))
    assert.ok(fs.existsSync(path.join(folders[0], 'meta.json')))
  })
  check('归档正文是已生成的文字', () => {
    const md = fs.readFileSync(path.join(h.folders()[0], '生成说明.md'), 'utf8')
    assert.ok(md.includes('帮我写一段介绍'))
    assert.ok(md.includes('token限定版'))
    assert.ok(md.includes('这一轮在说什么'))
    const meta = JSON.parse(fs.readFileSync(path.join(h.folders()[0], 'meta.json'), 'utf8'))
    assert.equal(meta.trigger, 'token')
    assert.equal(meta.mode, 'brief')
  })
  check('状态进入 awaiting（等用户决定是否继续）', () => {
    assert.equal(h.readStatus().active.state, 'awaiting')
    assert.equal(h.readStatus().active.trigger, 'token')
  })
  check('重复到量不会二次打断', () => {
    h.frame({ type: 'text-delta', text: '字'.repeat(500) })
    assert.equal(h.cancels.length, 1)
  })
  h.cleanup()
}

// 3 ─ 精确 usage 计量 ───────────────────────────────────────────────────
{
  const h = harness()
  h.rt.applySettings({ tokenLimit: 50 })
  h.emit('turn/start', { turn: 1 })
  h.assistantMessage('第一段', { outputTokens: 30 })
  check('assistant/message 的 outputTokens 计入且不打断', () => {
    assert.equal(h.cancels.length, 0)
    assert.equal(h.readStatus().active.used, 30)
  })
  h.emit('turn/start', { turn: 2 })
  check('新一轮 turn/start 清零计量', () => {
    assert.equal(h.readStatus().active.used, 0)
  })
  h.assistantMessage('第二段', { outputTokens: 55 })
  check('精确 usage 越线同样打断', () => {
    assert.equal(h.cancels.length, 1)
    assert.equal(h.cancels[0].cause.reason, 'tlock:token-limit')
  })
  h.cleanup()
}

// 4 ─ 时间闸 ─────────────────────────────────────────────────────────────
{
  const h = harness()
  h.rt.applySettings({ timeLimitSec: 60 })
  h.emit('turn/start', { turn: 1 })
  h.frameStart()
  h.frame({ type: 'text-delta', text: '慢慢写'.repeat(10) })
  check('未到 60 秒不打断', () => {
    h.advance(59_000)
    h.rt._checkTimeGates()
    assert.equal(h.cancels.length, 0)
  })
  check('超时立刻 cancel(hook, time) ', () => {
    h.advance(1_500)
    h.rt._checkTimeGates()
    assert.equal(h.cancels.length, 1)
    assert.deepEqual(h.cancels[0].cause, { kind: 'hook', reason: 'tlock:time-limit' })
  })
  check('时间限定版归档', () => {
    const folders = h.folders(KIND_LABEL.time)
    assert.equal(folders.length, 1)
    assert.ok(fs.readFileSync(path.join(folders[0], '生成说明.md'), 'utf8').includes('时间限定版'))
  })
  h.cleanup()
}

// 5 ─ 继续生成 ───────────────────────────────────────────────────────────
{
  const h = harness()
  h.rt.applySettings({ tokenLimit: 100 })
  h.emit('turn/start', { turn: 1 })
  h.frameStart()
  h.frame({ type: 'text-delta', text: '字'.repeat(300) })
  check('已经打断并等待', () => {
    assert.equal(h.readStatus().active.state, 'awaiting')
  })
  h.writeCommands([{ id: 1, action: 'continue' }])
  check('continue 命令触发 followup(继续)', () => {
    assert.equal(h.followups.length, 1)
    assert.equal(h.followups[0].message.role, 'user')
    assert.equal(h.followups[0].message.content[0].text, '继续')
    assert.deepEqual(h.followups[0].message.source, { kind: 'user' })
  })
  check('continue 后额度清零、可以再跑', () => {
    assert.equal(h.readStatus().active.state, 'running')
    assert.equal(h.readStatus().active.used, 0)
  })
  check('同一条命令不会被重复执行', () => {
    h.rt._pollCommands()
    h.rt._pollCommands()
    assert.equal(h.followups.length, 1)
  })
  check('内部继续会隐藏内部的「继续」消息', () => {
    // turn/start 在 awaitContinue 标记下开新周期，不会把「继续」当新一轮
    h.emit('turn/start', { turn: 2 })
    assert.equal(h.rt._cycles.get(SID).turn, 2)
  })
  h.cleanup()
}

// 6 ─ 结束本轮 / 归档格式 ────────────────────────────────────────────────
{
  const h = harness()
  h.rt.applySettings({ tokenLimit: 10, archiveMode: 'full' })
  h.emit('turn/start', { turn: 1 })
  h.assistantMessage('只有 ai', { outputTokens: 20 })
  check('full 模式下只写 完整记录.md + 完整记录.json（外加 meta.json）', () => {
    const folder = h.folders()[0]
    assert.ok(fs.existsSync(path.join(folder, '完整记录.md')))
    assert.ok(!fs.existsSync(path.join(folder, '生成说明.md')))
    const md = fs.readFileSync(path.join(folder, '完整记录.md'), 'utf8')
    assert.ok(md.includes('只有 ai'))
    assert.ok(md.includes('完整思考过程'))
  })
  h.writeCommands([{ id: 2, action: 'end' }])
  check('end 命令收尾并清空周期', () => {
    assert.equal(h.readStatus().active, null)
  })
  h.cleanup()
}

// 7 ─ 预警与归档细节 ────────────────────────────────────────────────────
{
  const h = harness()
  h.rt.applySettings({ tokenLimit: 1000 })
  h.emit('turn/start', { turn: 1 })
  h.assistantMessage('八成', { outputTokens: 820 })
  check('80% 预警记录在状态里', () => {
    const s = h.readStatus()
    assert.deepEqual(s.active.warned, [80])
  })
  h.emit('turn/start', { turn: 2 })
  h.assistantMessage('九成', { outputTokens: 950 })
  check('90% 预警记录（本轮跨过 80% 也会补记）', () => {
    assert.deepEqual(h.readStatus().active.warned, [80, 90])
  })
  h.cleanup()
}

// 8 ─ 思考过程压缩 + 工具调用列表 ────────────────────────────────────────
{
  const h = harness()
  h.rt.applySettings({ tokenLimit: 10 })
  h.emit('turn/start', { turn: 1 })
  const longReasoning = '想'.repeat(1000)
  h.assistantMessage('结果', {
    outputTokens: 20,
    reasoning: longReasoning,
    tools: [{ name: 'read_file', args: '{"path":"a.txt"}' }],
  })
  check('思考过程被压缩（首尾各 300 字）', () => {
    const md = fs.readFileSync(path.join(h.folders()[0], '生成说明.md'), 'utf8')
    assert.ok(md.includes('原文 1000 字'))
    assert.ok(md.includes('中间省略 400 字'))
  })
  check('工具调用只留名字和截断参数', () => {
    const md = fs.readFileSync(path.join(h.folders()[0], '生成说明.md'), 'utf8')
    assert.ok(md.includes('read_file'))
    assert.ok(md.includes('动过的东西'))
  })
  h.cleanup()
}

// 9 ─ 关闭插件 ──────────────────────────────────────────────────────────
{
  const h = harness()
  h.rt.applySettings({ enabled: false })
  h.emit('turn/start', { turn: 1 })
  h.assistantMessage('不该被记', { outputTokens: 99999 })
  check('enabled=false 时不计不打断不归档', () => {
    assert.equal(h.cancels.length, 0)
    assert.equal(h.folders().length, 0)
  })
  h.cleanup()
}

// 10 ─ 断点快照 vs 断后补全 ─────────────────────────────────────────────
{
  const h = harness()
  h.rt.applySettings({ tokenLimit: 100 })
  h.emit('turn/start', { turn: 1 })
  h.emit('session/title', { title: '快照测试' })
  h.frameStart()
  h.frame({ type: 'text-delta', text: '字'.repeat(300) })
  const folder = h.folders()[0]
  check('打断瞬间的快照标记为 snapshot', () => {
    const md = fs.readFileSync(path.join(folder, '生成说明.md'), 'utf8')
    assert.ok(md.includes('断点即时快照'))
    const meta = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8'))
    assert.equal(meta.snapshot, true)
  })
  check('interrupted 消息回来补全精确用量', () => {
    h.assistantMessage('字'.repeat(150), { interrupted: true, outputTokens: 120 })
    const meta = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8'))
    assert.equal(meta.snapshot, false)
    assert.equal(meta.used.outputTokensExact, 120)
  })
  h.cleanup()
}

// 11 ─ 归档根目录自定义 ────────────────────────────────────────────────
{
  const h = harness()
  const custom = path.join(h.root, '自定义归档')
  h.rt.applySettings({ tokenLimit: 10, archiveRoot: custom })
  h.emit('turn/start', { turn: 1 })
  h.assistantMessage('自定义', { outputTokens: 20 })
  check('archiveRoot 生效', () => {
    const base = path.join(custom, KIND_LABEL.token)
    assert.ok(fs.existsSync(base))
    assert.equal(fs.readdirSync(base).length, 1)
  })
  h.cleanup()
}

// 12 ─ 会话标题兜底 ────────────────────────────────────────────────────
{
  const h = harness()
  h.rt.applySettings({ tokenLimit: 10 })
  h.emit('turn/start', { turn: 1 })
  h.assistantMessage('无标题', { outputTokens: 20 })
  check('没有标题时用会话 id 兜底', () => {
    const name = path.basename(h.folders()[0])
    assert.match(name, /_会话 sess_t/)
  })
  h.cleanup()
}

// 13 ─ V2：both 模式 + 历史记录 ─────────────────────────────────────────
{
  const h = harness()
  h.rt.applySettings({ tokenLimit: 10, archiveMode: 'both' })
  h.emit('turn/start', { turn: 1 })
  h.emit('session/title', { title: '双份归档' })
  h.assistantMessage('## 小标题\n正文在这里', { outputTokens: 20, reasoning: '想一想' })
  check('both 模式同时写两份 markdown + 完整记录.json + meta.json', () => {
    const folder = h.folders()[0]
    assert.ok(fs.existsSync(path.join(folder, '生成说明.md')))
    assert.ok(fs.existsSync(path.join(folder, '完整记录.md')))
    assert.ok(fs.existsSync(path.join(folder, '完整记录.json')))
    assert.ok(fs.existsSync(path.join(folder, 'meta.json')))
  })
  check('简洁描述里出现小标题骨架', () => {
    const md = fs.readFileSync(path.join(h.folders()[0], '生成说明.md'), 'utf8')
    assert.ok(md.includes('内容的骨架'))
    assert.ok(md.includes('小标题'))
  })
  check('AI 联动分析里有完整思考', () => {
    const md = fs.readFileSync(path.join(h.folders()[0], '完整记录.md'), 'utf8')
    assert.ok(md.includes('想一想'))
  })
  check('history.json 记录了这一次归档', () => {
    const history = JSON.parse(fs.readFileSync(path.join(h.state, 'history.json'), 'utf8'))
    const items = Array.isArray(history) ? history : history.items
    assert.equal(items.length, 1)
    assert.equal(items[0].mode, 'both')
    assert.equal(items[0].title, '双份归档')
  })
  h.cleanup()
}

// 14 ─ V2：取消归档 ────────────────────────────────────────────────────
{
  const h = harness()
  h.rt.applySettings({ tokenLimit: 10, archiveEnabled: false })
  h.emit('turn/start', { turn: 1 })
  h.frame({ type: 'text-delta', text: '字'.repeat(100) })
  check('取消归档后到量仍硬断，但不写任何文件', () => {
    assert.equal(h.cancels.length, 1)
    assert.equal(h.folders().length, 0)
    const history = path.join(h.state, 'history.json')
    assert.ok(!fs.existsSync(history) || (JSON.parse(fs.readFileSync(history, 'utf8')).items ?? []).length === 0)
  })
  h.cleanup()
}

// 15 ─ V2：设置写回与量程收敛 ──────────────────────────────────────────
{
  const h = harness()
  h.rt.applySettings({ archiveMode: 'full', lang: 'en', ball: false, panelSize: 'l' })
  check('设置写回 settings.json 并可读回', () => {
    const saved = JSON.parse(fs.readFileSync(h.settingsFile, 'utf8'))
    assert.equal(saved.archiveMode, 'full')
    assert.equal(saved.lang, 'en')
    assert.equal(saved.ball, false)
    assert.equal(saved.panelSize, 'l')
  })
  check('status 里带量程与归档开关', () => {
    const status = h.readStatus()
    assert.equal(status.settings.tokenMin, 5000)
    assert.equal(status.settings.tokenMax, 1000000)
    assert.equal(status.settings.timeMinSec, 60)
    assert.equal(status.settings.timeMaxSec, 7200)
    assert.equal(status.settings.archiveEnabled, true)
    assert.equal(status.settings.archiveMode, 'full')
  })
  h.cleanup()
}

// 16 ─ V2：HTTP 路由（客户端面板走后端这条线） ─────────────────────────
{
  const h = harness()
  const call = async (method, url, body) => {
    const req = {
      method,
      url,
      on(type, fn) {
        if (type === 'data' && body !== undefined) fn(JSON.stringify(body))
        if (type === 'end') fn()
      },
    }
    let captured = null
    const res = {
      writeHead(code, headers) {
        captured = { code, headers }
      },
      end(text) {
        captured.body = text
      },
    }
    await h.rt._route(req, res)
    return { ...captured, json: captured.body ? JSON.parse(captured.body) : null }
  }

  h.emit('turn/start', { turn: 1 })
  h.emit('session/title', { title: '路由测试' })
  h.frame({ type: 'text-delta', text: '字'.repeat(30) })

  await checkAsync('GET /dsh-tlock/state 返回运行状态', async () => {
    const r = await call('GET', '/dsh-tlock/state')
    assert.equal(r.code, 200)
    assert.equal(r.json.active.title, '路由测试')
    assert.ok(r.json.settings.tokenMin === 5000)
  })

  await checkAsync('POST /set 改设置并立刻生效', async () => {
    const r = await call('POST', '/dsh-tlock/set', { tokenLimit: 123456, archiveMode: 'full', lang: 'en' })
    assert.equal(r.code, 200)
    assert.equal(r.json.settings.tokenLimit, 123456)
    assert.equal(r.json.settings.archiveMode, 'full')
    assert.equal(r.json.settings.lang, 'en')
  })

  await checkAsync('POST /set 拒绝没有可改字段的请求', async () => {
    const r = await call('POST', '/dsh-tlock/set', { bogus: 1 })
    assert.equal(r.code, 400)
    assert.equal(r.json.code, 'nothing-to-set')
  })

  await checkAsync('POST /cmd 走命令通道（pause）', async () => {
    const r = await call('POST', '/dsh-tlock/cmd', { action: 'pause' })
    assert.equal(r.code, 200)
    assert.equal(r.json.action, 'pause')
    assert.equal(h.rt._status().enabled, false)
  })

  await checkAsync('GET /health 可用', async () => {
    const r = await call('GET', '/dsh-tlock/health')
    assert.equal(r.code, 200)
    assert.equal(r.json.ok, true)
  })

  // 先造一份归档，再验证「面板内浏览 + 重命名」这两条路由
  h.rt.applySettings({ enabled: true, tokenLimit: 10, archiveEnabled: true, archiveMode: 'full' })
  h.frame({ type: 'text-delta', text: '字'.repeat(200) })
  const firstFolder = h.folders()[0]

  await checkAsync('GET /archive 能读出归档内容', async () => {
    const r = await call('GET', '/dsh-tlock/archive?path=' + encodeURIComponent(firstFolder))
    assert.equal(r.code, 200)
    assert.equal(r.json.ok, true)
    const names = r.json.files.map((file) => file.name)
    assert.ok(names.includes('完整记录.md'))
    const md = r.json.files.find((file) => file.name === '完整记录.md')
    assert.ok(md.text.includes('归档完全记录'))
  })

  await checkAsync('GET /archive 拒绝归档根目录外的路径', async () => {
    const r = await call('GET', '/dsh-tlock/archive?path=' + encodeURIComponent('C:/Windows'))
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, 'outside-root')
  })

  await checkAsync('POST /rename 保留时间前缀改目录名', async () => {
    const r = await call('POST', '/dsh-tlock/rename', { path: firstFolder, title: '新名字' })
    assert.equal(r.json.ok, true)
    assert.ok(fs.existsSync(r.json.path))
    assert.ok(path.basename(r.json.path).endsWith('_新名字'))
    const history = JSON.parse(fs.readFileSync(h.rt._files.historyFile, 'utf8'))
    assert.equal(history.items[0].path, r.json.path)
  })

  await checkAsync('POST /rename 拒绝空名字', async () => {
    const target = h.folders()[0]
    const r = await call('POST', '/dsh-tlock/rename', { path: target, title: '   ' })
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, 'empty-title')
  })

  await checkAsync('POST /rename 改文件名', async () => {
    const folder = h.folders()[0]
    const r = await call('POST', '/dsh-tlock/rename', { path: folder, file: '完整记录.md', name: '全文' })
    assert.equal(r.json.ok, true)
    assert.ok(fs.existsSync(path.join(folder, '全文.md')))
    assert.ok(!fs.existsSync(path.join(folder, '完整记录.md')))
  })

  h.cleanup()
}

console.log('')
if (failures.length > 0) {
  console.log(`${passed} 项通过，${failures.length} 项失败`)
  for (const failure of failures) console.log(`  - ${failure.title}`)
  process.exit(1)
}
console.log(`全部 ${passed} 项通过 ✅`)

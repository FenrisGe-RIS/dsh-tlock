/**
 * dsh-tlock 桥接联调：用真时钟跑一个假宿主，让桌面端看到「活」的状态。
 *
 *   node test/bridge.mjs <状态目录> [running|overflow|slow]
 *
 * 它会：
 *   - 在该目录写 settings.json（tokenLimit 20000 / timeLimit 300 秒）
 *   - 用假 ctx / 假 Agent 起 createTlock，每 150ms 吐一点流式文本
 *   - 插件正常写 status.json；桌面端 TLock.exe 用同样的 TLOCK_STATE_DIR 就能读到
 *   - 收到 commands.json 里的 continue / stop / end 时打印出来，方便肉眼确认联动
 */
import fs from 'node:fs'
import path from 'node:path'
import { createTlock, DEFAULTS } from '../lib/index.mjs'

const dir = path.resolve(process.argv[2] ?? '.tmp-int')
const mode = process.argv[3] ?? 'running'
const SID = 'sess_bridge_0001'

fs.mkdirSync(dir, { recursive: true })
const desktop = path.join(dir, 'Desktop')
fs.mkdirSync(desktop, { recursive: true })
process.env.TLOCK_DESKTOP = desktop

fs.writeFileSync(
  path.join(dir, 'settings.json'),
  JSON.stringify(
    {
      enabled: true,
      tokenLimit: Number(process.env.TL_LIMIT ?? 20000),
      timeLimitSec: mode === 'slow' ? 60 : 300,
      warnPct: [0.8, 0.9],
      archiveFormat: 'md',
      autoStart: false,
      snapshotOnInterrupt: true,
      archiveRoot: '',
    },
    null,
    2,
  ),
  'utf8',
)

const handlers = new Map()
const cancels = []
const followups = []
const agent = {
  id: SID,
  session: { id: SID },
  status: 'running',
  cancel(cause, options) {
    cancels.push({ cause, options })
    console.log(`[bridge] cancel ${JSON.stringify(cause)} keepInbox=${options?.keepInbox}`)
  },
  followup(message) {
    followups.push(message)
    console.log(`[bridge] followup: ${JSON.stringify(message.content)}`)
  },
}
const ctx = {
  logger: { info: (msg) => console.log(`[plugin] ${msg}`) },
  on(type, handler) {
    if (!handlers.has(type)) handlers.set(type, [])
    handlers.get(type).push(handler)
    return () => {}
  },
  inject(names, callback) {
    callback({ agents: { get: (id) => (id === SID ? agent : undefined) } })
  },
  effect(fn) {
    fn()
    return () => {}
  },
}

const rt = createTlock({ ctx, config: {}, stateDirOverride: dir })
rt.start()

let seq = 0
function emit(type, data) {
  const event = { type, seq: ++seq, time: Date.now(), data }
  for (const handler of handlers.get('session/event') ?? []) handler({ id: SID }, event)
}
function frame(chunk) {
  const payload = {
    agent: { ...agent, session: { id: SID } },
    frame: { type: 'chunk', revision: 1, attemptId: 'a1', turn: 1, step: 1, index: 0, time: Date.now(), chunk },
  }
  for (const handler of handlers.get('agent/assistant-stream') ?? []) handler(payload)
}

emit('turn/start', { turn: 1 })
emit('request/header', { provider: 'deepseek', model: 'deepseek-chat' })
emit('session/title', { title: '先把先验版跑通' })
emit('model/selection', { model: 'deepseek-chat' })

const chunkText = '这是一段用于联调的流式输出，用来把 token 条推起来。'.repeat(mode === 'overflow' ? 20 : 4)
let chars = 0
let ticks = 0
let exact = 0
const target = mode === 'overflow' ? 24000 : 11800

const timer = setInterval(() => {
  frame({ type: 'block-start', index: 1, blockType: 'text' })
  frame({ type: 'text-delta', index: 1, text: chunkText })
  chars += chunkText.length
  ticks += 1
  if (ticks % 12 === 0) {
    // 一次尝试结束：用量是这一段增量的 output token（真实宿主也是这样按次结算）
    const delta = Math.round(chars / 2) - exact
    exact += delta
    frame({ type: 'block-end', index: 1, blockType: 'text' })
    emit('assistant/message', {
      turn: 1,
      step: 1,
      stream: 'main',
      usage: { inputTokens: 900, outputTokens: delta, totalTokens: 900 + delta },
      message: { role: 'assistant', content: [{ type: 'text', text: chunkText }] },
    })
  }
  if (Math.round(chars / 2) > target && mode !== 'overflow') clearInterval(timer)
}, 150)

process.on('SIGINT', () => {
  clearInterval(timer)
  rt.dispose()
  process.exit(0)
})
process.on('SIGTERM', () => {
  clearInterval(timer)
  rt.dispose()
  process.exit(0)
})

console.log(`[bridge] dir=${dir} mode=${mode} pid=${process.pid}`)
setInterval(() => {
  rt._flushStatus(true)
}, 500)

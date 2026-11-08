/**
 * dsh-tlock —— T约束
 *
 * 每轮生成的「token 闸」与「时间闸」：
 *  - 计量口径：只数模型新生成的 output token（DSH 的 usage.outputTokens），
 *    每发一条消息（一个 turn）归零重算；子代理/后台任务不计入。
 *  - 到量/超时 → 立刻 agent.cancel({kind:'hook'}) 硬断，并把已生成内容
 *    快照归档到 <桌面>/DSH限定生成内容/{token限定版|时间限定版}/…。
 *  - 断前 80% / 90% 给面板一个预警；断后可以「继续生成」（清零本轮额度再跑）。
 *
 * 状态目录（%USERPROFILE%\.dsh\storages\dsh-tlock）里三个 JSON 文件：
 *   settings.json  面板 / 手工写 → 插件读（启用开关、挡位、归档格式…）
 *   status.json    插件写 → 面板读（实时用量、剩余时间、等待决定…）
 *   commands.json  面板 / 手工写 → 插件消费（continue / end / stop / archive）
 *
 * 宿主接口（全部可选，缺了也能跑）：
 *   ctx.on('session/event', (session, event))                     会话事件
 *   ctx.on('agent/assistant-stream', ({agent, frame}), {global:true}) 流式帧
 *   ctx.inject(['agents'], scoped => scoped.agents)                Agent 注册表
 *
 * 不 import 任何 @deepseek-ai 包：插件装在 profile 里，裸依赖越少越不容易坏。
 *
 * @module dsh-tlock
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const name = 'dsh-tlock'
export const inject = []
export const VERSION = '0.3.1'
export const KIND_LABEL = { token: 'token限定版', time: '时间限定版', manual: '手动结束' }

/** 默认设置（桌面端可改）。 */
export const DEFAULTS = {
  enabled: true,
  tokenLimit: 20000,
  timeLimitSec: 300,
  warnPct: [0.8, 0.9],
  archiveEnabled: true,
  archiveMode: 'brief', // brief（简洁描述）| full（归档完全记录）| both
  snapshotOnInterrupt: true,
  autoStart: true,
  archiveRoot: '',
  lang: 'zh', // zh | en
  ball: true, // DSH 里的悬浮球
  panelSize: 'm', // s | m | l
}

/** 滑条量程（桌面端与网页端共用）。 */
export const TOKEN_MIN = 5000
export const TOKEN_MAX = 1000000
export const TIME_MIN_SEC = 60
export const TIME_MAX_SEC = 7200

/** token 挡位（桌面端按钮用，插件只做兜底校验）。 */
export const TOKEN_STEPS = [5000, 10000, 20000, 50000, 100000, 200000]
/** 时间挡位（秒）。 */
export const TIME_STEPS = [60, 180, 300, 600, 1800, 3600]

export const ROUTE_PREFIX = '/dsh-tlock'

// ---------------------------------------------------------------------------
// 纯工具函数
// ---------------------------------------------------------------------------

/** 估算用：一个字符大概折多少 token。中文约 1.5 字/token，英文约 4 字/token。 */
const CHARS_PER_TOKEN = 2

/** DSH 家目录。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 桌面目录（Windows 优先 USERPROFILE\\Desktop）。 */
export function desktopDir() {
  if (process.env.TLOCK_DESKTOP) return process.env.TLOCK_DESKTOP
  const profile = process.env.USERPROFILE || os.homedir()
  const direct = path.join(profile, 'Desktop')
  if (fs.existsSync(direct)) return direct
  const oneDrive = path.join(profile, 'OneDrive', 'Desktop')
  if (fs.existsSync(oneDrive)) return oneDrive
  return direct
}

/** 状态目录（插件与桌面端共享）。 */
export function stateDir() {
  return process.env.TLOCK_STATE_DIR || path.join(dshHome(), 'storages', 'dsh-tlock')
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/** 文件名安全化。 */
export function safeName(text, max = 40) {
  const cleaned = String(text ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const cut = cleaned.slice(0, max).trim()
  return cut === '' ? '未命名' : cut
}

/** 时间戳 YYYYMMDD-HHmmss（本地时区）。 */
export function stamp(at = Date.now()) {
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function clamp(n, lo, hi) {
  const value = Number(n)
  if (!Number.isFinite(value)) return lo
  return Math.min(hi, Math.max(lo, Math.round(value)))
}

export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)} 万`
  return String(Math.round(n))
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest === 0 ? `${m} 分` : `${m} 分 ${rest} 秒`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}

/** 思考过程压缩：首尾各保留 n 字。 */
export function compressReasoning(text, n = 300) {
  const raw = String(text ?? '')
  if (raw.length <= n * 2) return { text: raw, compressed: false, length: raw.length }
  return {
    text: `${raw.slice(0, n)}\n\n…（中间省略 ${raw.length - n * 2} 字）…\n\n${raw.slice(-n)}`,
    compressed: true,
    length: raw.length,
  }
}

/** 从一条会话事件里取本轮 output token（只有 assistant/message 有）。 */
export function outputTokensOf(event) {
  if (event?.type !== 'assistant/message') return 0
  const usage = event?.data?.usage ?? event?.data?.message?.usage
  if (usage === undefined || usage === null) return 0
  if (typeof usage.outputTokens === 'number' && usage.outputTokens > 0) return usage.outputTokens
  return 0
}

/** 把一条 assistant 消息的内容块折叠进归档缓冲。 */
export function foldBlocks(blocks, into) {
  const out = into ?? { text: [], reasoning: [], tools: [] }
  for (const block of blocks ?? []) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out.text.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') out.reasoning.push(block.text)
    else if (block.type === 'tool-call') {
      out.tools.push({
        id: String(block.id ?? ''),
        name: String(block.name ?? '?'),
        args: String(block.arguments ?? '').slice(0, 8000),
        result: '',
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------

/**
 * 建一个运行时实例（测试也直接用它）。
 * @param options.ctx 宿主上下文（可以是假的）
 * @param options.config profile patch 里的配置
 * @param options.clock 时钟（测试注入）
 * @param options.stateDirOverride 状态目录覆盖（测试）
 */
export function createTlock(options = {}) {
  const ctx = options.ctx ?? {}
  const config = options.config ?? {}
  const clock = options.clock ?? { now: () => Date.now() }
  // 测试专用：允许把限额设到真实量程以下（生产环境永远走 clamp 下限）
  const tokenLo = options.laxLimits === true ? 1 : TOKEN_MIN
  const timeLo = options.laxLimits === true ? 1 : TIME_MIN_SEC
  const log = (...args) => {
    try {
      ctx.logger?.info?.(`[dsh-tlock] ${args.join(' ')}`)
    } catch {
      /* ignore */
    }
    if (options.verbose === true) console.log('[dsh-tlock]', ...args)
  }

  const dir = options.stateDirOverride ?? stateDir()
  const settingsFile = path.join(dir, 'settings.json')
  const statusFile = path.join(dir, 'status.json')
  const commandsFile = path.join(dir, 'commands.json')
  const historyFile = path.join(dir, 'history.json')

  let settings = { ...DEFAULTS, ...readJson(settingsFile, {}) }
  if (typeof config.archiveRoot === 'string' && config.archiveRoot !== '') settings.archiveRoot = config.archiveRoot
  if (typeof config.tokenLimit === 'number') settings.tokenLimit = config.tokenLimit
  if (typeof config.timeLimitSec === 'number') settings.timeLimitSec = config.timeLimitSec

  /** sid → 本轮周期。 */
  const cycles = new Map()
  let lastStatusAt = 0
  let lastStatusJson = ''
  let lastSettingsMtime = 0
  let consumedCommandId = 0
  let lastArchive = null
  let agentsRegistry = null
  let disposed = false

  // ------------------------------------------------------------------ 设置

  function archiveRoot() {
    return settings.archiveRoot && settings.archiveRoot !== ''
      ? settings.archiveRoot
      : path.join(desktopDir(), 'DSH限定生成内容')
  }

  function reloadSettings(force = false) {
    let mtime = 0
    try {
      mtime = fs.statSync(settingsFile).mtimeMs
    } catch {
      return
    }
    if (!force && mtime === lastSettingsMtime) return
    lastSettingsMtime = mtime
    const next = readJson(settingsFile, null)
    if (next === null || typeof next !== 'object') return
    const merged = { ...DEFAULTS, ...next }
    merged.tokenLimit = clamp(Math.round(Number(merged.tokenLimit) || DEFAULTS.tokenLimit), tokenLo, TOKEN_MAX)
    merged.timeLimitSec = clamp(Math.round(Number(merged.timeLimitSec) || DEFAULTS.timeLimitSec), timeLo, TIME_MAX_SEC)
    if (!Array.isArray(merged.warnPct) || merged.warnPct.length === 0) merged.warnPct = DEFAULTS.warnPct
    // 兼容 V1 的 archiveFormat
    if (typeof merged.archiveFormat === 'string' && merged.archiveMode === undefined) {
      merged.archiveMode = merged.archiveFormat === 'json' ? 'full' : merged.archiveFormat === 'both' ? 'both' : 'brief'
    }
    delete merged.archiveFormat
    if (merged.archiveMode === 'ai') merged.archiveMode = 'full' // 0.2.2 及更早的「AI 联动分析」
    if (!['brief', 'full', 'both'].includes(merged.archiveMode)) merged.archiveMode = 'brief'
    if (!['zh', 'en'].includes(merged.lang)) merged.lang = 'zh'
    if (!['s', 'm', 'l'].includes(merged.panelSize)) merged.panelSize = 'm'
    merged.ball = merged.ball !== false
    merged.archiveEnabled = merged.archiveEnabled !== false
    settings = merged
    log(`设置已更新：enabled=${settings.enabled} token=${settings.tokenLimit} time=${settings.timeLimitSec}s`)
    // 关掉时把所有正在跑的周期标脏，避免状态显示错乱
    if (settings.enabled !== true) {
      for (const c of cycles.values()) c.stopping = c.stopping === true
    }
    flushStatus(true)
  }

  /** 桌面端改设置后立刻生效（写文件的外部入口，也给测试用）。 */
  function applySettings(patch) {
    const merged = { ...settings, ...patch }
    if (writeJsonAtomic(settingsFile, merged)) {
      reloadSettings(true)
      return true
    }
    return false
  }

  // ------------------------------------------------------------------ 状态

  function cycleView(c) {
    const now = clock.now()
    const limit = settings.tokenLimit
    const used = c.used + estimateTokens(c)
    const elapsed = c.stopping === true ? c.stoppedElapsedMs ?? now - c.startAt : now - c.startAt
    return {
      sid: c.sid,
      title: c.title,
      turn: c.turn,
      used: Math.round(used),
      usedExact: Math.round(c.used),
      estimated: Math.round(estimateTokens(c)),
      limit,
      elapsedMs: Math.max(0, Math.round(elapsed)),
      timeLimitMs: settings.timeLimitSec * 1000,
      state: c.stopping === true ? 'awaiting' : c.paused === true ? 'idle' : 'running',
      trigger: c.stopKind,
      continues: c.continues,
      model: c.model,
      warned: [...c.warned],
    }
  }

  function status() {
    const list = [...cycles.values()].map(cycleView)
    const active = list.find((x) => x.state === 'running') ?? list.find((x) => x.state === 'awaiting') ?? list[0] ?? null
    return {
      plugin: 'dsh-tlock',
      label: 'T约束',
      version: VERSION,
      at: clock.now(),
      pid: process.pid,
      enabled: settings.enabled === true,
      settings: {
        tokenLimit: settings.tokenLimit,
        timeLimitSec: settings.timeLimitSec,
        warnPct: settings.warnPct,
        archiveEnabled: settings.archiveEnabled,
        archiveMode: settings.archiveMode,
        archiveRoot: archiveRoot(),
        lang: settings.lang,
        ball: settings.ball,
        panelSize: settings.panelSize,
        tokenMin: TOKEN_MIN,
        tokenMax: TOKEN_MAX,
        timeMinSec: TIME_MIN_SEC,
        timeMaxSec: TIME_MAX_SEC,
        autoStart: settings.autoStart,
        snapshotOnInterrupt: settings.snapshotOnInterrupt,
      },
      active,
      sessions: list,
      lastArchive,
      history: readHistory().slice(0, 30),
      stateDir: dir,
    }
  }

  function flushStatus(force = false) {
    const now = clock.now()
    if (!force && now - lastStatusAt < 400) return
    lastStatusAt = now
    const value = status()
    const json = JSON.stringify(value)
    if (json === lastStatusJson && !force) return
    lastStatusJson = json
    writeJsonAtomic(statusFile, value)
  }

  // ------------------------------------------------------------------ 命令

  function pollCommands() {
    const payload = readJson(commandsFile, null)
    if (payload === null) return
    const list = Array.isArray(payload) ? payload : Array.isArray(payload.commands) ? payload.commands : []
    for (const command of list) {
      const id = Number(command?.id ?? 0)
      if (!(id > consumedCommandId)) continue
      consumedCommandId = id
      try {
        handleCommand(command)
      } catch (error) {
        log(`命令失败 ${command?.action}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  function handleCommand(command) {
    const action = String(command?.action ?? '')
    if (action === 'pause' || action === 'resume') {
      applySettings({ enabled: action === 'resume' })
      return
    }
    if (action === 'archive-off' || action === 'archive-on') {
      applySettings({ archiveEnabled: action === 'archive-on' })
      return
    }
    if (action === 'continue') {
      const target = command.sid ? cycles.get(String(command.sid)) : [...cycles.values()].reverse()[0]
      if (target) continueCycle(target)
      return
    }
    if (action === 'end') {
      const target = command.sid ? cycles.get(String(command.sid)) : [...cycles.values()].reverse()[0]
      if (target && target.stopping === true) {
        cycles.delete(target.sid)
        log(`本轮已结束并保留归档：${target.archivedTo ?? '(未归档)'}`)
        flushStatus(true)
      }
      return
    }
    if (action === 'archive') {
      const target = command.sid ? cycles.get(String(command.sid)) : [...cycles.values()].reverse()[0]
      if (target) archiveCycle(target, target.stopKind ?? 'token', { force: true })
      return
    }
    if (action === 'stop') {
      // 手动「到此为止」：像用户按停止键一样断掉，并按手动结束归档
      const target = command.sid ? cycles.get(String(command.sid)) : [...cycles.values()].reverse()[0]
      if (target === undefined || target.stopping === true) return
      target.stopping = true
      target.stopKind = 'manual'
      target.stoppedElapsedMs = clock.now() - target.startAt
      archiveCycle(target, 'manual', { snapshot: true })
      const agent = currentAgent(target)
      try {
        agent?.cancel?.({ kind: 'hook', reason: 'tlock:manual-stop' }, { keepInbox: true })
      } catch (error) {
        log(`手动停止失败：${error instanceof Error ? error.message : String(error)}`)
      }
      flushStatus(true)
      return
    }
  }

  // ------------------------------------------------------------------ 计量

  function estimateTokens(c) {
    return Math.ceil((c.estChars ?? 0) / CHARS_PER_TOKEN)
  }

  function newCycle(sid, turn) {
    return {
      sid,
      turn: turn ?? 0,
      startAt: clock.now(),
      used: 0,
      estChars: 0,
      attemptChars: 0,
      agent: null,
      title: '',
      model: '',
      text: [],
      reasoning: [],
      tools: [],
      liveText: '',
      liveReasoning: '',
      warned: new Set(),
      stopping: false,
      stopKind: null,
      stoppedElapsedMs: null,
      continues: 0,
      awaitingContinue: false,
      archivedTo: null,
      archiveWritten: false,
    }
  }

  function cycleFor(sid) {
    let c = cycles.get(sid)
    if (c === undefined) {
      c = newCycle(sid, 0)
      cycles.set(sid, c)
    }
    return c
  }

  function currentAgent(c) {
    if (c.agent !== null && c.agent !== undefined) return c.agent
    try {
      const found = agentsRegistry?.get?.(c.sid)
      if (found !== undefined) c.agent = found
      return found
    } catch {
      return undefined
    }
  }

  // ------------------------------------------------------------------ 闸门

  function checkGates(c) {
    if (disposed || settings.enabled !== true) return
    if (c.stopping === true || c.paused === true) return
    if (c.continues > 50) return
    const used = c.used + estimateTokens(c)
    const limit = settings.tokenLimit

    // 预警（只上报，不动模型）
    for (const pct of [...settings.warnPct].sort((a, b) => a - b)) {
      const mark = Math.round(pct * 100)
      if (c.warned.has(mark)) continue
      if (used >= limit * pct && used < limit) {
        c.warned.add(mark)
        log(`预警 ${mark}%：本轮已用 ${fmtTokens(used)} / ${fmtTokens(limit)}`)
        flushStatus(true)
      }
    }

    if (used >= limit) trigger(c, 'token')
  }

  function checkTimeGates() {
    if (disposed || settings.enabled !== true) return
    const now = clock.now()
    for (const c of cycles.values()) {
      if (c.stopping === true || c.paused === true) continue
      if (now - c.startAt >= settings.timeLimitSec * 1000) trigger(c, 'time')
    }
  }

  function trigger(c, kind) {
    if (c.stopping === true) return
    const elapsed = clock.now() - c.startAt
    c.stopping = true
    c.stopKind = kind
    c.stoppedElapsedMs = elapsed
    log(`${kind === 'token' ? 'token 到量' : '时间到点'}：硬断（已用 ${fmtTokens(c.used + estimateTokens(c))}，${fmtDuration(elapsed)}）`)

    // 先存快照
    if (settings.snapshotOnInterrupt === true) archiveCycle(c, kind, { snapshot: true })

    const agent = currentAgent(c)
    if (agent === undefined || typeof agent.cancel !== 'function') {
      log('没有拿到 Agent，无法硬断（只记录状态）')
      flushStatus(true)
      return
    }
    try {
      agent.cancel({ kind: 'hook', reason: `tlock:${kind}-limit` }, { keepInbox: true })
    } catch (error) {
      log(`cancel 失败：${error instanceof Error ? error.message : String(error)}`)
    }

    // 兜底：断不干净也要归档（等 interrupted 消息回来再补一次）
    setTimeout(() => {
      if (disposed) return
      if (c.archiveWritten !== true) archiveCycle(c, kind, { snapshot: false })
      flushStatus(true)
    }, 1500).unref?.()
    flushStatus(true)
  }

  /** 用户点「继续生成」：清零本轮额度、接着跑。 */
  function continueCycle(c) {
    if (c.stopping !== true) return
    const agent = currentAgent(c)
    c.continues += 1
    c.stopping = false
    c.stopKind = null
    c.stoppedElapsedMs = null
    c.used = 0
    c.estChars = 0
    c.attemptChars = 0
    c.warned = new Set()
    c.startAt = clock.now()
    c.awaitingContinue = true
    c.archiveWritten = false
    c.archivedTo = null // 下一次打断另起一个文件夹
    log(`继续生成（第 ${c.continues} 次）：额度清零`)

    if (agent === undefined || typeof agent.followup !== 'function') {
      log('没有 Agent，无法自动继续；请直接在输入框再发一条消息')
      flushStatus(true)
      return
    }
    const message = {
      id: `msg_tlock_${Date.now().toString(36)}`,
      role: 'user',
      content: [{ type: 'text', text: '继续' }],
      source: { kind: 'user' },
    }
    try {
      agent.followup(message)
    } catch (error) {
      log(`followup 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    flushStatus(true)
  }

  // ------------------------------------------------------------------ 归档

  /**
   * 写一份归档。snapshot=true 表示这是断点快照（内容可能不全）。
   * @returns 目录路径或 null
   */
  function archiveCycle(c, kind, opts = {}) {
    if (settings.enabled !== true && opts.force !== true) return null
    if (settings.archiveEnabled !== true && opts.force !== true) return null
    const label = KIND_LABEL[kind] ?? KIND_LABEL.token
    const shortId = c.sid.replace(/^session-/, '').replace(/-/g, '').slice(0, 6)
    const title = safeName(c.title || `会话 ${shortId}`)
    const reuse = typeof c.archivedTo === 'string' && c.archivedTo !== ''
    const folder = reuse ? c.archivedTo : path.join(archiveRoot(), label, `${stamp(clock.now())}_${title}`)
    try {
      fs.mkdirSync(folder, { recursive: true })
    } catch (error) {
      log(`建目录失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    }

    const fullText = c.text.join('\n\n').trim() || c.liveText.trim() || '（没有生成任何正文）'
    const fullReasoning = c.reasoning.join('\n').trim() || c.liveReasoning.trim()
    const meta = {
      plugin: 'dsh-tlock',
      version: VERSION,
      trigger: kind,
      triggerLabel: label,
      snapshot: opts.snapshot === true,
      sessionId: c.sid,
      sessionTitle: c.title,
      turn: c.turn,
      model: c.model,
      limit: { tokens: settings.tokenLimit, seconds: settings.timeLimitSec },
      used: {
        outputTokensExact: Math.round(c.used),
        estimatedInFlight: Math.round(estimateTokens(c)),
        total: Math.round(c.used + estimateTokens(c)),
      },
      elapsedMs: Math.round(c.stoppedElapsedMs ?? clock.now() - c.startAt),
      elapsedText: fmtDuration(c.stoppedElapsedMs ?? clock.now() - c.startAt),
      continues: c.continues,
      at: new Date(clock.now()).toISOString(),
      mode: settings.archiveMode,
    }

    const files = []
    const bundle = { meta, text: fullText, reasoning: fullReasoning, tools: c.tools }
    if (settings.archiveMode === 'brief' || settings.archiveMode === 'both') {
      const name = '生成说明.md'
      fs.writeFileSync(path.join(folder, name), renderBrief(meta, bundle), 'utf8')
      files.push(name)
    }
    if (settings.archiveMode === 'full' || settings.archiveMode === 'both') {
      const name = '完整记录.md'
      const body = renderFull(meta, bundle)
      fs.writeFileSync(path.join(folder, name), body, 'utf8')
      files.push(name)
      // 完整记录另外落一份原文 JSON，程序读取时不用再解析 Markdown
      fs.writeFileSync(
        path.join(folder, '完整记录.json'),
        JSON.stringify(
          {
            meta,
            text: bundle.text,
            reasoning: bundle.reasoning,
            tools: bundle.tools ?? [],
          },
          null,
          2,
        ),
        'utf8',
      )
      files.push('完整记录.json')
    }
    fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
    files.push('meta.json')

    c.archivedTo = folder
    c.archiveWritten = true
    lastArchive = {
      path: folder,
      kind,
      kindLabel: label,
      title: c.title,
      mode: settings.archiveMode,
      at: clock.now(),
      tokens: meta.used.total,
      elapsedMs: meta.elapsedMs,
      files,
    }
    recordHistory(lastArchive)
    log(`已归档 → ${folder}`)
    return folder
  }

  /** 去掉那些“莫名其妙的字符”：markdown 记号、代码围栏、链接语法。 */
  function plainText(text) {
    return String(text ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/```[a-zA-Z0-9_+-]*\n?/g, '')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s*[-*+]\s+/gm, '· ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s*>\s?/gm, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function firstParagraph(text, max = 260) {
    const plain = plainText(text)
    const block = plain.split(/\n{2,}/)[0] ?? ''
    const joined = block.replace(/\n/g, ' ').trim()
    if (joined.length <= max) return joined
    return `${joined.slice(0, max)}…`
  }

  function headingsOf(text) {
    const out = []
    for (const line of String(text ?? '').split('\n')) {
      const hit = /^(#{2,4})\s+(.+)$/.exec(line.trim())
      if (hit !== null) out.push(hit[2].replace(/[*`]/g, '').trim())
    }
    return out.slice(0, 8)
  }

  function codeBlocksOf(text) {
    const out = []
    const re = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g
    let hit
    while ((hit = re.exec(String(text ?? ''))) !== null) {
      const code = hit[2].trim()
      if (code !== '') out.push({ lang: hit[1] || 'text', code })
    }
    return out
  }

  /** 简洁描述：给人看，一眼知道这轮在讲什么。 */
  function renderBrief(meta, bundle) {
    const lines = []
    lines.push(`${meta.sessionTitle || '（未命名会话）'} · ${meta.triggerLabel}`)
    lines.push('='.repeat(38))
    lines.push('')
    lines.push(
      `${dateText(meta.at)}　用时 ${meta.elapsedText}　用量 ${fmtTokens(meta.used.total)} / ${fmtTokens(meta.limit.tokens)} token${meta.model ? `　模型 ${meta.model}` : ''}`,
    )
    if (meta.snapshot) lines.push('（断点即时快照：这一份写在硬断那一刻，可能比实际生成少一小段）')
    lines.push('')
    lines.push('这一轮在说什么')
    lines.push('-'.repeat(38))
    lines.push(firstParagraph(bundle.text))
    lines.push('')

    const heads = headingsOf(bundle.text)
    if (heads.length > 0) {
      lines.push('内容的骨架')
      lines.push('-'.repeat(38))
      for (const head of heads) lines.push(`· ${head}`)
      lines.push('')
    }

    const tools = bundle.tools ?? []
    if (tools.length > 0) {
      const counts = new Map()
      for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
      lines.push('动过的东西')
      lines.push('-'.repeat(38))
      for (const [name, count] of counts) lines.push(`· ${name}（${count} 次）`)
      lines.push('')
    }

    const codes = codeBlocksOf(bundle.text)
    if (codes.length > 0) {
      lines.push(`里面有 ${codes.length} 段代码`)
      lines.push('-'.repeat(38))
      codes.forEach((block, index) => {
        const head = block.code.split('\n')[0].slice(0, 80)
        lines.push(`· 第 ${index + 1} 段（${block.lang}）：${head}`)
      })
      lines.push('')
    }

    lines.push('正文')
    lines.push('-'.repeat(38))
    lines.push(bundle.text)
    lines.push('')
    if (bundle.reasoning !== '') {
      lines.push('思考（压缩）')
      lines.push('-'.repeat(38))
      const compressed = compressReasoning(bundle.reasoning)
      if (compressed.compressed) lines.push(`（原文 ${compressed.length} 字，这里只留首尾各 300 字）`, '')
      lines.push(compressed.text)
      lines.push('')
    }
    // 明确写出「这份省略了什么」，不让人猜
    lines.push('这份省略了什么')
    lines.push('-'.repeat(38))
    const notes = []
    if (bundle.reasoning !== '') {
      const compressed = compressReasoning(bundle.reasoning)
      if (compressed.compressed) {
        notes.push(`· 思考过程：原文 ${compressed.length} 字，只留首尾各 300 字，中间约 ${compressed.length - 600} 字被压缩`)
      } else {
        notes.push('· 思考过程：完整保留（不足 600 字）')
      }
    } else {
      notes.push('· 思考过程：这一轮没有暴露思考')
    }
    const toolsAll = bundle.tools ?? []
    if (toolsAll.length > 0) {
      const argChars = toolsAll.reduce((sum, tool) => sum + String(tool.args ?? '').length, 0)
      notes.push(`· 工具调用：只记了名字和次数（共 ${toolsAll.length} 次、约 ${argChars} 字参数），参数与返回结果完整版在「完整记录」里`)
    }
    const codesAll = codeBlocksOf(bundle.text)
    if (codesAll.length > 0) {
      notes.push(`· 代码：只列了 ${codesAll.length} 段的首行，全文就是上面的「正文」原文`)
    }
    notes.push('· 正文：没有删减，硬断时的内容就是这一份')
    for (const note of notes) lines.push(note)
    lines.push('')
    lines.push('想要一字不落的一份，把归档模式切成「归档完全记录」。')
    lines.push('')
    lines.push(`— T约束 · ${meta.triggerLabel} · ${dateText(meta.at)}`)
    return lines.join('\n')
  }

    /** 归档完全记录：一字不落，思考、正文、工具调用参数、代码全都在。 */
  function renderFull(meta, bundle) {
    const lines = []
    lines.push(`# 归档完全记录 · ${meta.sessionTitle || '（未命名会话）'}`)
    lines.push('')
    lines.push('> 这一份不省略任何内容：思考过程按原文全给，工具调用连参数一起记，正文一字不改。')
    lines.push('')
    lines.push('## 元信息')
    lines.push('')
    lines.push(`- 触发：${meta.triggerLabel}`)
    lines.push(`- 会话：${meta.sessionTitle || '（未命名会话）'}（第 ${meta.turn} 轮）`)
    lines.push(`- 模型：${meta.model || '（未知）'}`)
    lines.push(`- 限额：${meta.limit.tokens} token / ${meta.limit.seconds} 秒`)
    lines.push(`- 用量：${meta.used.total} token（精确 ${meta.used.outputTokensExact}，流式估算 ${meta.used.estimatedInFlight}）`)
    lines.push(`- 耗时：${meta.elapsedText}`)
    lines.push(`- 继续次数：${meta.continues}`)
    lines.push(`- 时间：${dateText(meta.at)}`)
    lines.push('')
    lines.push('## 完整思考过程')
    lines.push('')
    lines.push(bundle.reasoning === '' ? '（这一轮没有暴露思考过程，不是被省略）' : bundle.reasoning)
    lines.push('')
    lines.push('## 正文（原文）')
    lines.push('')
    lines.push(bundle.text)
    lines.push('')
    const tools = bundle.tools ?? []
    if (tools.length > 0) {
      lines.push('## 工具调用（完整参数）')
      lines.push('')
      tools.forEach((tool, index) => {
        lines.push(`### ${index + 1}. ${tool.name}`)
        lines.push('')
        lines.push('```json')
        lines.push(String(tool.args ?? ''))
        lines.push('```')
        lines.push('')
        if (tool.result !== undefined && tool.result !== '') {
          lines.push('返回：')
          lines.push('')
          lines.push('```')
          lines.push(String(tool.result))
          lines.push('```')
          lines.push('')
        }
      })
    }
    const codes = codeBlocksOf(bundle.text)
    if (codes.length > 0) {
      lines.push('## 代码片段索引')
      lines.push('')
      codes.forEach((block, index) => {
        lines.push(`- 片段 ${index + 1}（${block.lang}，${block.code.split('\n').length} 行）`)
      })
      lines.push('')
      lines.push('（全文见上面「正文（原文）」，这里不重复粘贴。）')
      lines.push('')
    }
    return lines.join('\n')
  }

  function dateText(iso) {
    try {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    } catch {
      return String(iso)
    }
  }

  // ------------------------------------------------------------------ 历史

  function readHistory() {
    const value = readJson(historyFile, { items: [] })
    const items = Array.isArray(value?.items) ? value.items : Array.isArray(value) ? value : []
    return items.filter((item) => item !== null && typeof item === 'object')
  }

  function recordHistory(entry) {
    try {
      const items = readHistory()
      const next = {
        id: `${entry.at}-${String(entry.path ?? '').slice(-16)}`,
        at: entry.at,
        kind: entry.kind,
        kindLabel: entry.kindLabel,
        title: entry.title ?? '',
        mode: entry.mode,
        tokens: entry.tokens,
        elapsedMs: entry.elapsedMs,
        path: entry.path,
        files: entry.files ?? [],
      }
      const index = items.findIndex((item) => item.path === next.path)
      if (index >= 0) items[index] = next
      else items.unshift(next)
      writeJsonAtomic(historyFile, { items: items.slice(0, 200) })
    } catch (error) {
      log(`历史写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ------------------------------------------------------------------ 事件

  function onSessionEvent(session, event) {
    if (disposed) return
    try {
      const sid = session?.id
      if (typeof sid !== 'string' || sid === '') return
      if (settings.enabled !== true) return
      const type = event?.type
      const data = event?.data ?? {}

      if (type === 'turn/start') {
        const existing = cycles.get(sid)
        if (existing !== undefined && existing.awaitingContinue === true) {
          existing.awaitingContinue = false
          existing.turn = data.turn ?? existing.turn
          existing.stopping = false
          existing.stopKind = null
          existing.startAt = clock.now()
          return
        }
        cycles.set(sid, newCycle(sid, data.turn))
        flushStatus(true)
        return
      }

      const c = cycles.get(sid)
      if (c === undefined) return

      if (type === 'session/title') {
        const title = data?.title ?? data?.text
        if (typeof title === 'string' && title.trim() !== '') {
          c.title = title.trim()
          flushStatus(true)
        }
        return
      }

      if (type === 'model/selection') {
        if (typeof data?.model === 'string') c.model = data.model
        return
      }

      if (type === 'tool/result') {
        const message = data?.message
        const callId = typeof message?.callId === 'string' ? message.callId : ''
        if (callId !== '' && Array.isArray(message?.content)) {
          const parts = []
          for (const block of message.content) {
            if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
          }
          const text = parts.join('\n').slice(0, 20000)
          if (text !== '') {
            for (let i = c.tools.length - 1; i >= 0; i -= 1) {
              if (c.tools[i].id === callId) {
                c.tools[i].result = text
                break
              }
            }
          }
        }
        return
      }

      if (type === 'assistant/message') {
        const tokens = outputTokensOf(event)
        if (tokens > 0) c.used += tokens
        c.estChars = 0
        c.attemptChars = 0
        const out = foldBlocks(data?.message?.content, {
          text: c.text,
          reasoning: c.reasoning,
          tools: c.tools,
        })
        c.text = out.text
        c.reasoning = out.reasoning
        c.tools = out.tools
        // 断后补全：interrupted 的这条消息回来时覆盖同一份快照，换成精确用量与完整正文
        if (c.stopping === true && data?.interrupted === true) {
          archiveCycle(c, c.stopKind ?? 'token', { snapshot: false })
        }
        flushStatus(true)
        checkGates(c)
        return
      }

      if (type === 'turn/end') {
        if (c.stopping === true) {
          archiveCycle(c, c.stopKind ?? 'token', { snapshot: false })
          flushStatus(true)
          return
        }
        cycles.delete(sid)
        flushStatus(true)
        return
      }
    } catch (error) {
      log(`session/event 处理失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function onFrame(payload) {
    if (disposed || settings.enabled !== true) return
    try {
      const agent = payload?.agent
      const frame = payload?.frame
      const sid = agent?.session?.id ?? agent?.id
      if (typeof sid !== 'string' || sid === '') return
      const c = cycles.get(sid)
      if (c === undefined) return
      // 已经硬断/手动停止后，残留的流不再计入（否则用量会越过上限继续涨）
      if (c.stopping === true) return
      if (c.agent === null || c.agent === undefined) c.agent = agent
      if (c.title === '' && typeof agent?.options?.sessionTitle === 'string') c.title = agent.options.sessionTitle

      if (frame?.type === 'start') {
        c.attemptChars = 0
        return
      }
      if (frame?.type === 'end') {
        return
      }
      if (frame?.type !== 'chunk') return
      const chunk = frame.chunk
      if (chunk === undefined || chunk === null) return
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        c.estChars += chunk.text.length
        c.liveText += chunk.text
        lastStatusAt = 0
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        c.estChars += chunk.text.length
        c.liveReasoning += chunk.text
      } else if (chunk.type === 'tool-call-delta' && typeof chunk.argumentsDelta === 'string') {
        c.estChars += chunk.argumentsDelta.length
      } else if (chunk.type === 'usage') {
        // 有一次调用的精确 usage 就把估算清零（消息事件里还会再计一次，这里只修正估算）
        c.estChars = 0
        c.liveText = ''
        return
      }
      checkGates(c)
      flushStatus()
    } catch (error) {
      log(`assistant-stream 处理失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ------------------------------------------------------------------ 路由

  function sendJson(res, code, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > 1 << 20) reject(new Error('body too large'))
      })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
  }

  // 在文件管理器里打开归档目录
/** 打开任意已存在的归档子路径（文件则打开所在目录）。 */
function openPath(target) {
  try {
    const file = path.resolve(String(target ?? ''))
    if (!fs.existsSync(file)) return { ok: false, code: 'not-found' }
    const isDir = fs.statSync(file).isDirectory()
    const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const args = isDir ? [file] : [path.dirname(file)]
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
    return { ok: true, path: file }
  } catch (error) {
    return { ok: false, code: 'open-failed', message: error instanceof Error ? error.message : String(error) }
  }
}

function openArchiveRoot() {
  const target = archiveRoot()
  try {
    fs.mkdirSync(target, { recursive: true })
  } catch {}
  try {
    if (process.platform === 'win32') {
      // explorer 对含空格的路径也接受单参数形式；用 execFile 避免 shell 解析
      spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
    }
    return { ok: true, path: target }
  } catch (error) {
    return { ok: false, code: 'open-failed', path: target, message: String(error && error.message) }
  }
}

/** 只允许访问归档根目录内的文件，防止路径穿越。 */
function insideArchiveRoot(target) {
  const root = path.resolve(archiveRoot())
  const file = path.resolve(String(target ?? ''))
  return file === root || file.startsWith(root + path.sep)
}

/** 读一份归档：meta + 文本文件内容，供面板内查看。 */
function readArchive(target) {
  if (!insideArchiveRoot(target)) return { ok: false, code: 'outside-root' }
  const folder = path.resolve(String(target))
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return { ok: false, code: 'not-found' }
  let meta = null
  const metaFile = path.join(folder, 'meta.json')
  try {
    if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  } catch {
    meta = null
  }
  const files = []
  for (const name of fs.readdirSync(folder)) {
    const full = path.join(folder, name)
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    const entry = { name, size: stat.size, text: null, binary: false }
    if (/\.(md|json|txt|log|ya?ml)$/i.test(name) && stat.size <= 2 * 1024 * 1024) {
      try {
        entry.text = fs.readFileSync(full, 'utf8')
      } catch {
        entry.binary = true
      }
    } else {
      entry.binary = true
    }
    files.push(entry)
  }
  files.sort((a, b) => (a.name === '生成说明.md' ? -1 : b.name === '生成说明.md' ? 1 : a.name.localeCompare(b.name)))
  return { ok: true, path: folder, name: path.basename(folder), meta, files }
}

/** 重命名归档目录（保留时间前缀）或目录内某个文件。 */
function renameArchive(body) {
  const target = String(body?.path ?? '')
  if (!insideArchiveRoot(target)) return { ok: false, code: 'outside-root' }
  const folder = path.resolve(target)
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return { ok: false, code: 'not-found' }

  const fileName = String(body?.file ?? '')
  if (fileName !== '') {
    const clean = safeName(String(body?.name ?? '')).replace(/\.[^.]*$/, '')
    if (clean === '') return { ok: false, code: 'empty-name' }
    const ext = path.extname(fileName)
    const from = path.join(folder, fileName)
    if (!fs.existsSync(from)) return { ok: false, code: 'file-not-found' }
    const to = path.join(folder, clean + ext)
    if (from !== to && fs.existsSync(to)) return { ok: false, code: 'exists' }
    try {
      if (from !== to) fs.renameSync(from, to)
    } catch (error) {
      return { ok: false, code: 'rename-failed', message: error instanceof Error ? error.message : String(error) }
    }
    updateHistoryFiles(folder)
    return { ok: true, path: folder, name: path.basename(folder) }
  }

  const rawTitle = String(body?.title ?? '').trim()
  if (rawTitle === '') return { ok: false, code: 'empty-title' }
  const title = safeName(rawTitle)
  const base = path.basename(folder)
  const stampPart = /^(\d{8}-\d{6})_/.exec(base)?.[1]
  const newBase = stampPart !== undefined ? `${stampPart}_${title}` : title
  const parent = path.dirname(folder)
  const next = path.join(parent, newBase)
  if (next !== folder && fs.existsSync(next)) return { ok: false, code: 'exists' }
  try {
    if (next !== folder) fs.renameSync(folder, next)
  } catch (error) {
    return { ok: false, code: 'rename-failed', message: error instanceof Error ? error.message : String(error) }
  }
  try {
    const metaFile = path.join(next, 'meta.json')
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      meta.displayTitle = title
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8')
    }
  } catch {
    // 忽略
  }
  replaceHistoryPath(folder, next, title)
  return { ok: true, path: next, name: newBase }
}

function updateHistoryFiles(folder) {
  try {
    const files = fs.readdirSync(folder).filter((name) => fs.statSync(path.join(folder, name)).isFile())
    const items = readHistory()
    const index = items.findIndex((item) => item.path === folder)
    if (index >= 0) {
      items[index] = { ...items[index], files }
      writeJsonAtomic(historyFile, { items })
    }
  } catch {
    // 忽略
  }
}

function replaceHistoryPath(from, to, title) {
  try {
    const items = readHistory()
    const index = items.findIndex((item) => item.path === from)
    if (index >= 0) {
      items[index] = { ...items[index], path: to, title }
      writeJsonAtomic(historyFile, { items })
    }
  } catch {
    // 忽略
  }
}

async function routeHandler(req, res) {
    try {
      const url = new URL(req.url ?? ROUTE_PREFIX, 'http://localhost')
      const route = url.pathname
      const method = req.method ?? 'GET'
      if (route === `${ROUTE_PREFIX}/state` && method === 'GET') {
        reloadSettings()
        pollCommands()
        return sendJson(res, 200, status())
      }
      if (route === `${ROUTE_PREFIX}/history` && method === 'GET') {
        return sendJson(res, 200, { items: readHistory().slice(0, 100) })
      }
      if (route === `${ROUTE_PREFIX}/set` && method === 'POST') {
        let patch
        try {
          const raw = JSON.parse((await readBody(req)) || '{}')
          patch = raw?.patch ?? raw
        } catch {
          return sendJson(res, 400, { ok: false, code: 'bad-json' })
        }
        if (patch === null || typeof patch !== 'object') return sendJson(res, 400, { ok: false, code: 'bad-input' })
        const clean = {}
        if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled
        if (typeof patch.archiveEnabled === 'boolean') clean.archiveEnabled = patch.archiveEnabled
        if (typeof patch.ball === 'boolean') clean.ball = patch.ball
        if (typeof patch.autoStart === 'boolean') clean.autoStart = patch.autoStart
        if (typeof patch.tokenLimit === 'number') clean.tokenLimit = clamp(Math.round(patch.tokenLimit), tokenLo, TOKEN_MAX)
        if (typeof patch.timeLimitSec === 'number') clean.timeLimitSec = clamp(Math.round(patch.timeLimitSec), timeLo, TIME_MAX_SEC)
        if (patch.archiveMode === 'brief' || patch.archiveMode === 'full' || patch.archiveMode === 'both') clean.archiveMode = patch.archiveMode
        if (patch.archiveMode === 'ai') clean.archiveMode = 'full'
        if (patch.lang === 'zh' || patch.lang === 'en') clean.lang = patch.lang
        if (patch.panelSize === 's' || patch.panelSize === 'm' || patch.panelSize === 'l') clean.panelSize = patch.panelSize
        if (Object.keys(clean).length === 0) return sendJson(res, 400, { ok: false, code: 'nothing-to-set' })
        applySettings(clean)
        return sendJson(res, 200, { ok: true, settings: status().settings })
      }
      if (route === `${ROUTE_PREFIX}/cmd` && method === 'POST') {
        let body
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch {
          return sendJson(res, 400, { ok: false, code: 'bad-json' })
        }
        const action = String(body?.action ?? '')
        if (action === 'open') {
          openArchiveRoot()
          return sendJson(res, 200, { ok: true, action })
        }
        if (action === 'open-path') {
          const target = String(body?.path ?? '')
          if (!insideArchiveRoot(target)) return sendJson(res, 400, { ok: false, code: 'outside-root' })
          return sendJson(res, 200, openPath(target))
        }
        if (!['continue', 'end', 'stop', 'archive', 'pause', 'resume', 'archive-on', 'archive-off'].includes(action)) {
          return sendJson(res, 400, { ok: false, code: 'bad-action' })
        }
        handleCommand({ action, sid: body?.sid })
        flushStatus(true)
        return sendJson(res, 200, { ok: true, action })
      }
      if (route === `${ROUTE_PREFIX}/archive` && method === 'GET') {
        const target = url.searchParams.get('path') ?? ''
        return sendJson(res, 200, readArchive(target))
      }
      if (route === `${ROUTE_PREFIX}/rename` && method === 'POST') {
        let body
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch {
          return sendJson(res, 400, { ok: false, code: 'bad-json' })
        }
        return sendJson(res, 200, renameArchive(body))
      }
      if (route === `${ROUTE_PREFIX}/open` && method === 'POST') {
        const result = openArchiveRoot()
        return sendJson(res, 200, result)
      }
      if (route === `${ROUTE_PREFIX}/health`) {
        return sendJson(res, 200, { ok: true, name: 'dsh-tlock', version: VERSION })
      }
      return sendJson(res, 404, { ok: false, code: 'not-found' })
    } catch (error) {
      log(`路由失败：${error instanceof Error ? error.message : String(error)}`)
      return sendJson(res, 500, { ok: false, code: 'internal' })
    }
  }

  // ------------------------------------------------------------------ 装配

  let timeTimer = null
  let pollTimer = null
  let statusTimer = null

  function start() {
    fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(settingsFile)) writeJsonAtomic(settingsFile, { ...DEFAULTS })
    reloadSettings(true)

    ctx.on?.('session/event', onSessionEvent)
    ctx.on?.('agent/assistant-stream', (payload) => onFrame(payload), { global: true })

    try {
      ctx.inject?.(['agents'], (scoped) => {
        agentsRegistry = scoped?.agents ?? null
      })
    } catch {
      /* agents 服务缺失时用流式帧里的 agent 兜底 */
    }

    try {
      ctx.inject?.(['webServer'], (scoped) => {
        scoped.effect?.(() => {
          const dispose = scoped.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: routeHandler })
          return dispose
        }, 'dsh-tlock: routes')
      })
    } catch (error) {
      log(`路由注册跳过：${error instanceof Error ? error.message : String(error)}`)
    }

    timeTimer = setInterval(() => {
      checkTimeGates()
      flushStatus()
    }, 250)
    timeTimer.unref?.()

    pollTimer = setInterval(() => {
      reloadSettings()
      pollCommands()
    }, 500)
    pollTimer.unref?.()

    statusTimer = setInterval(() => flushStatus(), 800)
    statusTimer.unref?.()

    ctx.effect?.(() => () => dispose())

    log(`已加载 v${VERSION}（enabled=${settings.enabled}，token=${settings.tokenLimit}，time=${settings.timeLimitSec}s，state=${dir}）`)
    flushStatus(true)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const timer of [timeTimer, pollTimer, statusTimer]) if (timer !== null) clearInterval(timer)
    writeJsonAtomic(statusFile, { ...status(), at: clock.now(), stopped: true, enabled: false })
  }

  return {
    start,
    dispose,
    status,
    settings: () => ({ ...settings }),
    applySettings,
    // 测试入口
    _cycles: cycles,
    _onSessionEvent: onSessionEvent,
    _onFrame: onFrame,
    _trigger: trigger,
    _archive: archiveCycle,
    _continue: continueCycle,
    _checkTimeGates: checkTimeGates,
    _pollCommands: pollCommands,
    _flushStatus: flushStatus,
    _route: routeHandler,
    _status: status,
    _files: { settingsFile, statusFile, commandsFile, historyFile, dir },
    _archiveRoot: archiveRoot,
  }
}

/** cordis 插件入口。 */
export function apply(ctx, config) {
  const runtime = createTlock({ ctx, config })
  runtime.start()
  return runtime
}

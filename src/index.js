// dsh-gateway-notify: a push to your phone or team chat when a dsh agent's
// turn ends after running a while, when it fails, or when it has been waiting
// on your approval. A port of @magpie-community/gateway-notify (MIT) from
// magpie's request/response hooks to dsh's persisted session events.
//
// dsh tells us when a turn opens and closes (turn/start, turn/end with its
// reason) and when an approval is asked and decided, so the request-sniffing
// heuristics of the gateway version (tool-call detection, subagent and
// background-agent guessing) are replaced by these facts. Nothing here throws
// into the agent, and nothing is awaited on its path.
import Schema from '@deepseek-ai/schemastery'
import { send, usable, cut } from './channels.js'

export const name = 'dsh-gateway-notify'

const KINDS = ['ntfy', 'bark', 'gotify', 'serverchan', 'feishu', 'dingtalk', 'wecom', 'telegram', 'webhook']

const Channel = Schema.object({
  type: Schema.union(KINDS).required(),
  off: Schema.boolean().description('Keep the entry but send nothing to it.'),
  server: Schema.string().description('ntfy / Bark / Gotify / Telegram API server.'),
  topic: Schema.string().description('ntfy topic.'),
  token: Schema.string().description('ntfy access token, Gotify app token, or Telegram bot token. Use env:NAME to read it from the environment.'),
  key: Schema.string().description('Bark device key or Server酱 SendKey. Use env:NAME.'),
  chatId: Schema.string().description('Telegram chat id.'),
  webhook: Schema.string().description('Feishu / DingTalk / WeCom robot webhook. Use env:NAME.'),
  secret: Schema.string().description('Feishu / DingTalk signing secret. Use env:NAME.'),
  url: Schema.string().description('Generic webhook URL.'),
  headers: Schema.dict(Schema.string()).description('Generic webhook headers.'),
  priority: Schema.number(),
  tags: Schema.array(Schema.string()),
  group: Schema.string(),
  sound: Schema.string(),
})

export const Config = Schema.object({
  channels: Schema.array(Channel).default([]).description('Where to push. Any string field may be env:NAME.'),
  minMinutes: Schema.number().min(0).default(3).description('Only push for turns that ran at least this long.'),
  cooldownSeconds: Schema.number().min(0).default(30).description('At most one push per session in this window.'),
  errors: Schema.boolean().default(true).description('Push when a turn ends in an error, however short.'),
  approvals: Schema.boolean().default(true).description('Push when an approval has waited approvalDelaySeconds unanswered.'),
  approvalDelaySeconds: Schema.number().min(0).default(60),
  subagents: Schema.boolean().default(false).description('Also push for subagent sessions (those with a parent session).'),
  includeText: Schema.boolean().default(false).description('Add the start of the final reply. Off by default: replies stay on your machine.'),
  maxTextLength: Schema.natural().default(200),
  lang: Schema.union(['en', 'zh']).default('en'),
})

const words = {
  en: { done: 'done', failed: 'failed', waiting: 'needs approval', took: 'took', model: 'Model', tool: 'Tool', truncated: 'hit the output-token limit', h: 'h', min: 'min', s: 's' },
  zh: { done: '完成', failed: '失败', waiting: '等待审批', took: '用时', model: '模型', tool: '工具', truncated: '触达输出 token 上限', h: '小时', min: '分钟', s: '秒' },
}

export function duration(ms, w) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} ${w.s}`
  const min = Math.round(s / 60)
  if (min < 60) return `${min} ${w.min}`
  const h = Math.floor(min / 60), rest = min % 60
  return rest ? `${h} ${w.h} ${rest} ${w.min}` : `${h} ${w.h}`
}

const project = (cwd) => (cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '')

/** Build the push. kind: done | failed | waiting. Pure, for tests. */
export function message(kind, info, o) {
  const w = words[o.lang] ?? words.en
  const proj = project(info.cwd)
  const icon = kind === 'done' ? '✅' : kind === 'failed' ? '❌' : '⏳'
  const title = `${icon} dsh ${w[kind]}${proj ? ` · ${proj}` : ''}`
  const lines = []
  if (info.ms != null) lines.push(`${w.took} ${duration(info.ms, w)}`)
  if (info.model) lines.push(`${w.model}: ${info.model}`)
  if (info.maxTokens) lines.push(w.truncated)
  if (kind === 'failed' && info.error) lines.push(cut(info.error, 200))
  if (kind === 'waiting' && info.toolName) lines.push(`${w.tool}: ${info.toolName}`)
  if (o.includeText && info.text && o.maxTextLength) {
    const flat = info.text.replace(/\s+/g, ' ').trim()
    if (flat) { const short = cut(flat, o.maxTextLength); lines.push('', short.length < flat.length ? `${short}…` : flat) }
  }
  return {
    title, body: lines.join('\n'), ok: kind === 'done',
    event: { kind, model: info.model ?? '', project: proj, seconds: info.ms == null ? null : Math.round(info.ms / 1000), session: info.session },
  }
}

const textOf = (msg) => (Array.isArray(msg?.content) ? msg.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : typeof msg?.content === 'string' ? msg.content : '')

/**
 * The plugin's state machine, independent of Cordis so tests can drive it.
 * @param {object} o  resolved config
 * @param {{ now?: () => number, later?: Function, cancel?: Function, send?: Function }} io
 */
export function createNotifier(o, io = {}) {
  const now = io.now ?? (() => Date.now())
  const later = io.later ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
  const cancel = io.cancel ?? ((t) => clearTimeout(t))
  const push = io.send ?? send
  const channels = (o.channels ?? []).filter(usable)
  const turns = new Map() // session id -> { start, text, maxTokens }
  const approvals = new Map() // approval id -> timer
  const sentAt = new Map()
  const pending = new Set()
  let disposed = false

  function fire(sessionId, kind, info) {
    if (disposed || channels.length === 0) return
    if (now() - (sentAt.get(sessionId) ?? -Infinity) < o.cooldownSeconds * 1000) return
    sentAt.set(sessionId, now())
    const m = message(kind, { ...info, session: sessionId }, o)
    // one channel failing, even synchronously, never stops the others
    const job = Promise.allSettled(channels.map(async (c) => push(c, m))).finally(() => pending.delete(job))
    pending.add(job)
  }

  function modelOf(session) {
    try { return session.requestHeader?.()?.config?.model } catch { return undefined }
  }

  function onEvent(session, event) {
    if (disposed) return
    try {
      const header = session?.header ?? {}
      const id = header.id ?? session?.id
      if (id === undefined) return
      if (header.parentSession !== undefined && !o.subagents) return
      const t = typeof event.time === 'number' ? event.time : now()
      switch (event.type) {
        case 'turn/start':
          turns.set(id, { start: t, text: '', maxTokens: false })
          break
        case 'assistant/message': {
          const turn = turns.get(id)
          if (turn && o.includeText) { const x = textOf(event.data?.message); if (x) turn.text = x }
          break
        }
        case 'turn/end': {
          const turn = turns.get(id)
          turns.delete(id)
          if (!turn) return
          const reason = event.data?.reason?.kind
          const ms = t - turn.start
          const info = { ms, cwd: header.cwd, model: modelOf(session), text: turn.text }
          if (reason === 'completed' || reason === 'max-tokens') {
            if (ms >= o.minMinutes * 60_000) fire(id, 'done', { ...info, maxTokens: reason === 'max-tokens' })
          } else if (reason === 'error') {
            if (o.errors) fire(id, 'failed', { ...info, error: event.data.reason.error?.message })
          }
          // aborted: you pressed stop, so you are at the keyboard. blocked,
          // interrupted, forked: no live turn of yours ended.
          break
        }
        case 'approval/asked': {
          if (!o.approvals) return
          const aid = event.data?.id
          if (aid === undefined || approvals.has(aid)) return
          const timer = later(() => {
            approvals.delete(aid)
            // runs from a timer, outside onEvent's guard: a throw here would be uncaught
            try { fire(`${id}#approval`, 'waiting', { cwd: header.cwd, model: modelOf(session), toolName: event.data.toolName }) } catch {}
          }, o.approvalDelaySeconds * 1000)
          approvals.set(aid, timer)
          break
        }
        case 'approval/decided': {
          const timer = approvals.get(event.data?.id)
          if (timer !== undefined) { cancel(timer); approvals.delete(event.data.id) }
          break
        }
      }
    } catch {}
  }

  // a disposed session's open turn and cooldown stamps are dropped, so a
  // long-running host does not keep one entry per session it ever saw
  function forget(session) {
    try {
      const id = session?.header?.id ?? session?.id
      turns.delete(id); sentAt.delete(id); sentAt.delete(`${id}#approval`)
    } catch {}
  }

  function dispose() {
    disposed = true
    for (const t of approvals.values()) cancel(t)
    approvals.clear(); turns.clear(); sentAt.clear()
  }

  return { onEvent, forget, dispose, settled: () => Promise.all([...pending]), channels }
}

export function apply(ctx, config) {
  const n = createNotifier(config)
  ctx.on('session/event', (session, event) => n.onEvent(session, event))
  ctx.on('session/disposed', (session) => n.forget(session))
  ctx.effect(() => () => n.dispose(), 'gateway-notify timers')
}

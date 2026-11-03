import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import Schema from '@deepseek-ai/schemastery'
import { Config, createNotifier, message, duration, apply } from '../src/index.js'
import { send, resolveEnv, usable } from '../src/channels.js'

const conf = (over = {}) => new Schema(Config)({ channels: [{ type: 'ntfy', topic: 't' }], ...over })
const session = (over = {}) => ({ header: { id: 's1', cwd: '/home/ted/proj', ...over }, requestHeader: () => ({ config: { model: 'deepseek-v4-pro' } }) })
const ev = (type, time, data = {}) => ({ type, time, seq: 0, data })

function harness(o) {
  const sent = []
  let clock = 0
  const timers = []
  const n = createNotifier(o, {
    now: () => clock,
    later: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t },
    cancel: (t) => { t.cancelled = true },
    send: async (c, m) => { sent.push(m); return { ok: true } },
  })
  return { n, sent, tick: (ms) => { clock += ms; for (const t of timers) if (!t.cancelled && !t.done && t.at <= clock) { t.done = true; t.fn() } }, set: (t) => { clock = t } }
}

test('defaults match the gateway version', () => {
  const o = conf()
  assert.deepEqual([o.minMinutes, o.cooldownSeconds, o.errors, o.includeText, o.maxTextLength, o.subagents], [3, 30, true, false, 200, false])
})

test('long completed turn pushes, short one does not', async () => {
  const h = harness(conf())
  h.n.onEvent(session(), ev('turn/start', 0))
  h.n.onEvent(session(), ev('turn/end', 4 * 60_000, { turn: 1, reason: { kind: 'completed' } }))
  h.set(10 * 60_000)
  h.n.onEvent(session(), ev('turn/start', 10 * 60_000))
  h.n.onEvent(session(), ev('turn/end', 10 * 60_000 + 5_000, { turn: 2, reason: { kind: 'completed' } }))
  await h.n.settled()
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].title, '✅ dsh done · proj')
  assert.match(h.sent[0].body, /took 4 min\nModel: deepseek-v4-pro/)
})

test('error pushes even when short; aborted and blocked never', async () => {
  const h = harness(conf())
  for (const [i, kind] of ['aborted', 'blocked', 'interrupted'].entries()) {
    h.set(i * 100_000)
    h.n.onEvent(session(), ev('turn/start', i * 100_000))
    h.n.onEvent(session(), ev('turn/end', i * 100_000 + 10 * 60_000, { reason: { kind } }))
  }
  h.set(10_000_000)
  h.n.onEvent(session(), ev('turn/start', 10_000_000))
  h.n.onEvent(session(), ev('turn/end', 10_000_100, { reason: { kind: 'error', error: { message: '402 insufficient balance' } } }))
  await h.n.settled()
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].ok, false)
  assert.match(h.sent[0].body, /402 insufficient balance/)
})

test('subagent sessions are quiet unless enabled', async () => {
  const h = harness(conf({ minMinutes: 0 }))
  h.n.onEvent(session({ parentSession: 'p' }), ev('turn/start', 0))
  h.n.onEvent(session({ parentSession: 'p' }), ev('turn/end', 1, { reason: { kind: 'completed' } }))
  await h.n.settled()
  assert.equal(h.sent.length, 0)
  const h2 = harness(conf({ minMinutes: 0, subagents: true }))
  h2.n.onEvent(session({ parentSession: 'p' }), ev('turn/start', 0))
  h2.n.onEvent(session({ parentSession: 'p' }), ev('turn/end', 1, { reason: { kind: 'completed' } }))
  await h2.n.settled()
  assert.equal(h2.sent.length, 1)
})

test('cooldown per session', async () => {
  const h = harness(conf({ minMinutes: 0 }))
  for (const t of [0, 10_000, 40_000]) {
    h.set(t)
    h.n.onEvent(session(), ev('turn/start', t))
    h.n.onEvent(session(), ev('turn/end', t + 1, { reason: { kind: 'completed' } }))
  }
  await h.n.settled()
  assert.equal(h.sent.length, 2)
})

test('reply text only when includeText, trimmed', async () => {
  const msg = { role: 'assistant', content: [{ type: 'text', text: 'All   tests pass.\nShipped the fix to main and opened PR 42.' }] }
  for (const [includeText, expect] of [[false, false], [true, true]]) {
    const h = harness(conf({ minMinutes: 0, includeText, maxTextLength: 20 }))
    h.n.onEvent(session(), ev('turn/start', 0))
    h.n.onEvent(session(), ev('assistant/message', 1, { message: msg }))
    h.n.onEvent(session(), ev('turn/end', 2, { reason: { kind: 'completed' } }))
    await h.n.settled()
    assert.equal(h.sent[0].body.includes('All tests pass.'), expect)
    if (expect) assert.match(h.sent[0].body, /All tests pass\. Ship…$/)
  }
})

test('approval waiting pushes after the delay, decided in time does not', async () => {
  const h = harness(conf({ approvalDelaySeconds: 60 }))
  h.n.onEvent(session(), ev('approval/asked', 0, { id: 'a1', toolName: 'bash' }))
  h.n.onEvent(session(), ev('approval/asked', 0, { id: 'a2', toolName: 'write' }))
  h.tick(30_000)
  h.n.onEvent(session(), ev('approval/decided', 30_000, { id: 'a2', outcome: 'allowed-once' }))
  h.tick(31_000)
  await h.n.settled()
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].title, '⏳ dsh needs approval · proj')
  assert.match(h.sent[0].body, /Tool: bash/)
})

test('zh wording and durations', () => {
  const m = message('done', { ms: 125 * 60_000, cwd: 'C:\\code\\app\\', model: 'x' }, { lang: 'zh' })
  assert.equal(m.title, '✅ dsh 完成 · app')
  assert.match(m.body, /用时 2 小时 5 分钟/)
  assert.equal(duration(42_000, { s: 's' }), '42 s')
})

test('env: indirection for secrets', () => {
  assert.deepEqual(resolveEnv({ type: 'ntfy', topic: 'env:T', token: 'env:MISSING' }, { T: 'abc' }), { type: 'ntfy', topic: 'abc', token: undefined })
  assert.equal(usable({ type: 'ntfy' }), false)
})

test('apply wires session/event through Cordis', async () => {
  const hs = {}
  const ctx = { on: (e, f) => { hs[e] = f }, effect: (f) => { hs.disposer = f() } }
  apply(ctx, conf({ channels: [] }))
  assert.equal(typeof hs['session/event'], 'function')
  hs['session/event'](session(), ev('turn/start', 0))
  hs.disposer()
})

test('real ntfy wire format against a local server, secret from env', async () => {
  const got = []
  const srv = createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.end('{"id":"x"}') }) })
  await new Promise((r) => srv.listen(0, r))
  const server = `http://127.0.0.1:${srv.address().port}`
  try {
    const r = await send({ type: 'ntfy', server, topic: 'dsh', token: 'env:NTFY_TOKEN' }, { title: 'T', body: 'B', ok: true }, { NTFY_TOKEN: 'tk_secret' })
    assert.equal(r.ok, true)
    assert.equal(got[0].auth, 'Bearer tk_secret')
    assert.deepEqual(got[0].body, { topic: 'dsh', title: 'T', message: 'B', priority: 3, tags: ['white_check_mark'] })
  } finally { srv.close() }
})

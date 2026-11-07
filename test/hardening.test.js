// Edge cases and per-channel wire formats. Every request goes to a local
// HTTP server on 127.0.0.1 or to a stubbed fetch; nothing leaves the machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { Config, createNotifier, message, duration, apply } from '../src/index.js'
import { send, resolveEnv, usable, cut } from '../src/channels.js'

const M = { title: 'T', body: 'B', ok: true, event: { kind: 'done', model: 'm', project: 'p', seconds: 1, session: 's' } }
const conf = (over = {}) => new Schema(Config)({ channels: [{ type: 'ntfy', topic: 't' }], ...over })
const session = (over = {}) => ({ header: { id: 's1', cwd: '/home/ted/proj', ...over }, requestHeader: () => ({ config: { model: 'deepseek-v4-pro' } }) })
const ev = (type, time, data = {}) => ({ type, time, seq: 0, data })
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** A local server recording each request; reply(req, body, res) answers it. */
async function mock(reply = (req, body, res) => res.end('{}')) {
  const got = []
  const srv = createServer((req, res) => {
    let b = ''
    req.setEncoding('utf8')
    req.on('data', (d) => (b += d))
    req.on('end', () => {
      let json
      try { json = JSON.parse(b) } catch {}
      got.push({ method: req.method, url: req.url, headers: req.headers, raw: b, body: json })
      reply(req, b, res)
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  return { got, base, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) }) }
}

function harness(o, sendImpl) {
  const sent = []
  let clock = 0
  const timers = []
  const n = createNotifier(o, {
    now: () => clock,
    later: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t },
    cancel: (t) => { t.cancelled = true },
    send: sendImpl ?? (async (c, m) => { sent.push(m); return { ok: true } }),
  })
  return { n, sent, timers, tick: (ms) => { clock += ms; for (const t of timers) if (!t.cancelled && !t.done && t.at <= clock) { t.done = true; t.fn() } }, set: (t) => { clock = t } }
}

const turn = (h, s, start, end, reason = { kind: 'completed' }) => {
  h.set(start)
  h.n.onEvent(s, ev('turn/start', start))
  h.set(end)
  h.n.onEvent(s, ev('turn/end', end, { reason }))
}

// ---------------------------------------------------------------- channels

test('ntfy: failure tag, custom priority and tags, trailing slash on server', async () => {
  const s = await mock()
  try {
    await send({ type: 'ntfy', server: `${s.base}///`, topic: 'dsh' }, { ...M, ok: false })
    await send({ type: 'ntfy', server: s.base, topic: 'dsh', priority: 5, tags: ['robot'] }, M)
    assert.equal(s.got[0].url, '/')
    assert.equal(s.got[0].headers['content-type'], 'application/json')
    assert.equal(s.got[0].headers.authorization, undefined)
    assert.deepEqual(s.got[0].body.tags, ['x'])
    assert.deepEqual([s.got[1].body.priority, s.got[1].body.tags], [5, ['robot']])
  } finally { await s.close() }
})

test('bark: /push with device key, default group, sound only when set', async () => {
  const s = await mock((req, b, res) => res.end('{"code":200,"message":"success"}'))
  try {
    const r = await send({ type: 'bark', server: s.base, key: 'K' }, M)
    await send({ type: 'bark', server: s.base, key: 'K', group: 'g', sound: 'bell' }, M)
    assert.deepEqual(r, { ok: true, status: 200 })
    assert.equal(s.got[0].url, '/push')
    assert.deepEqual(s.got[0].body, { device_key: 'K', title: 'T', body: 'B', group: 'dsh' })
    assert.deepEqual(s.got[1].body, { device_key: 'K', title: 'T', body: 'B', group: 'g', sound: 'bell' })
  } finally { await s.close() }
})

test('gotify: /message with app token header; priority 0 kept, unset omitted', async () => {
  const s = await mock((req, b, res) => res.end('{"id":1}'))
  try {
    await send({ type: 'gotify', server: `${s.base}/`, token: 'AT' }, M)
    await send({ type: 'gotify', server: s.base, token: 'AT', priority: 0 }, M)
    assert.equal(s.got[0].url, '/message')
    assert.equal(s.got[0].headers['x-gotify-key'], 'AT')
    assert.deepEqual(s.got[0].body, { title: 'T', message: 'B' })
    assert.deepEqual(s.got[1].body, { title: 'T', message: 'B', priority: 0 })
  } finally { await s.close() }
})

test('serverchan: Turbo and ³ URLs, form-encoded (stubbed fetch, no network)', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init }); return new Response('{"code":0}', { status: 200 }) })
  assert.equal((await send({ type: 'serverchan', key: 'SCTabc' }, { ...M, title: 'a b', body: '中文&x' })).ok, true)
  await send({ type: 'serverchan', key: 'sctp123tXYZ' }, M)
  assert.equal(calls[0].url, 'https://sctapi.ftqq.com/SCTabc.send')
  assert.equal(calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), { title: 'a b', desp: '中文&x' })
  assert.equal(calls[1].url, 'https://123.push.ft07.com/send/sctp123tXYZ.send')
})

test('feishu: text message; signed with timestamp + HMAC when secret set', async () => {
  const s = await mock((req, b, res) => res.end('{"code":0,"msg":"success"}'))
  try {
    await send({ type: 'feishu', webhook: `${s.base}/hook` }, M)
    await send({ type: 'feishu', webhook: `${s.base}/hook`, secret: 'sec' }, M)
    assert.deepEqual(s.got[0].body, { msg_type: 'text', content: { text: 'T\nB' } })
    const { timestamp, sign } = s.got[1].body
    assert.match(timestamp, /^\d{10}$/)
    assert.equal(sign, createHmac('sha256', `${timestamp}\nsec`).update('').digest('base64'))
  } finally { await s.close() }
})

test('dingtalk: sign appended with ? or & as the webhook needs', async () => {
  const s = await mock((req, b, res) => res.end('{"errcode":0,"errmsg":"ok"}'))
  try {
    await send({ type: 'dingtalk', webhook: `${s.base}/robot/send?access_token=AT`, secret: 'SEC' }, M)
    await send({ type: 'dingtalk', webhook: `${s.base}/robot/send`, secret: 'SEC' }, M)
    await send({ type: 'dingtalk', webhook: `${s.base}/plain` }, M)
    const u0 = new URL(s.got[0].url, s.base), u1 = new URL(s.got[1].url, s.base)
    assert.equal(u0.searchParams.get('access_token'), 'AT')
    const ts = u0.searchParams.get('timestamp')
    assert.equal(u0.searchParams.get('sign'), createHmac('sha256', 'SEC').update(`${ts}\nSEC`).digest('base64'))
    assert.ok(u1.searchParams.get('sign'))
    assert.equal(s.got[2].url, '/plain')
    assert.deepEqual(s.got[2].body, { msgtype: 'text', text: { content: 'T\nB' } })
  } finally { await s.close() }
})

test('wecom and telegram request bodies', async () => {
  const s = await mock((req, b, res) => res.end(req.url.startsWith('/bot') ? '{"ok":true}' : '{"errcode":0}'))
  try {
    assert.equal((await send({ type: 'wecom', webhook: `${s.base}/cgi-bin/webhook/send?key=K` }, M)).ok, true)
    assert.equal((await send({ type: 'telegram', server: `${s.base}/`, token: '123:abc', chatId: '-100' }, M)).ok, true)
    assert.deepEqual(s.got[0].body, { msgtype: 'text', text: { content: 'T\nB' } })
    assert.equal(s.got[1].url, '/bot123:abc/sendMessage')
    assert.deepEqual(s.got[1].body, { chat_id: '-100', text: 'T\nB', disable_web_page_preview: true })
  } finally { await s.close() }
})

test('webhook: event JSON with custom headers, header values may be env:NAME', async () => {
  const s = await mock()
  try {
    const r = await send({ type: 'webhook', url: `${s.base}/in`, headers: { authorization: 'env:HOOK_AUTH', 'x-static': 'v' } }, M, { HOOK_AUTH: 'Bearer h_secret' })
    assert.equal(r.ok, true)
    assert.equal(s.got[0].headers.authorization, 'Bearer h_secret')
    assert.equal(s.got[0].headers['x-static'], 'v')
    assert.deepEqual(s.got[0].body, { title: 'T', body: 'B', event: M.event })
  } finally { await s.close() }
})

test('IM robots: 200 with an error code in the body is a failure', async () => {
  const replies = {
    '/errcode': '{"errcode":310000,"errmsg":"sign not match"}',
    '/code': '{"code":19021,"msg":"sign match fail"}',
    '/tg': '{"ok":false,"description":"Bad Request: chat not found"}',
    '/text': 'OK',
  }
  const s = await mock((req, b, res) => res.end(replies[req.url]))
  try {
    assert.deepEqual(await send({ type: 'webhook', url: `${s.base}/errcode` }, M), { ok: false, status: 200, error: 'sign not match' })
    assert.deepEqual(await send({ type: 'webhook', url: `${s.base}/code` }, M), { ok: false, status: 200, error: 'sign match fail' })
    assert.equal((await send({ type: 'webhook', url: `${s.base}/tg` }, M)).error, 'Bad Request: chat not found')
    assert.deepEqual(await send({ type: 'webhook', url: `${s.base}/text` }, M), { ok: true, status: 200 })
  } finally { await s.close() }
})

test('HTTP errors, refused connections and timeouts answer ok:false, never throw', async () => {
  const s = await mock((req, b, res) => {
    if (req.url === '/500') { res.statusCode = 500; res.end('{"message":"boom"}') }
    else if (req.url === '/401') { res.statusCode = 401; res.end('') }
    // /hang: never answered
  })
  try {
    assert.deepEqual(await send({ type: 'webhook', url: `${s.base}/500` }, M), { ok: false, status: 500, error: 'boom' })
    const r401 = await send({ type: 'webhook', url: `${s.base}/401` }, M)
    assert.equal(r401.ok, false); assert.equal(r401.status, 401)
    const t0 = Date.now()
    const hung = await send({ type: 'webhook', url: `${s.base}/hang` }, M, {}, { timeout: 150 })
    assert.equal(hung.ok, false)
    assert.match(hung.error, /time|abort/i)
    assert.ok(Date.now() - t0 < 3000)
  } finally { await s.close() }
  const refused = await send({ type: 'webhook', url: s.base }, M) // server closed now
  assert.equal(refused.ok, false)
  assert.ok(refused.error)
  assert.equal((await send({ type: 'webhook', url: 'not a url' }, M)).ok, false)
})

test('long unicode error text is cut to 200 code points without splitting a pair', async () => {
  const s = await mock((req, b, res) => res.end(JSON.stringify({ errcode: 1, errmsg: 'x' + '😀'.repeat(300) })))
  try {
    const r = await send({ type: 'webhook', url: s.base }, M)
    assert.equal(Array.from(r.error).length, 200)
    assert.doesNotMatch(r.error, loneSurrogate)
  } finally { await s.close() }
})

test('unconfigured channels send nothing', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}'))
  for (const c of [null, {}, { type: 'nope', url: 'x' }, { type: 'ntfy' }, { type: 'ntfy', topic: '  ' }, { type: 'ntfy', topic: 't', off: true },
    { type: 'gotify', server: 'http://x' }, { type: 'telegram', token: 't' }, { type: 'webhook', url: 'env:UNSET_HOOK' }, { type: 'bark', key: 'env:EMPTY' }]) {
    assert.deepEqual(await send(c, M, { EMPTY: '' }), { ok: false, error: 'channel not configured' })
  }
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('env: resolution: missing is undefined, nested values resolve, objects are copied', () => {
  const raw = { type: 'webhook', url: 'env:U', headers: { a: 'env:A', b: 'plain' }, tags: ['env:T', 'x'], priority: 3, off: false, note: 'envy:no' }
  const out = resolveEnv(raw, { U: 'http://h', A: 'aa', T: 'tt' })
  assert.deepEqual(out, { type: 'webhook', url: 'http://h', headers: { a: 'aa', b: 'plain' }, tags: ['tt', 'x'], priority: 3, off: false, note: 'envy:no' })
  assert.equal(raw.headers.a, 'env:A')
  assert.equal(resolveEnv({ token: 'env:NOPE' }, {}).token, undefined)
  assert.equal(resolveEnv(null), null)
  assert.equal(usable({ type: 'ntfy', topic: 0 }), true)
  assert.equal(usable({ type: 'webhook', url: 'env:X' }), true) // raw config: resolved at send time
})

// ---------------------------------------------------------------- state machine

test('minMinutes boundary: exactly the threshold pushes, a millisecond less does not', async () => {
  const h = harness(conf({ minMinutes: 2, cooldownSeconds: 0 }))
  turn(h, session(), 0, 2 * 60_000 - 1)
  turn(h, session(), 1e7, 1e7 + 2 * 60_000)
  const h0 = harness(conf({ minMinutes: 0 }))
  turn(h0, session(), 0, 0)
  await h.n.settled(); await h0.n.settled()
  assert.equal(h.sent.length, 1)
  assert.equal(h0.sent.length, 1)
  assert.match(h0.sent[0].body, /took 0 s/)
})

test('max-tokens: long turn says so, short one is quiet', async () => {
  const h = harness(conf({ cooldownSeconds: 0 }))
  turn(h, session(), 0, 1000, { kind: 'max-tokens' })
  turn(h, session(), 1e7, 1e7 + 5 * 60_000, { kind: 'max-tokens' })
  await h.n.settled()
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].ok, true)
  assert.match(h.sent[0].body, /hit the output-token limit/)
})

test('errors: off silences failures; a failure without a message still pushes', async () => {
  const off = harness(conf({ errors: false }))
  turn(off, session(), 0, 10 * 60_000, { kind: 'error', error: { message: 'x' } })
  const on = harness(conf())
  turn(on, session(), 0, 5, { kind: 'error' })
  await off.n.settled(); await on.n.settled()
  assert.equal(off.sent.length, 0)
  assert.equal(on.sent.length, 1)
  assert.equal(on.sent[0].title, '❌ dsh failed · proj')
  assert.equal(on.sent[0].body, 'took 0 s\nModel: deepseek-v4-pro')
})

test('aborted (any cause) and forked turns never push', async () => {
  const h = harness(conf({ minMinutes: 0, cooldownSeconds: 0 }))
  turn(h, session(), 0, 1e6, { kind: 'aborted', reason: { kind: 'user' } })
  turn(h, session(), 2e6, 3e6, { kind: 'aborted', reason: { kind: 'disposed' } })
  turn(h, session(), 4e6, 5e6, { kind: 'forked' })
  turn(h, session(), 6e6, 7e6, { kind: 'some-future-kind' })
  await h.n.settled()
  assert.equal(h.sent.length, 0)
})

test('repeated and overlapping events: duplicate end, end without start, restart, two sessions', async () => {
  const h = harness(conf({ minMinutes: 1, cooldownSeconds: 0 }))
  const a = session({ id: 'a' }), b = session({ id: 'b', cwd: '/w/other' })
  // end without start: plugin loaded mid-turn
  h.n.onEvent(a, ev('turn/end', 5 * 60_000, { reason: { kind: 'completed' } }))
  // interleaved sessions
  h.n.onEvent(a, ev('turn/start', 0))
  h.n.onEvent(b, ev('turn/start', 30_000))
  h.n.onEvent(a, ev('turn/end', 2 * 60_000, { reason: { kind: 'completed' } }))
  h.n.onEvent(a, ev('turn/end', 3 * 60_000, { reason: { kind: 'completed' } })) // duplicate
  h.n.onEvent(b, ev('turn/end', 40_000, { reason: { kind: 'completed' } })) // b short
  // a second turn/start before an end measures from the latest start
  h.n.onEvent(a, ev('turn/start', 10 * 60_000))
  h.n.onEvent(a, ev('turn/start', 20 * 60_000))
  h.n.onEvent(a, ev('turn/end', 20 * 60_000 + 30_000, { reason: { kind: 'completed' } }))
  await h.n.settled()
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].event.session, 'a')
  assert.equal(h.sent[0].event.seconds, 120)
})

test('turn/end without an event time falls back to the clock', async () => {
  const h = harness(conf())
  h.set(0)
  h.n.onEvent(session(), { type: 'turn/start', data: {} })
  h.set(4 * 60_000)
  h.n.onEvent(session(), { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await h.n.settled()
  assert.equal(h.sent[0].event.seconds, 240)
})

test('cooldown 0 pushes every qualifying turn; approvals cool down apart from turns', async () => {
  const h = harness(conf({ minMinutes: 0, cooldownSeconds: 0 }))
  for (const t of [0, 1, 2]) turn(h, session(), t, t)
  const h2 = harness(conf({ minMinutes: 0, cooldownSeconds: 300, approvalDelaySeconds: 1 }))
  turn(h2, session(), 0, 0)
  h2.n.onEvent(session(), ev('approval/asked', 0, { id: 'a1', toolName: 'bash' }))
  h2.tick(1000)
  await h.n.settled(); await h2.n.settled()
  assert.equal(h.sent.length, 3)
  assert.deepEqual(h2.sent.map((m) => m.event.kind), ['done', 'waiting'])
})

test('approvals: off, duplicate ask, missing id, decided after the push', async () => {
  const off = harness(conf({ approvals: false }))
  off.n.onEvent(session(), ev('approval/asked', 0, { id: 'a1', toolName: 'bash' }))
  off.tick(3_600_000)
  const h = harness(conf({ approvalDelaySeconds: 10, cooldownSeconds: 0 }))
  h.n.onEvent(session(), ev('approval/asked', 0, { id: 'a1', toolName: 'bash' }))
  h.n.onEvent(session(), ev('approval/asked', 0, { id: 'a1', toolName: 'bash' }))
  h.n.onEvent(session(), ev('approval/asked', 0, { toolName: 'nameless' }))
  h.tick(10_000)
  h.n.onEvent(session(), ev('approval/decided', 20_000, { id: 'a1', outcome: 'rejected' }))
  h.n.onEvent(session(), ev('approval/decided', 20_000, { id: 'unknown', outcome: 'cancelled' }))
  await off.n.settled(); await h.n.settled()
  assert.equal(off.sent.length, 0)
  assert.equal(h.timers.length, 1)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].event.session, 's1#approval')
})

test('subagent approvals are quiet unless subagents is on', async () => {
  const h = harness(conf({ approvalDelaySeconds: 1 }))
  h.n.onEvent(session({ parentSession: 'p' }), ev('approval/asked', 0, { id: 'a', toolName: 'bash' }))
  h.tick(5000)
  await h.n.settled()
  assert.equal(h.sent.length, 0)
})

test('a failing channel never stops the others and never throws into the agent', async () => {
  const reached = []
  const o = conf({ minMinutes: 0, cooldownSeconds: 0, channels: [{ type: 'ntfy', topic: 'sync' }, { type: 'ntfy', topic: 'reject' }, { type: 'ntfy', topic: 'ok' }] })
  const h = harness(o, (c) => {
    if (c.topic === 'sync') throw new Error('sync boom')
    if (c.topic === 'reject') return Promise.reject(new Error('async boom'))
    reached.push(c.topic); return Promise.resolve({ ok: true })
  })
  assert.doesNotThrow(() => turn(h, session(), 0, 1))
  await h.n.settled()
  assert.deepEqual(reached, ['ok'])
})

test('the approval timer never throws, even when building the push fails', async () => {
  const h = harness(conf({ approvalDelaySeconds: 1 }))
  const bad = { header: { id: 's', cwd: 42 } } // a cwd that is not a string
  h.n.onEvent(bad, ev('approval/asked', 0, { id: 'a', toolName: 'bash' }))
  assert.doesNotThrow(() => h.tick(1000))
})

test('malformed input is ignored', () => {
  const h = harness(conf({ minMinutes: 0 }))
  for (const [s, e] of [[null, ev('turn/start', 0)], [{}, ev('turn/start', 0)], [session(), null], [session(), {}], [session(), ev('turn/end', 0)],
    [{ header: { id: 'x' }, requestHeader: () => { throw new Error('no header') } }, ev('turn/start', 0)]]) {
    assert.doesNotThrow(() => h.n.onEvent(s, e))
  }
  // a requestHeader that throws only loses the model line
  h.n.onEvent({ header: { id: 'x' }, requestHeader: () => { throw new Error('x') } }, ev('turn/end', 1, { reason: { kind: 'completed' } }))
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].body, 'took 0 s')
})

test('no usable channel: nothing is sent; off channels are dropped up front', async () => {
  const h = harness(conf({ minMinutes: 0, channels: [{ type: 'ntfy', topic: 't', off: true }, { type: 'bark' }] }))
  turn(h, session(), 0, 1)
  await h.n.settled()
  assert.equal(h.n.channels.length, 0)
  assert.equal(h.sent.length, 0)
})

test('dispose cancels waiting approvals and ignores later events', async () => {
  const h = harness(conf({ minMinutes: 0, approvalDelaySeconds: 10 }))
  h.n.onEvent(session(), ev('approval/asked', 0, { id: 'a', toolName: 'bash' }))
  h.n.onEvent(session(), ev('turn/start', 0))
  h.n.dispose()
  h.tick(60_000)
  h.n.onEvent(session(), ev('turn/end', 60_000, { reason: { kind: 'completed' } }))
  h.n.onEvent(session(), ev('approval/asked', 60_000, { id: 'b', toolName: 'bash' }))
  h.tick(60_000)
  await h.n.settled()
  assert.equal(h.sent.length, 0)
  assert.ok(h.timers.every((t) => t.cancelled || t.done === undefined))
  assert.equal(h.timers.length, 1)
})

test('forget drops a disposed session: open turn and cooldown', async () => {
  const h = harness(conf({ minMinutes: 0, cooldownSeconds: 300 }))
  turn(h, session(), 0, 0)
  h.n.onEvent(session(), ev('turn/start', 1))
  h.n.forget(session())
  h.n.onEvent(session(), ev('turn/end', 2, { reason: { kind: 'completed' } })) // its start was dropped
  turn(h, session(), 3, 3) // cooldown was dropped
  assert.doesNotThrow(() => h.n.forget(null))
  await h.n.settled()
  assert.equal(h.sent.length, 2)
})

test('apply registers session/event and session/disposed; the effect disposes', () => {
  const on = {}
  let disposer
  apply({ on: (e, f) => { on[e] = f }, effect: (f) => { disposer = f() } }, conf())
  assert.deepEqual(Object.keys(on).sort(), ['session/disposed', 'session/event'])
  on['session/event'](session(), ev('approval/asked', 0, { id: 'a', toolName: 'bash' }))
  on['session/disposed'](session())
  assert.equal(typeof disposer, 'function')
  disposer() // clears the real (unref'd) timer
})

test('end to end through real send: a 500 and a hung server do not break the notifier', async () => {
  const s = await mock((req, b, res) => { if (req.url === '/500') { res.statusCode = 500; res.end() } })
  try {
    const results = []
    const o = conf({ minMinutes: 0, channels: [{ type: 'webhook', url: `${s.base}/500` }, { type: 'webhook', url: `${s.base}/hang` }, { type: 'webhook', url: `${s.base}/500`, headers: { 'x-k': 'env:NOTIFY_TEST_KEY' } }] })
    const h = harness(o, async (c, m) => { const r = await send(c, m, { NOTIFY_TEST_KEY: 'k' }, { timeout: 150 }); results.push(r); return r })
    turn(h, session(), 0, 1)
    await h.n.settled()
    assert.equal(results.length, 3)
    assert.ok(results.every((r) => r.ok === false))
    assert.equal(s.got.find((g) => g.headers['x-k']).headers['x-k'], 'k')
  } finally { await s.close() }
})

// ---------------------------------------------------------------- message

test('reply text: cut by code points, never through an emoji; ellipsis only when cut', () => {
  const o = { includeText: true, maxTextLength: 3 }
  const m = message('done', { ms: 0, text: 'ab😀😀' }, o)
  assert.ok(m.body.endsWith('ab😀…'))
  assert.doesNotMatch(m.body, loneSurrogate)
  assert.ok(message('done', { ms: 0, text: 'ab😀' }, o).body.endsWith('ab😀'))
  assert.ok(!message('done', { ms: 0, text: 'ab😀' }, o).body.includes('…'))
  assert.equal(message('done', { ms: 0, text: 'hello' }, { includeText: true, maxTextLength: 0 }).body, 'took 0 s')
  assert.equal(message('done', { ms: 0, text: ' \n\t ' }, o).body, 'took 0 s')
  const zh = message('done', { ms: 0, text: '全部测试通过，已推送' }, { includeText: true, maxTextLength: 4, lang: 'zh' })
  assert.ok(zh.body.endsWith('全部测试…'))
})

test('error line: cut to 200 code points without a lone surrogate', () => {
  const m = message('failed', { ms: 0, error: '🔥'.repeat(250) }, {})
  const line = m.body.split('\n')[1]
  assert.equal(Array.from(line).length, 200)
  assert.doesNotMatch(line, loneSurrogate)
  assert.equal(cut('abc', 5), 'abc')
})

test('message event payload, unknown lang falls back to en, missing cwd and ms', () => {
  const m = message('waiting', { toolName: 'bash', session: 's#approval' }, { lang: 'fr' })
  assert.equal(m.title, '⏳ dsh needs approval')
  assert.equal(m.body, 'Tool: bash')
  assert.deepEqual(m.event, { kind: 'waiting', model: '', project: '', seconds: null, session: 's#approval' })
  assert.equal(m.ok, false)
})

test('durations', () => {
  const w = { s: 's', min: 'min', h: 'h' }
  assert.equal(duration(0, w), '0 s')
  assert.equal(duration(59_400, w), '59 s')
  assert.equal(duration(59_600, w), '1 min')
  assert.equal(duration(60 * 60_000, w), '1 h')
  assert.equal(duration(90 * 60_000, w), '1 h 30 min')
})

// ---------------------------------------------------------------- config

test('config schema: defaults and rejections', () => {
  const c = new Schema(Config)
  assert.deepEqual(c({}), { channels: [], minMinutes: 3, cooldownSeconds: 30, errors: true, approvals: true, approvalDelaySeconds: 60, subagents: false, includeText: false, maxTextLength: 200, lang: 'en' })
  assert.deepEqual(c({ channels: [{ type: 'bark', key: 'k' }] }).channels[0], { type: 'bark', key: 'k', headers: {}, tags: [] })
  for (const bad of [{ channels: [{}] }, { channels: [{ type: 'slack' }] }, { minMinutes: -1 }, { cooldownSeconds: -1 }, { approvalDelaySeconds: -5 }, { maxTextLength: 1.5 }, { lang: 'fr' }]) {
    assert.throws(() => c(bad))
  }
})

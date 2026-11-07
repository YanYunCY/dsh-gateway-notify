// Ported from @magpie-community/gateway-notify (MIT, Copyright (c) 2026
// magpie-community contributors): channels.mjs, with env: indirection for
// secrets and the Bark group default renamed.
//
// Where a notification goes. Each channel is one HTTPS POST to a service
// the user chose, with their own topic, key or webhook; nothing is sent
// anywhere else. send() never throws: it answers { ok, status?, error? }.
import { createHmac } from "node:crypto"

const TIMEOUT = 10_000

// cut to at most n code points, never through a surrogate pair
export const cut = (s, n) => { const a = Array.from(String(s)); return a.length > n ? a.slice(0, n).join("") : a.join("") }

async function post(url, body, headers = {}, form = false, timeout = TIMEOUT) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", ...headers },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  // the IM robots answer 200 with an error code in the body
  let data
  try { data = await res.json() } catch {}
  const code = data?.code ?? data?.errcode ?? data?.StatusCode
  const okBody = data?.ok !== false && (code == null || code === 0 || code === 200)
  return res.ok && okBody ? { ok: true, status: res.status } : { ok: false, status: res.status, error: cut(data?.msg ?? data?.errmsg ?? data?.description ?? data?.errorDescription ?? data?.message ?? res.statusText ?? "", 200) }
}

const trimSlash = (s) => String(s).replace(/\/+$/, "")

export const kinds = {
  // ntfy (ntfy.sh or your own server): JSON publish to the server root
  ntfy: (c, m, t) => post(trimSlash(c.server ?? "https://ntfy.sh"), {
    topic: c.topic, title: m.title, message: m.body, priority: c.priority ?? 3, tags: c.tags?.length ? c.tags : [m.ok ? "white_check_mark" : "x"],
  }, c.token ? { authorization: `Bearer ${c.token}` } : {}, false, t),

  // Bark (iOS): api.day.app or your own bark-server
  bark: (c, m, t) => post(`${trimSlash(c.server ?? "https://api.day.app")}/push`, {
    device_key: c.key, title: m.title, body: m.body, group: c.group ?? "dsh", ...(c.sound ? { sound: c.sound } : {}),
  }, {}, false, t),

  // Gotify: self-hosted push notifications
  gotify: (c, m, t) => post(`${trimSlash(c.server)}/message`, {
    title: m.title, message: m.body, ...(c.priority != null ? { priority: c.priority } : {}), ...(c.extras ? { extras: c.extras } : {}),
  }, { "X-Gotify-Key": c.token }, false, t),

  // Server酱 Turbo (SCT…) and Server酱³ (sctp<uid>t…)
  serverchan: (c, m, t) => {
    const key = String(c.key ?? "")
    const v3 = key.match(/^sctp(\d+)t/i)
    const url = v3 ? `https://${v3[1]}.push.ft07.com/send/${key}.send` : `https://sctapi.ftqq.com/${key}.send`
    return post(url, { title: m.title, desp: m.body }, {}, true, t)
  },

  // 飞书 / Lark custom robot, with its optional signing secret
  feishu: (c, m, t) => {
    const body = { msg_type: "text", content: { text: `${m.title}\n${m.body}` } }
    if (c.secret) {
      const timestamp = String(Math.floor(Date.now() / 1000))
      body.timestamp = timestamp
      body.sign = createHmac("sha256", `${timestamp}\n${c.secret}`).update("").digest("base64")
    }
    return post(c.webhook, body, {}, false, t)
  },

  // 钉钉 custom robot, with its optional 加签 secret
  dingtalk: (c, m, t) => {
    let url = c.webhook
    if (c.secret) {
      const timestamp = String(Date.now())
      const sign = createHmac("sha256", c.secret).update(`${timestamp}\n${c.secret}`).digest("base64")
      url += `${url.includes("?") ? "&" : "?"}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
    }
    return post(url, { msgtype: "text", text: { content: `${m.title}\n${m.body}` } }, {}, false, t)
  },

  // 企业微信 group robot
  wecom: (c, m, t) => post(c.webhook, { msgtype: "text", text: { content: `${m.title}\n${m.body}` } }, {}, false, t),

  // Telegram bot
  telegram: (c, m, t) => post(`${trimSlash(c.server ?? "https://api.telegram.org")}/bot${c.token}/sendMessage`, {
    chat_id: c.chatId, text: `${m.title}\n${m.body}`, disable_web_page_preview: true,
  }, {}, false, t),

  // anything else: the event as JSON
  webhook: (c, m, t) => post(c.url, { title: m.title, body: m.body, event: m.event }, c.headers ?? {}, false, t),
}

// what each kind needs before it can send
const needs = {
  ntfy: ["topic"], bark: ["key"], gotify: ["server", "token"], serverchan: ["key"], feishu: ["webhook"], dingtalk: ["webhook"],
  wecom: ["webhook"], telegram: ["token", "chatId"], webhook: ["url"],
}

// "env:NAME" in any string field reads that environment variable, so tokens,
// keys and webhook URLs need not sit in the profile config. Nested values
// (webhook headers, ntfy tags) resolve too. A missing variable becomes
// undefined, so a required field left empty makes the channel unusable.
export function resolveEnv(c, env = process.env) {
  if (typeof c === "string") return c.startsWith("env:") ? env[c.slice(4)] : c
  if (Array.isArray(c)) return c.map((v) => resolveEnv(v, env))
  if (!c || typeof c !== "object") return c
  const out = {}
  for (const [k, v] of Object.entries(c)) out[k] = resolveEnv(v, env)
  return out
}

export function usable(c) {
  if (!c || typeof c !== "object" || c.off) return false
  const n = needs[c.type]
  return !!n && n.every((k) => c[k] != null && String(c[k]).trim() !== "")
}

// opts.timeout (ms) overrides the 10 s request timeout; for tests.
export async function send(raw, m, env = process.env, opts = {}) {
  try {
    const c = resolveEnv(raw, env)
    if (!usable(c)) return { ok: false, error: "channel not configured" }
    return await kinds[c.type](c, m, opts.timeout ?? TIMEOUT)
  } catch (e) {
    return { ok: false, error: cut(e?.message ?? e, 200) }
  }
}

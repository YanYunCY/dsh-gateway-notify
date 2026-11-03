# dsh-gateway-notify

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that pushes to your phone or team chat when an agent turn ends after running a while, when a turn fails, or when the agent has been waiting on your approval.

中文：dsh 的长任务结束、失败或卡在等你审批时，推送到 ntfy、Bark、Gotify、Server酱、飞书、钉钉、企业微信、Telegram 或任意 webhook。默认不发送提示词和回复正文。

Ported from [`@magpie-community/gateway-notify`](https://github.com/magpie-community/plugins/tree/main/packages/notify) (MIT, © magpie-community contributors). The channel code is theirs, nearly unchanged.

## When it pushes

| dsh event | Push |
|---|---|
| `turn/end` with `completed` or `max-tokens`, turn ran ≥ `minMinutes` | ✅ done, with duration and model |
| `turn/end` with `error` | ❌ failed, with the error message (any duration, if `errors` is on) |
| `approval/asked` not decided within `approvalDelaySeconds` | ⏳ needs approval, with the tool name |
| `turn/end` with `aborted` | nothing: you pressed stop, so you're at the keyboard |
| `blocked`, `interrupted`, `forked` | nothing |

Subagent sessions (those with a parent session) stay quiet unless `subagents: true`. At most one push per session per `cooldownSeconds`.

## Install

```bash
dsh plugin --profile web add dsh-gateway-notify
```

Requires Node ≥ 24.9 (the same as dsh). Tested with dsh 0.2.1-rc.5.

## Configure

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: gateway-notify
  config:
    minMinutes: 3
    channels:
      - type: ntfy
        topic: env:NTFY_TOPIC          # any string field may be env:NAME
        token: env:NTFY_TOKEN          # optional, for a protected topic
      - type: bark
        key: env:BARK_KEY
      - type: feishu
        webhook: env:FEISHU_WEBHOOK
        secret: env:FEISHU_SECRET
```

Put tokens, keys and webhook URLs in environment variables and reference them as `env:NAME`; then nothing secret sits in the profile.

| Option | Default | Meaning |
|---|---|---|
| `channels` | `[]` | where to push (below) |
| `minMinutes` | `3` | only push for turns at least this long |
| `cooldownSeconds` | `30` | at most one push per session in this window |
| `errors` | `true` | push failed turns, however short |
| `approvals` | `true` | push approvals left waiting |
| `approvalDelaySeconds` | `60` | how long an approval waits before the push |
| `subagents` | `false` | also push for subagent sessions |
| `includeText` | `false` | add the start of the final reply |
| `maxTextLength` | `200` | how much of it |
| `lang` | `en` | `en` or `zh` |

### Channels

| `type` | Needs | Optional |
|---|---|---|
| `ntfy` | `topic` | `server` (default ntfy.sh), `token`, `priority`, `tags` |
| `bark` | `key` | `server` (default api.day.app), `group`, `sound` |
| `gotify` | `server`, `token` | `priority` |
| `serverchan` | `key` (SCT… or sctp…) | |
| `feishu` | `webhook` | `secret` |
| `dingtalk` | `webhook` | `secret` |
| `wecom` | `webhook` | |
| `telegram` | `token`, `chatId` | `server` |
| `webhook` | `url` | `headers`; body is `{ title, body, event }` |

Add `off: true` to keep a channel in config without sending to it.

## Privacy

By default a push carries only the project folder name, the duration, the model, and for failures the error message. Prompts and replies are not sent unless you turn on `includeText`. Each channel is one HTTPS POST to the service you configured; nothing goes anywhere else.

## Differences from the magpie gateway version

The magpie version sits in an API gateway and has to infer from raw requests when a turn starts and ends, which requests belong to a subagent or a Claude Code background agent, and whether a failure is a retry. dsh reports these directly, so this port:

- listens to dsh's `session/event` stream (`turn/start`, `turn/end` and its reason, `assistant/message`, `approval/asked`, `approval/decided`) instead of request/response hooks;
- identifies subagents by the session's `parentSession` instead of heuristics;
- drops the failure hold window: dsh's own retry layer has finished by the time `turn/end` reports an error;
- drops the `agents` and `allOrigins` filters, which picked clients in a shared gateway;
- adds the approval-waiting push and `env:NAME` secrets.

## Development

```bash
npm install
npm test     # state machine with a fake clock, plus the real ntfy wire format against a local HTTP server
```

## License

MIT. See LICENSE for both copyright lines.

# Changelog

## Unreleased

### Fixed

- `env:NAME` now resolves inside nested values, such as a generic webhook's `headers`. Before, a header written as `env:NAME` was sent as that literal text.
- Reply text and error messages are now cut by Unicode code point. Before, a cut could split an emoji (a UTF-16 surrogate pair) and leave a broken character in the push.
- The approval-waiting timer now catches its own errors. It runs outside the event handler's `try`, so a throw while building the push could have been an uncaught exception in the host process.
- A channel whose send function throws synchronously no longer stops the other channels from sending.
- After the plugin is disposed, late events are ignored and no new approval timers start.
- On `session/disposed`, the session's open turn and cooldown stamps are dropped, so they no longer pile up in a long-running host.

### Changed

- `send()` in `src/channels.js` takes an optional fourth argument, `{ timeout }` in milliseconds, which overrides the 10 s request timeout. The tests use it; the plugin itself still uses 10 s.

### Tests

- 11 → 46 tests. New coverage: each channel's request format against a local HTTP server (Server酱 via a stubbed `fetch`), Feishu and DingTalk signatures, IM error codes returned with HTTP 200, HTTP errors, refused connections and timeouts, missing `env:` variables, the `minMinutes` boundary, `max-tokens`, aborted/forked/errored turns, duplicate and overlapping turn events, approval edge cases, cooldowns, disposal and listener registration, Unicode truncation, and the config schema's defaults and rejections. No test touches the real network.

## 0.1.0

- Initial release.

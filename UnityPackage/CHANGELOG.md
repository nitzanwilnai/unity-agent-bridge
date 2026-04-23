# Changelog

All notable changes to this package are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-04-23

### Security

`/exec` invokes arbitrary static methods via reflection (including `NonPublic`), so loopback-only is not sufficient: other local processes and cross-origin browser pages (via DNS rebinding) could previously reach the server and execute code inside the Unity Editor. This release adds three layered checks:

- **Auth token required on every request.** The Editor generates 32 random bytes on first load and stores them at `<Project>/Library/UnityAgentBridge/token` (hex-encoded, `chmod 600` on macOS/Linux). Requests must carry the value in the `X-UAB-Token` header; constant-time compare. `Library/` is git-ignored by Unity convention, so the token does not enter version control.
- **Host header pinned.** Requests whose `Host:` header is not `127.0.0.1:5142` or `localhost:5142` are rejected. Defeats DNS-rebinding attacks where a browser treats a rebound hostname as same-origin to loopback.
- **Browser-origin requests rejected.** Requests carrying an `Origin:` or `Referer:` header are rejected. CLI clients do not send these; browsers do on cross-origin POSTs.

### Changed

- CLI auto-discovers the Unity project by walking up from `cwd` looking for an `Assets/` + `Library/` pair, and reads the token file automatically. Override with `--project <path>` or the `UAB_PROJECT` environment variable.
- `doctor` now distinguishes *server unreachable* / *token file missing* / *token rejected* / *host-origin rejected*.

### Preserved

- Invoking `NonPublic` static methods via `/exec` — the core developer-tool feature — is unchanged. Private and internal entry points remain callable by the CLI.

# Unity Agent Bridge

An HTTP server inside the Unity Editor that lets CLI-based AI agents (Claude Code, Gemini CLI, etc.) check compilation errors and execute static C# methods.

The server listens on `http://127.0.0.1:5142/` and exposes four endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /ping` | Liveness probe; returns `{"isCompiling": bool}` |
| `GET /refresh` | Trigger `AssetDatabase.Refresh()` |
| `GET /compile-errors` | Current compilation errors as JSON |
| `POST /exec` | Invoke a static method via reflection |

## Security

All requests require the `X-UAB-Token` header. The token is auto-generated on first Editor load at `<Project>/Library/UnityAgentBridge/token` with `chmod 600` on macOS/Linux. Requests carrying browser-origin headers (`Origin:` / `Referer:`) or a non-loopback `Host:` are rejected. Private and internal static methods remain callable by the CLI.

## Usage

Use the [`unity-agent-cli`](https://github.com/Guydivore/unity-agent-bridge/tree/main/CLI) Node tool; it locates the token automatically.

```bash
unity-agent-cli check                        # run AssetDatabase.Refresh + report compile errors
unity-agent-cli exec "MyClass.MyMethod()"    # invoke a static method
unity-agent-cli doctor                       # diagnose connectivity, token, auth
```

See the [repository README](https://github.com/Guydivore/unity-agent-bridge#readme) for the full agent-workflow guide, installation instructions, and `exec` integration patterns.

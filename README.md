# unity-agent-bridge

An HTTP bridge that lets command-line AI agents (Claude Code, Gemini CLI, etc.) interact with the Unity Editor — checking compilation errors and executing static C# methods.

## Architecture

1. **Unity Package** — A C# `[InitializeOnLoad]` editor script that runs an HTTP server on `127.0.0.1:5142` inside the Unity Editor. Endpoints: `/ping`, `/refresh`, `/compile-errors`, `/exec`.
2. **CLI Wrapper** — A Node.js tool (`unity-agent-cli`) that agents invoke to check compilation, execute methods, and diagnose issues. Returns standard exit codes (`0`/`1`) for autonomous fix loops.

## Installation

### 1. Unity Package (UPM)

In Unity: **Window > Package Manager > + > Add package from git URL**:

```
https://github.com/nitzanwilnai/unity-agent-bridge.git?path=/UnityPackage
```

### 2. CLI

```bash
cd CLI
npm install -g .
```

### 3. Verify

```bash
unity-agent-cli doctor
unity-agent-cli check
```

## Commands

```
unity-agent-cli check                         # Check for compilation errors
unity-agent-cli exec "ClassName.MethodName()"  # Execute a static C# method
unity-agent-cli doctor                        # Diagnose connection issues
```

## AI Agent Setup

Add to your project's `CLAUDE.md` or equivalent:

```
Whenever you create or modify a `.cs` file, verify compilation with: unity-agent-cli check
If exit code 1, read the errors, fix, and retry until exit code 0.
```

## License

MIT

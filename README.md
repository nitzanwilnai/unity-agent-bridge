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

### 3. Enable Run In Background

The Unity Editor must keep running while you work in your terminal. Enable this so the bridge stays responsive when Unity isn't focused:

**Edit > Project Settings > Player > Resolution and Presentation > Run In Background** ✓

### 4. Verify

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

## What You Can Build With `exec`

The `exec` command runs any static C# method in the Unity Editor, which means you can build custom automation on top of it. Here are patterns used in production projects:

### Automated Screenshots

Use a flag-file pattern to capture screenshots from Play Mode and let agents visually verify changes:

1. Create an Editor script with a static method (e.g. `PlayModeScreenshot.CaptureAllScreens()`) that:
   - Writes a flag file (e.g. `Screenshots/capture.flag`) with the output directory
   - Enables `Application.runInBackground` so Play Mode keeps running while unfocused
   - Calls `EditorApplication.EnterPlaymode()`
2. Create a runtime `MonoBehaviour` that on `Start()`:
   - Checks for the flag file
   - Navigates through UI states (menus, gameplay, etc.) via coroutines
   - Captures each screen with `Texture2D.ReadPixels()` + `EncodeToPNG()`
   - Writes a `screenshot.done` file when finished
3. The Editor script detects the done file and exits Play Mode

The agent calls `unity-agent-cli exec "PlayModeScreenshot.CaptureAllScreens()"`, waits for completion, then reads the saved screenshots to visually verify the result.

### Runtime Diagnostics

Use `exec` to run headless game logic tests without needing Play Mode:

```csharp
public static class GameDiagnostic
{
    public static void RunTest()
    {
        // Simulate N frames of game logic, log results
        Debug.Log("[Diag] Blocks remaining: 5, Ball pos: (1.2, 3.4)");
    }
}
```

The agent parses the output from `exec` to verify game logic is working correctly.

### UI Inspection

Dump the full UI hierarchy so agents can debug layout issues without screenshots:

```csharp
public static class UIDiagnostic
{
    public static void Run()
    {
        // Log all Canvas, RectTransform, Image, TextMeshPro details
        Debug.Log("[UIDiag] Button 'Play': anchor=(0.5,0.5), size=(200,60), fontSize=24");
    }
}
```

### Other Examples

- **Scene setup** — auto-configure a scene with required objects and components
- **Asset generation** — procedurally generate sprites, fonts, or icons
- **Build automation** — trigger iOS/Android builds from the command line
- **Save data management** — delete save files or add test data for QA
- **Game View sizing** — set the Game View to specific device resolutions via reflection

### Tip: Structured Logging

Use prefixed log messages (e.g. `[Diag]`, `[UIDiag]`, `[SSH]`) in your static methods. The `exec` command captures all output, and prefixes make it easy for agents to parse results programmatically.

## License

MIT

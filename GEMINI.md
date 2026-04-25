Whenever you create or modify a `.cs` file, you MUST verify that your code compiles by running the command: `unity-agent-cli check`.

- If it returns exit code `0`, your code is good and compilation succeeded.
- If it returns exit code `1`, read the compiler errors in the console output, fix the C# files, and run `unity-agent-cli check` again autonomously. Do this in a loop until the compile succeeds.

**If `unity-agent-cli` is not installed:** DO NOT run `npm install -g unity-agent-cli` — the package is not on the npm registry. It must be installed from a local clone of https://github.com/nitzanwilnai/unity-agent-bridge:

```bash
git clone https://github.com/nitzanwilnai/unity-agent-bridge.git
cd unity-agent-bridge/CLI
npm install -g .
```

Ask the user where they've cloned the repo (or to clone it) before attempting the install.

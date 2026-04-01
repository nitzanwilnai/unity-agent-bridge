#!/usr/bin/env node

const http = require('http');
const { execSync } = require('child_process');

const BASE = 'http://127.0.0.1:5142';
const cmd = process.argv[2];

if (cmd === 'doctor') {
  doctor();
} else if (cmd === 'exec') {
  const methodCall = process.argv.slice(3).join(' ');
  if (!methodCall) {
    console.error('Usage: unity-agent-cli exec "ClassName.MethodName()"');
    process.exit(1);
  }
  runExec(methodCall);
} else if (cmd === 'check') {
  runCheck();
} else {
  console.log('Usage: unity-agent-cli <command>');
  console.log('');
  console.log('Commands:');
  console.log('  check                          - Check for compilation errors');
  console.log('  exec "ClassName.MethodName()"   - Execute a static C# method in Unity');
  console.log('  doctor                         - Diagnose connection issues');
  process.exit(0);
}

// ── HTTP helpers ────────────────────────────────────────────

function get(path, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${path}`, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout')));
  });
}

function post(path, payload, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1',
      port: 5142,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout')));
    req.write(json);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── exec ────────────────────────────────────────────────────

async function runExec(methodCall) {
  try {
    const result = await post('/exec', { method: methodCall });
    if (result.success) {
      if (result.output) console.log(result.output);
      console.log('✅ Executed successfully');
      process.exit(0);
    } else {
      console.error('❌ Execution failed:');
      console.error(result.error || 'Unknown error');
      process.exit(1);
    }
  } catch (e) {
    if (e.message.includes('ECONNREFUSED') || e.message.includes('Timeout')) {
      console.error('Unity Editor is not open or the server is not running.');
      console.error('Run "unity-agent-cli doctor" for diagnostics.');
    } else {
      console.error('Error:', e.message);
    }
    process.exit(1);
  }
}

// ── check ───────────────────────────────────────────────────

async function runCheck() {
  try {
    // Trigger asset refresh so Unity picks up file changes
    try { await get('/refresh'); }
    catch {
      console.error('Unity Editor is not open or the server is not running.');
      console.error('');
      console.error('Run "unity-agent-cli doctor" for diagnostics.');
      process.exit(1);
    }

    // Wait for compilation to begin (Unity needs a moment)
    let compiling = false;
    for (let i = 0; i < 15; i++) {
      await sleep(500);
      try {
        const s = await get('/ping');
        if (s.isCompiling) { compiling = true; break; }
      } catch {
        // Connection lost → domain reload started, which means compilation is underway
        compiling = true;
        break;
      }
    }

    // Poll until compilation finishes
    let reconnectAttempts = 0;
    while (compiling) {
      try {
        const s = await get('/ping');
        if (reconnectAttempts > 0) {
          // Reconnected after domain reload → compilation succeeded
          compiling = false;
        } else {
          compiling = s.isCompiling;
        }
        reconnectAttempts = 0;
      } catch {
        reconnectAttempts++;
        if (reconnectAttempts > 30) {
          console.error('Unity server did not come back after domain reload (15s timeout).');
          process.exit(1);
        }
      }
      if (compiling || reconnectAttempts > 0) await sleep(500);
    }

    // Brief pause for LogEntries to populate
    await sleep(1000);

    // Fetch compile errors
    const errors = await get('/compile-errors');
    if (errors.length === 0) {
      console.log('✅ Compile Success');
      process.exit(0);
    } else {
      console.error('❌ Compilation Errors Found:');
      for (const e of errors) {
        console.error(`\nFile: ${e.File}:${e.Line}`);
        console.error(`Message: ${e.Message}`);
      }
      process.exit(1);
    }
  } catch (e) {
    console.error('Error during check:', e.message);
    process.exit(1);
  }
}

// ── doctor ──────────────────────────────────────────────────

async function doctor() {
  console.log('Unity Agent Bridge — Diagnostics');
  console.log('================================\n');

  // 1. Unity process
  console.log('1. Unity Editor process');
  let unityUp = false;
  try {
    const cmd = process.platform === 'darwin'
      ? 'pgrep -f "Unity"'
      : 'tasklist | findstr Unity';
    const out = execSync(cmd, { encoding: 'utf8' });
    unityUp = out.trim().length > 0;
  } catch {}

  if (unityUp) {
    console.log('   ✅ Running');
  } else {
    console.log('   ❌ Not running — open Unity and retry');
    process.exit(1);
  }

  // 2. Server connectivity
  console.log('\n2. Server connection (http://127.0.0.1:5142/ping)');
  let serverUp = false;
  try {
    const t0 = Date.now();
    const ping = await get('/ping');
    console.log(`   ✅ Responded in ${Date.now() - t0}ms  (isCompiling: ${ping.isCompiling})`);
    serverUp = true;
  } catch (e) {
    console.log(`   ❌ No response — ${e.message}`);
  }

  // 3. Package status
  console.log('\n3. Bridge package');
  if (serverUp) {
    console.log('   ✅ Installed and running');
  } else if (unityUp) {
    console.log('   ❌ Server not responding — the package may not be installed.');
    console.log('');
    console.log('   Install via Unity Package Manager:');
    console.log('   Window > Package Manager > + > Add package from git URL');
    console.log('   Then check Unity Console for:');
    console.log('      "[UnityAgentServer] Listening on http://127.0.0.1:5142/"');
  } else {
    console.log('   ⏳ Cannot check — Unity is not running');
  }

  console.log('\n================================');
}

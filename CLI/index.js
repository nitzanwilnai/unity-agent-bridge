#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = 'http://127.0.0.1:5142';
const TOKEN_HEADER = 'X-UAB-Token';
const TOKEN_RELATIVE = path.join('Library', 'UnityAgentBridge', 'token');

const args = parseArgs(process.argv.slice(2));

if (args.cmd === 'doctor') {
  doctor();
} else if (args.cmd === 'exec') {
  const methodCall = args.rest.join(' ');
  if (!methodCall) {
    console.error('Usage: unity-agent-cli exec "ClassName.MethodName()"');
    process.exit(1);
  }
  runExec(methodCall);
} else if (args.cmd === 'check') {
  runCheck();
} else {
  console.log('Usage: unity-agent-cli [--project <path>] <command>');
  console.log('');
  console.log('Commands:');
  console.log('  check                          - Check for compilation errors');
  console.log('  exec "ClassName.MethodName()"   - Execute a static C# method in Unity');
  console.log('  doctor                         - Diagnose connection issues');
  console.log('');
  console.log('Project discovery:');
  console.log('  Walks up from cwd looking for a Unity project (Assets/ + Library/).');
  console.log('  Override with --project <path> or UAB_PROJECT env var.');
  process.exit(0);
}

function parseArgs(argv) {
  const out = { cmd: null, rest: [], project: process.env.UAB_PROJECT || null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project' && i + 1 < argv.length) { out.project = argv[++i]; continue; }
    if (a.startsWith('--project=')) { out.project = a.slice('--project='.length); continue; }
    if (!out.cmd) { out.cmd = a; continue; }
    out.rest.push(a);
  }
  return out;
}

// ── Project + token discovery ───────────────────────────────

function findProjectRoot(explicit) {
  if (explicit) {
    const abs = path.resolve(explicit);
    if (isUnityProject(abs)) return abs;
    return null;
  }
  let dir = process.cwd();
  const { root } = path.parse(dir);
  while (true) {
    if (isUnityProject(dir)) return dir;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

function isUnityProject(dir) {
  try {
    return fs.existsSync(path.join(dir, 'Assets')) && fs.existsSync(path.join(dir, 'Library'));
  } catch { return false; }
}

function loadToken() {
  const projectRoot = findProjectRoot(args.project);
  if (!projectRoot) {
    return { ok: false, reason: 'no-project' };
  }
  const tokenPath = path.join(projectRoot, TOKEN_RELATIVE);
  if (!fs.existsSync(tokenPath)) {
    return { ok: false, reason: 'no-token', projectRoot, tokenPath };
  }
  try {
    const value = fs.readFileSync(tokenPath, 'utf8').trim();
    if (!value) return { ok: false, reason: 'empty-token', projectRoot, tokenPath };
    return { ok: true, token: value, projectRoot, tokenPath };
  } catch (e) {
    return { ok: false, reason: 'read-error', error: e.message, projectRoot, tokenPath };
  }
}

function explainTokenFailure(info) {
  if (info.reason === 'no-project') {
    console.error('Could not locate a Unity project.');
    console.error('Run from inside a Unity project directory, or pass --project <path> / set UAB_PROJECT.');
  } else if (info.reason === 'no-token') {
    console.error(`Token file not found at ${info.tokenPath}.`);
    console.error('Open the Unity project once with the bridge package installed to generate it.');
  } else if (info.reason === 'empty-token') {
    console.error(`Token file at ${info.tokenPath} is empty. Delete it and reopen Unity to regenerate.`);
  } else if (info.reason === 'read-error') {
    console.error(`Could not read token at ${info.tokenPath}: ${info.error}`);
  }
}

// ── HTTP helpers ────────────────────────────────────────────

function authHeaders(token) {
  return token ? { [TOKEN_HEADER]: token } : {};
}

function get(pathStr, token, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 5142,
      path: pathStr,
      method: 'GET',
      headers: authHeaders(token),
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(httpError(res.statusCode, body));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout')));
    req.end();
  });
}

function post(pathStr, payload, token, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1',
      port: 5142,
      path: pathStr,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
        ...authHeaders(token),
      },
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(httpError(res.statusCode, body));
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

function httpError(status, body) {
  const err = new Error(`HTTP ${status}: ${body}`);
  err.statusCode = status;
  return err;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── exec ────────────────────────────────────────────────────

async function runExec(methodCall) {
  const tok = loadToken();
  if (!tok.ok) { explainTokenFailure(tok); process.exit(1); }
  try {
    const result = await post('/exec', { method: methodCall }, tok.token);
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
    handleTransportError(e);
    process.exit(1);
  }
}

// ── check ───────────────────────────────────────────────────

async function runCheck() {
  const tok = loadToken();
  if (!tok.ok) { explainTokenFailure(tok); process.exit(1); }
  try {
    try { await get('/refresh', tok.token); }
    catch (e) {
      handleTransportError(e);
      process.exit(1);
    }

    let compiling = false;
    for (let i = 0; i < 15; i++) {
      await sleep(500);
      try {
        const s = await get('/ping', tok.token);
        if (s.isCompiling) { compiling = true; break; }
      } catch {
        // Connection lost → domain reload started, meaning compilation is underway.
        compiling = true;
        break;
      }
    }

    let reconnectAttempts = 0;
    while (compiling) {
      try {
        const s = await get('/ping', tok.token);
        if (reconnectAttempts > 0) {
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

    await sleep(1000);

    const errors = await get('/compile-errors', tok.token);
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

function handleTransportError(e) {
  if (e.statusCode === 401) {
    console.error('Unity server rejected the auth token.');
    console.error('The token file may be stale. Delete <Project>/Library/UnityAgentBridge/token and reopen Unity to regenerate.');
  } else if (e.statusCode === 403) {
    console.error('Unity server rejected the request (host/origin check).');
    console.error('Did you hit the server through a proxy or from a browser? Talk to 127.0.0.1 directly.');
  } else if (e.message.includes('ECONNREFUSED') || e.message.includes('Timeout')) {
    console.error('Unity Editor is not open or the server is not running.');
    console.error('Run "unity-agent-cli doctor" for diagnostics.');
  } else {
    console.error('Error:', e.message);
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

  // 2. Project + token file
  console.log('\n2. Project + token file');
  const tok = loadToken();
  if (tok.ok) {
    console.log(`   ✅ Project:   ${tok.projectRoot}`);
    console.log(`      Token at:  ${tok.tokenPath}`);
  } else {
    console.log('   ❌ Token lookup failed:');
    explainTokenFailure(tok);
  }

  // 3. Server connectivity (unauthenticated probe first)
  console.log('\n3. Server connection (http://127.0.0.1:5142/ping)');
  let serverReachable = false;
  let authOk = false;
  try {
    const t0 = Date.now();
    await get('/ping', tok.ok ? tok.token : null);
    console.log(`   ✅ Responded in ${Date.now() - t0}ms with valid token`);
    serverReachable = true;
    authOk = true;
  } catch (e) {
    if (e.statusCode === 401) {
      console.log('   ⚠️  Server reachable but token was rejected (401).');
      console.log('      The token file may be stale — regenerate by restarting Unity.');
      serverReachable = true;
    } else if (e.statusCode === 403) {
      console.log('   ⚠️  Server reachable but rejected the request (403 host/origin).');
      serverReachable = true;
    } else {
      console.log(`   ❌ No response — ${e.message}`);
    }
  }

  // 4. Package status
  console.log('\n4. Bridge package');
  if (serverReachable && authOk) {
    console.log('   ✅ Installed, running, authenticated');
  } else if (serverReachable && !authOk) {
    console.log('   ⚠️  Installed and running but auth is failing (see step 3)');
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

// runbay: control a running RunBay from a terminal, a script or CI.
// It talks to the app over a token-protected localhost connection and can start the app first if needed.
// Exit codes: 0 ok, 1 failed or timed out, 2 bad usage or unknown app, 3 RunBay is not running.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataDir = () => process.env.RUNBAY_DATA || path.join(process.env.APPDATA || os.homedir(), 'runbay');

function version() {
  try { return require('./package.json').version; } catch { return '?'; }
}

const HELP = `RunBay ${version()} - control your local dev servers from the terminal

Usage: runbay <command> [app or workspace] [options]

Commands
  list                     show your apps and workspaces
  status [name]            show what is running (all apps, or the details of one)
  start <name>             start an app or workspace (starts RunBay first if it is closed)
  stop <name>              stop it                (use --all to stop everything)
  restart <name>           stop, then start it again
  logs <name>              print recent output    (-n 100 lines, -s <service>, -f to follow)
  open                     bring the RunBay window to the front
  version | help

Options
  -w, --wait               start/restart: wait until every service is ready, then exit
      --timeout <sec>      how long --wait may take (default 120)
      --json               machine readable output
      --no-launch          do not start RunBay if it is not running
  -s, --service <name>     logs: only this service
  -n <lines>               logs: how many lines (default 100)
  -f, --follow             logs: keep printing new lines

A name can be shortened as long as it is unique ("runbay start gem" finds "Gemstone ERP").
Put ws: or app: in front to pick a workspace or an app: runbay start ws:client-x

Exit codes: 0 ok, 1 failed or timed out, 2 bad usage or unknown name, 3 RunBay not running.
Example for CI:  runbay start myshop --wait --timeout 180 && npm test`;

// ---------- arguments ----------
function parse(argv) {
  const a = { cmd: '', target: '', flags: {} };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--wait' || t === '-w') a.flags.wait = true;
    else if (t === '--json') a.flags.json = true;
    else if (t === '--no-launch') a.flags.noLaunch = true;
    else if (t === '--all') a.flags.all = true;
    else if (t === '-f' || t === '--follow') a.flags.follow = true;
    else if (t === '--timeout') a.flags.timeout = Number(argv[++i]);
    else if (t === '-n' || t === '--lines') a.flags.n = Number(argv[++i]);
    else if (t === '-s' || t === '--service') a.flags.service = argv[++i];
    else if (t === '-h' || t === '--help') a.cmd = 'help';
    else if (t === '-v' || t === '--version') a.cmd = 'version';
    else if (t.startsWith('-') && t.length > 1) return { error: `Unknown option ${t}` };
    else rest.push(t);
  }
  if (!a.cmd) a.cmd = rest.shift() || 'help';
  a.target = rest.join(' ').trim();
  return a;
}

// ---------- talking to the app ----------
function readConn() {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), 'cli.json'), 'utf8')); } catch { return null; }
}

function call(conn, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: conn.port, path: url, method, timeout: 20000,
      headers: { 'x-runbay-token': conn.token, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }); } catch { resolve({ status: res.statusCode, body: {} }); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function connect() {
  const conn = readConn();
  if (!conn) return null;
  try {
    const r = await call(conn, 'GET', '/v1/ping');
    return r.status === 200 ? conn : null;
  } catch {
    return null;
  }
}

async function launchApp() {
  const exe = process.env.RUNBAY_EXE || (/^node(\.exe)?$/i.test(path.basename(process.execPath)) ? '' : process.execPath);
  if (!exe) return false;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, ['--hidden'], { detached: true, stdio: 'ignore', env, windowsHide: true });
  child.on('error', () => {});
  child.unref();
  return true;
}

async function ensure(flags, launchAllowed, say) {
  let conn = await connect();
  if (conn) return conn;
  if (!launchAllowed || flags.noLaunch) return null;
  if (!(await launchApp())) return null;
  say('Starting RunBay...');
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    conn = await connect();
    if (conn) return conn;
  }
  return null;
}

// ---------- output ----------
const pad = (s, n) => String(s).padEnd(n);
const fmtMem = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB');
const fmtUp = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

function printList(data) {
  const row = (x) => `  ${pad(x.name, 28)} ${pad(x.state, 9)} ${pad(`${x.running}/${x.total} running`, 14)} ${x.group || ''}`;
  if (data.workspaces.length) { console.log('Workspaces'); data.workspaces.forEach((x) => console.log(row(x))); console.log(''); }
  console.log('Apps');
  if (!data.apps.length) console.log('  (none yet - add one in RunBay)');
  data.apps.forEach((x) => console.log(row(x)));
}

function printDetail(t) {
  console.log(`${t.name}  [${t.state}]`);
  const apps = t.apps || [t];
  for (const app of apps) {
    if (t.apps) console.log(`\n${app.name}  [${app.state}]`);
    for (const s of app.services) {
      const extra = s.status === 'running'
        ? [s.ports.length ? 'port ' + s.ports.join(',') : 'no port yet', s.health === 'down' ? 'not responding' : '', `up ${fmtUp(s.uptimeSec)}`, `${s.cpu.toFixed(0)}% CPU`, fmtMem(s.memMB)].filter(Boolean).join(', ')
        : s.status === 'crashed' ? `exit code ${s.exitCode}${s.retrying ? ' (restarting)' : ''}` : '';
      console.log(`  ${pad(s.name, 24)} ${pad(s.status, 10)} ${s.ready ? 'ready ' : '      '} ${extra}`);
      for (const u of [...(s.domainUrl ? [s.domainUrl] : []), ...s.urls]) console.log(`      ${u}`);
    }
  }
}

// ---------- commands ----------
async function resolveOrExit(conn, target, json) {
  const r = await call(conn, 'GET', `/v1/status?target=${encodeURIComponent(target)}`);
  if (r.status === 200) return r.body;
  const b = r.body || {};
  if (json) console.log(JSON.stringify(b));
  else {
    console.error(`runbay: ${b.error || 'unknown error'}`);
    (b.candidates || []).forEach((c) => console.error(`  ${c}`));
  }
  process.exit(2);
}

async function waitReady(conn, target, since, timeoutSec, json) {
  const end = Date.now() + timeoutSec * 1000;
  const last = new Map();
  const started = Date.now();
  while (Date.now() < end) {
    const r = await call(conn, 'GET', `/v1/status?target=${encodeURIComponent(target)}&since=${since}`);
    const t = r.body;
    const apps = t.apps || [t];
    for (const app of apps) {
      for (const s of app.services) {
        const key = s.status === 'running' ? (s.ready ? 'ready' : 'starting') : s.status === 'crashed' ? (s.retrying ? 'restarting' : 'crashed') : s.status;
        if (last.get(s.id) !== key && !json) {
          last.set(s.id, key);
          if (key !== 'stopped') console.error(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${s.name}: ${key}${key === 'ready' && s.ports.length ? ' (port ' + s.ports.join(',') + ')' : ''}${key === 'crashed' ? ' (exit code ' + s.exitCode + ')' : ''}`);
        }
      }
    }
    if (t.state === 'running') return { ok: true, status: t };
    if (t.state === 'failed') return { ok: false, status: t, reason: 'failed' };
    await sleep(1000);
  }
  const r = await call(conn, 'GET', `/v1/status?target=${encodeURIComponent(target)}&since=${since}`);
  return { ok: false, status: r.body, reason: 'timeout' };
}

async function showFailure(conn, target, status, json) {
  if (json) return;
  const apps = status.apps || [status];
  for (const app of apps) {
    for (const s of app.services.filter((x) => x.status === 'crashed' && !x.retrying)) {
      console.error(`\n${s.name} crashed (exit code ${s.exitCode}). Last output:`);
      const l = await call(conn, 'GET', `/v1/logs?target=${encodeURIComponent(app.name)}&type=app&service=${encodeURIComponent(s.name)}&n=15`);
      (l.body.lines || []).forEach((x) => console.error(`  ${x.text}`));
    }
  }
}

async function main() {
  const a = parse(process.argv.slice(2));
  if (a.error) { console.error(`runbay: ${a.error}\n\nRun "runbay help" for usage.`); return 2; }
  const f = a.flags;
  const say = (m) => { if (!f.json) console.error(m); };

  if (a.cmd === 'help') { console.log(HELP); return 0; }
  if (a.cmd === 'version') { console.log(version()); return 0; }
  const known = ['list', 'ls', 'status', 'start', 'stop', 'restart', 'logs', 'open'];
  if (!known.includes(a.cmd)) { console.error(`runbay: unknown command "${a.cmd}"\n\nRun "runbay help" for usage.`); return 2; }

  const launches = ['start', 'restart', 'open'].includes(a.cmd);
  const conn = await ensure(f, launches, say);
  if (!conn) {
    const msg = launches ? 'RunBay is not running and could not be started.' : 'RunBay is not running. Start it first, or use "runbay start <name>" which opens it for you.';
    if (f.json) console.log(JSON.stringify({ ok: false, error: msg })); else console.error(`runbay: ${msg}`);
    return 3;
  }

  switch (a.cmd) {
    case 'list':
    case 'ls': {
      const r = await call(conn, 'GET', '/v1/list');
      if (f.json) console.log(JSON.stringify(r.body, null, 2)); else printList(r.body);
      return 0;
    }
    case 'status': {
      if (!a.target) {
        const r = await call(conn, 'GET', '/v1/list');
        if (f.json) console.log(JSON.stringify(r.body, null, 2)); else printList(r.body);
        return 0;
      }
      const t = await resolveOrExit(conn, a.target, f.json);
      if (f.json) console.log(JSON.stringify(t, null, 2)); else printDetail(t);
      return t.state === 'failed' ? 1 : 0;
    }
    case 'open':
      await call(conn, 'POST', '/v1/show', {});
      return 0;
    case 'logs': {
      if (!a.target) { console.error('runbay: which app? Example: runbay logs myshop'); return 2; }
      const t = await resolveOrExit(conn, a.target, f.json);
      const q = (extra) => `/v1/logs?target=${encodeURIComponent(t.name)}&type=${t.type}${f.service ? '&service=' + encodeURIComponent(f.service) : ''}${extra}`;
      let r = await call(conn, 'GET', q(`&n=${Math.min(2000, f.n || 100)}`));
      if (r.status !== 200) { console.error(`runbay: ${r.body.error || 'failed'}`); return 2; }
      const multi = !!r.body.multi;
      const out = (l) => console.log(multi ? `[${l.svc}] ${l.text}` : l.text);
      r.body.lines.forEach(out);
      let since = r.body.last;
      while (f.follow) {
        await sleep(700);
        try { r = await call(conn, 'GET', q(`&since=${since}`)); } catch { return 3; }
        r.body.lines.forEach(out);
        since = r.body.last;
      }
      return 0;
    }
    case 'stop': {
      if (!a.target && !f.all) { console.error('runbay: what should I stop? Name an app, or use --all.'); return 2; }
      const r = await call(conn, 'POST', '/v1/run', { action: 'stop', target: a.target, all: !!f.all });
      if (r.status !== 200) { if (f.json) console.log(JSON.stringify(r.body)); else { console.error(`runbay: ${r.body.error}`); (r.body.candidates || []).forEach((c) => console.error(`  ${c}`)); } return 2; }
      if (f.json) console.log(JSON.stringify(r.body)); else console.log(f.all ? 'Stopped everything.' : `Stopped ${r.body.name}.`);
      return 0;
    }
    case 'start':
    case 'restart': {
      if (!a.target) { console.error(`runbay: which app? Example: runbay ${a.cmd} myshop`); return 2; }
      const r = await call(conn, 'POST', '/v1/run', { action: a.cmd, target: a.target });
      if (r.status !== 200) { if (f.json) console.log(JSON.stringify(r.body)); else { console.error(`runbay: ${r.body.error}`); (r.body.candidates || []).forEach((c) => console.error(`  ${c}`)); } return 2; }
      if (!f.wait) {
        if (f.json) console.log(JSON.stringify(r.body)); else console.log(`${a.cmd === 'start' ? 'Starting' : 'Restarting'} ${r.body.name}. Use "runbay status ${r.body.name}" to follow it, or add --wait.`);
        return 0;
      }
      const res = await waitReady(conn, r.body.name, r.body.at, f.timeout > 0 ? f.timeout : 120, f.json);
      if (f.json) console.log(JSON.stringify({ ok: res.ok, reason: res.reason || null, status: res.status }, null, 2));
      if (res.ok) { if (!f.json) console.log(`${r.body.name} is ready.`); return 0; }
      if (!f.json) console.error(res.reason === 'timeout' ? `\nrunbay: ${r.body.name} was not ready after ${f.timeout > 0 ? f.timeout : 120}s.` : `\nrunbay: ${r.body.name} failed to start.`);
      await showFailure(conn, r.body.name, res.status, f.json);
      return 1;
    }
    default:
      return 2;
  }
}

main().then((code) => process.exit(code), (e) => { console.error(`runbay: ${e && e.message ? e.message : e}`); process.exit(1); });

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, net: electronNet } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const QRCode = require('qrcode');
const { spawn, exec, execFile, execFileSync } = require('child_process');
const { detectFolder, pkgManager } = require('./detect');
const pkgJson = require('./package.json');

const MAX_LOG_LINES = 5000;
const SAMPLE_MS = 2000;
const CORES = os.cpus().length || 1;

let win = null;
let tray = null;
let quitting = false;
let projects = [];
let seq = 0;
const runtimes = new Map(); // svcId -> runtime state

// ---------- persistence ----------
const storeFile = () => path.join(app.getPath('userData'), 'projects.json');

function loadProjects() {
  // first start after the rename from AppRun: bring the saved apps along
  try {
    const legacy = path.join(app.getPath('appData'), 'apprun', 'projects.json');
    if (!fs.existsSync(storeFile()) && fs.existsSync(legacy)) {
      fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
      fs.copyFileSync(legacy, storeFile());
    }
  } catch {}
  try {
    projects = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
  } catch {
    projects = [];
  }
}

function saveProjects() {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(projects, null, 2));
}

const findService = (svcId) => {
  for (const p of projects) {
    const s = p.services.find((x) => x.id === svcId);
    if (s) return s;
  }
  return null;
};

// ---------- runtime ----------
function rt(svcId) {
  let r = runtimes.get(svcId);
  if (!r) {
    r = {
      status: 'stopped', // stopped | running | crashed
      proc: null,
      pid: null,
      startedAt: null,
      exitCode: null,
      stopping: false,
      logs: [],
      partial: { out: '', err: '' },
      ports: [],
      urls: [],
      cpu: 0,
      mem: 0,
      prevCpu: null,
      health: null, // null (unknown) | 'up' | 'down'
      conflictPort: null,
      retries: 0,
      errors: 0,
      idleSince: null,
      task: null, // 'install' | 'build' while a dependency task runs
      taskProc: null,
    };
    runtimes.set(svcId, r);
  }
  return r;
}

function snapshot() {
  const out = {};
  for (const [id, r] of runtimes) {
    out[id] = {
      status: r.status,
      pid: r.pid,
      startedAt: r.startedAt,
      exitCode: r.exitCode,
      ports: r.ports,
      urls: r.urls,
      cpu: r.cpu,
      mem: r.mem,
      health: r.health,
      conflictPort: r.conflictPort,
      retryAt: r.retryAt || null,
      errors: r.errors,
      idleSince: r.idleSince,
      task: r.task,
    };
  }
  return out;
}

const send = (ch, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
};
const pushStatus = () => {
  send('status', snapshot());
  updateTray();
};
let statusTimer = null;
const pushStatusSoon = () => {
  if (!statusTimer) statusTimer = setTimeout(() => { statusTimer = null; pushStatus(); }, 300);
};

const findProject = (svcId) => projects.find((p) => p.services.some((s) => s.id === svcId));
const svcLabel = (svcId) => {
  const p = findProject(svcId);
  const s = findService(svcId);
  return p && s ? `${p.name} › ${s.name}` : 'Service';
};

// desktop alerts only while the window is out of sight/focus, to avoid noise
function notify(title, body) {
  if (!Notification.isSupported()) return;
  if (win && win.isVisible() && win.isFocused()) return;
  const n = new Notification({ title, body });
  n.on('click', showWin);
  n.show();
}

function showWin() {
  if (!win) return;
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const ERR_RE = /\b\w*(?:error|exception)\b|\b(?:failed|fatal|EADDRINUSE)\b/i;
const URL_RE = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ngrok[a-z-]*\.[a-z]+\S*/gi;

function pushLog(svcId, text, err = false) {
  const r = rt(svcId);
  const line = { seq: ++seq, text, err };
  r.logs.push(line);
  if (!text.startsWith('[runbay]') && ERR_RE.test(text)) {
    r.errors++;
    pushStatusSoon();
  }
  if (r.logs.length > MAX_LOG_LINES) r.logs.splice(0, r.logs.length - MAX_LOG_LINES);
  if (/ERR_NGROK_(4018|105)|authentication failed/i.test(text) && !r.hinted) {
    r.hinted = true;
    pushLog(svcId, '[runbay] ngrok needs an authtoken. Run once in a terminal: ngrok config add-authtoken <YOUR_TOKEN>  (get it at dashboard.ngrok.com)', true);
  }
  const pm = text.match(/EADDRINUSE\D*:(\d+)/) || text.match(/Failed to listen on [^\s:]+:(\d+)/i);
  if (pm && r.conflictPort !== Number(pm[1])) {
    r.conflictPort = Number(pm[1]);
    pushStatus();
  }
  const m = text.match(URL_RE);
  if (m) {
    let changed = false;
    for (const u of m) {
      const clean = u.replace(/[)"'\],]+$/, '');
      if (!r.urls.includes(clean)) {
        r.urls.push(clean);
        changed = true;
        notify('ngrok URL ready', `${svcLabel(svcId)}: ${clean}`);
      }
    }
    if (changed) pushStatus();
  }
  send('log', { svcId, line });
}

function feed(svcId, kind, chunk) {
  const r = rt(svcId);
  const buf = r.partial[kind] + chunk.toString('utf8').replace(ANSI, '');
  const parts = buf.split(/\r\n|\n|\r/);
  r.partial[kind] = parts.pop();
  for (const l of parts) if (l.length) pushLog(svcId, l, kind === 'err');
}

function flushPartial(svcId) {
  const r = rt(svcId);
  for (const k of ['out', 'err']) {
    if (r.partial[k]) pushLog(svcId, r.partial[k], k === 'err');
    r.partial[k] = '';
  }
}

function parseEnv(text) {
  const env = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

function launchService(svcId) {
  const svc = findService(svcId);
  const r = rt(svcId);
  if (!svc || r.status === 'running') return;

  if (!svc.command || !svc.command.trim()) {
    pushLog(svcId, '[runbay] No command set for this service.', true);
    return;
  }
  const cwd = svc.cwd && svc.cwd.trim() ? svc.cwd : undefined;
  if (cwd && !fs.existsSync(cwd)) {
    pushLog(svcId, `[runbay] Folder not found: ${cwd}`, true);
    r.status = 'crashed';
    pushStatus();
    return;
  }

  const proj = findProject(svcId);
  const prof = proj && proj.activeProfile && (proj.profiles || []).find((x) => x.name === proj.activeProfile);
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...parseEnv(svc.env), ...parseEnv(prof && prof.vars) };
  if (svc.port && !env.PORT) env.PORT = String(svc.port);

  r.ports = [];
  r.urls = [];
  r.cpu = 0;
  r.mem = 0;
  r.prevCpu = null;
  r.exitCode = null;
  r.stopping = false;
  r.hinted = false;
  r.health = null;
  r.conflictPort = null;
  r.retryAt = null;
  r.errors = 0;
  r.idleSince = null;
  if (prof) pushLog(svcId, `[runbay] env profile: ${prof.name}`);
  pushLog(svcId, `[runbay] > ${svc.command}${cwd ? `   (in ${cwd})` : ''}`);

  let proc;
  try {
    proc = spawn(svc.command, [], { cwd, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    pushLog(svcId, `[runbay] Failed to start: ${e.message}`, true);
    r.status = 'crashed';
    pushStatus();
    return;
  }

  r.proc = proc;
  r.pid = proc.pid;
  r.startedAt = Date.now();
  r.status = 'running';

  proc.stdout.on('data', (d) => feed(svcId, 'out', d));
  proc.stderr.on('data', (d) => feed(svcId, 'err', d));
  proc.on('error', (e) => pushLog(svcId, `[runbay] Process error: ${e.message}`, true));
  proc.on('exit', (code) => {
    if (r.proc !== proc) return;
    flushPartial(svcId);
    r.proc = null;
    r.pid = null;
    r.startedAt = null;
    r.ports = [];
    r.cpu = 0;
    r.mem = 0;
    r.exitCode = code;
    r.status = r.stopping || code === 0 ? 'stopped' : 'crashed';
    pushLog(svcId, `[runbay] Process ended (exit code ${code})${r.stopping ? ' - stopped by user' : ''}`, r.status === 'crashed');
    const wasStopping = r.stopping;
    r.stopping = false;
    r.health = null;
    // a long healthy run resets the retry budget
    if (r.lastStart && Date.now() - r.lastStart > 60000) r.retries = 0;
    if (r.status === 'crashed' && !wasStopping) {
      notify('Service crashed', `${svcLabel(svcId)} exited with code ${code}`);
      scheduleAutoRestart(svcId);
    }
    pushStatus();
  });
  r.lastStart = Date.now();
  pushStatus();
  setTimeout(sample, 600);
}


// ---------- auto-restart ----------
const RESTART_DELAY_MS = 3000;

function scheduleAutoRestart(svcId) {
  const svc = findService(svcId);
  const r = rt(svcId);
  if (!svc || !svc.autoRestart) return;
  const max = Number(svc.maxRetries) || 3;
  if (r.retries >= max) {
    pushLog(svcId, `[runbay] Auto-restart gave up after ${max} attempts.`, true);
    return;
  }
  r.retries++;
  r.retryAt = Date.now() + RESTART_DELAY_MS;
  pushLog(svcId, `[runbay] Crashed - auto-restart ${r.retries}/${max} in ${RESTART_DELAY_MS / 1000}s...`);
  setTimeout(() => {
    r.retryAt = null;
    // skip if the user started/stopped it meanwhile or removed the service
    if (r.status === 'crashed' && findService(svcId)) startService(svcId);
    else pushStatus();
  }, RESTART_DELAY_MS);
}

// ---------- ngrok auto-install ----------
const isNgrokCmd = (cmd) => /^\s*ngrok(\.exe)?(\s|$)/i.test(cmd || '');
const ngrokDir = () => path.join(process.env.LOCALAPPDATA || os.homedir(), 'runbay', 'bin');
// folder used by versions before the rename
const legacyNgrokDir = () => path.join(process.env.LOCALAPPDATA || os.homedir(), 'apprun', 'bin');

function hasNgrok() {
  try {
    execFileSync('where', ['ngrok'], { windowsHide: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ngrokVersion() {
  try {
    const out = execFileSync('ngrok', ['version'], { windowsHide: true, encoding: 'utf8' });
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? m.slice(1).map(Number) : null;
  } catch {
    return null;
  }
}
// `--url=` (fixed domains) needs a recent agent; ngrok also rejects very old ones
const ngrokOutdated = () => {
  const v = ngrokVersion();
  return !v || v[0] < 3 || (v[0] === 3 && v[1] < 16);
};

// pick up PATH changes made by installers while the app is running
function refreshPath() {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')"],
      { windowsHide: true, encoding: 'utf8' }
    ).trim();
    if (out) process.env.PATH = out;
  } catch {}
}

function runLogged(cmd, args, log) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    const onData = (d) => d.toString('utf8').replace(ANSI, '').split(/\r\n|\n|\r/).map((l) => l.trim()).filter((l) => l && !/^[-\|\/\s]+$/.test(l)).forEach((l) => log(l));
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => { log(`${cmd} failed: ${e.message}`); resolve(-1); });
    p.on('exit', (c) => resolve(c));
  });
}

async function installNgrok(log) {
  log(hasNgrok() ? '[runbay] ngrok is outdated - updating it now...' : '[runbay] ngrok is not installed - installing it now...');
  // 1) official latest build, downloaded to a folder we own (no admin needed)
  const dir = ngrokDir();
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, 'ngrok.zip');
  const script = `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip' -OutFile '${zip}'; Expand-Archive '${zip}' -DestinationPath '${dir}' -Force; Remove-Item '${zip}'`;
  log('[runbay] downloading the latest ngrok...');
  await runLogged('powershell.exe', ['-NoProfile', '-Command', script], log);
  // our copy goes first on PATH so it wins over an older ngrok installed elsewhere
  process.env.PATH = dir + ';' + process.env.PATH.split(';').filter((x) => x !== dir).join(';');
  if (hasNgrok() && !ngrokOutdated()) { log(`[runbay] ngrok ready (${dir})`); return true; }

  // 2) fall back to winget
  let hasWinget = false;
  try {
    execFileSync('where', ['winget'], { windowsHide: true, stdio: 'ignore' });
    hasWinget = true;
  } catch {}
  if (hasWinget) {
    log('[runbay] direct download failed, trying winget...');
    await runLogged('winget', ['install', '--id', 'Ngrok.Ngrok', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'], log);
    refreshPath();
    if (hasNgrok() && !ngrokOutdated()) { log('[runbay] ngrok installed.'); return true; }
  }
  log('[runbay] Could not install ngrok automatically. Install it from https://ngrok.com/download and try again.');
  return false;
}

async function startService(svcId) {
  const svc = findService(svcId);
  const r = rt(svcId);
  if (!svc || r.status === 'running' || r.status === 'installing') return;
  if (isNgrokCmd(svc.command) && (!hasNgrok() || ngrokOutdated())) {
    r.status = 'installing';
    pushStatus();
    const ok = await installNgrok((l) => pushLog(svcId, l.startsWith('[runbay]') ? l : '   ' + l));
    if (!ok) {
      r.status = 'crashed';
      pushStatus();
      return;
    }
  }
  launchService(svcId);
}

function killTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

async function stopService(svcId) {
  const r = rt(svcId);
  if (!r.proc) return;
  r.stopping = true;
  r.retries = 0;
  const proc = r.proc;
  const done = new Promise((res) => proc.once('exit', res));
  const svc = findService(svcId);
  if (svc && svc.stopCommand && svc.stopCommand.trim()) {
    pushLog(svcId, `[runbay] > ${svc.stopCommand}`);
    await new Promise((res) => {
      const cwd = svc.cwd && fs.existsSync(svc.cwd) ? svc.cwd : undefined;
      exec(svc.stopCommand, { cwd, windowsHide: true, timeout: 20000 }, (err, out, errOut) => {
        String((out || '') + (errOut || '')).replace(ANSI, '').split(/\r?\n/).filter(Boolean).forEach((l) => pushLog(svcId, '   ' + l));
        res();
      });
    });
  }
  await killTree(r.pid);
  await Promise.race([done, new Promise((res) => setTimeout(res, 5000))]);
}

async function restartService(svcId) {
  await stopService(svcId);
  startService(svcId);
}

function stopAll() {
  return Promise.all([...runtimes.keys()].map((id) => stopService(id)));
}

// ---------- tray ----------
function updateTray() {
  if (!tray) return;
  const running = (p) => p.services.filter((s) => rt(s.id).status === 'running').length;
  const total = projects.reduce((a, p) => a + running(p), 0);
  tray.setToolTip(`RunBay - ${total} server(s) running`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show RunBay', click: showWin },
    { type: 'separator' },
    ...projects.map((p) => {
      const n = running(p);
      return n
        ? { label: `■ Stop ${p.name} (${n}/${p.services.length})`, click: () => Promise.all(p.services.map((s) => stopService(s.id))) }
        : { label: `▶ Run ${p.name}`, click: () => startProjectSeq(p.id) };
    }),
    ...(projects.length ? [{ type: 'separator' }] : []),
    { label: 'Stop everything', enabled: total > 0, click: () => stopAll() },
    { label: 'Quit RunBay', click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 }));
  tray.on('click', () => (win && win.isVisible() && !win.isMinimized() ? win.hide() : showWin()));
  updateTray();
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ready = listening on a port (or, for tunnels, a public URL showed up)
async function waitReady(svcId, timeoutMs = 90000) {
  const r = rt(svcId);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (r.status === 'crashed' || r.status === 'stopped') return false;
    if (r.status === 'running' && (r.ports.length || r.urls.length)) return true;
    await sleep(500);
  }
  return false;
}

const starting = new Set(); // projectIds with a start sequence in progress

// services start in listed order; each waits until the previous one is ready
async function startProjectSeq(pid) {
  if (starting.has(pid)) return;
  starting.add(pid);
  try {
    const list = projectServices(pid);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (rt(s.id).status !== 'running') await startService(s.id);
      if (i === list.length - 1) break;
      if (!(await waitReady(s.id))) pushLog(s.id, '[runbay] Did not become ready in time - continuing with the next service.', true);
      const delay = Number(s.delay) || 0;
      if (delay > 0) await sleep(delay * 1000);
    }
  } finally {
    starting.delete(pid);
  }
}

const projectServices = (pid) => (projects.find((p) => p.id === pid) || { services: [] }).services;

// ---------- sampling (CPU / memory / ports) ----------
let sampling = false;

function listProcs() {
  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const j = JSON.parse(stdout);
        resolve(Array.isArray(j) ? j : [j]);
      } catch {
        resolve([]);
      }
    });
  });
}

function tcpOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(600, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  }).then((ok) => ok || (host === '127.0.0.1' ? tcpOpen(port, '::1') : false));
}

function listPorts() {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const map = new Map(); // pid -> Set(port)
      if (!err) {
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
          if (!m) continue;
          const pid = Number(m[2]);
          if (!map.has(pid)) map.set(pid, new Set());
          map.get(pid).add(Number(m[1]));
        }
      }
      resolve(map);
    });
  });
}

async function sample() {
  if (sampling) return;
  const live = [...runtimes.values()].filter((r) => r.proc && r.pid);
  if (!live.length) return;
  sampling = true;
  try {
    const t = Date.now();
    const [procs, portMap] = await Promise.all([listProcs(), listPorts()]);
    const byPid = new Map();
    const children = new Map();
    for (const p of procs) {
      byPid.set(p.ProcessId, p);
      if (!children.has(p.ParentProcessId)) children.set(p.ParentProcessId, []);
      children.get(p.ParentProcessId).push(p.ProcessId);
    }
    for (const r of live) {
      if (!r.proc) continue;
      const tree = [];
      const stack = [r.pid];
      while (stack.length) {
        const id = stack.pop();
        if (!byPid.has(id) || tree.includes(id)) continue;
        tree.push(id);
        for (const c of children.get(id) || []) stack.push(c);
      }
      let mem = 0;
      let cpuTime = 0;
      const ports = new Set();
      for (const id of tree) {
        const p = byPid.get(id);
        mem += Number(p.WorkingSetSize) || 0;
        cpuTime += (Number(p.KernelModeTime) || 0) + (Number(p.UserModeTime) || 0);
        for (const port of portMap.get(id) || []) ports.add(port);
      }
      if (r.prevCpu) {
        const dt = (t - r.prevCpu.t) / 1000;
        const dc = Math.max(0, cpuTime - r.prevCpu.c) / 1e7;
        r.cpu = dt > 0 ? Math.min(100, (dc / dt / CORES) * 100) : 0;
      }
      r.prevCpu = { t, c: cpuTime };
      if (r.cpu < 1) r.idleSince = r.idleSince || t;
      else r.idleSince = null;
      r.mem = mem;
      r.ports = [...ports].sort((a, b) => a - b);
    }
    // services whose server lives outside the process tree (docker): trust the declared port if it accepts connections
    await Promise.all([...runtimes.entries()].map(async ([id, r]) => {
      if (!r.proc || r.ports.length) return;
      const svc = findService(id);
      const port = svc && Number(svc.port);
      if (port && (await tcpOpen(port))) r.ports = [port];
    }));
    pushStatus();
  } finally {
    sampling = false;
  }
}

// ---------- health check ----------
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port, path: '/', timeout: 2000 }, (res) => {
      res.resume();
      resolve(true); // any HTTP answer (even 404) means it is serving
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    // a refused connection is down; anything else (reset, non-HTTP reply) means something is listening
    req.on('error', (e) => resolve(!['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND'].includes(e.code)));
  });
}

async function checkHealth() {
  let changed = false;
  await Promise.all([...runtimes.entries()].map(async ([id, r]) => {
    if (r.status !== 'running') return;
    const svc = findService(id);
    const port = svc && r.ports.includes(Number(svc.port)) ? Number(svc.port) : r.ports[0];
    const h = port ? ((await probe(port)) ? 'up' : 'down') : null;
    if (h !== r.health) { r.health = h; changed = true; }
  }));
  if (changed) pushStatus();
}

// ---------- port conflicts ----------
function portOwner(port) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      const re = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
      const m = !err && out.split(/\r?\n/).map((l) => l.match(re)).find(Boolean);
      if (!m) return resolve(null);
      const pid = Number(m[1]);
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (e2, t) => {
        const n = !e2 && t.match(/^"([^"]+)"/);
        resolve({ pid, name: n ? n[1] : 'unknown' });
      });
    });
  });
}

// ---------- IPC ----------
ipcMain.handle('port:owner', (_e, port) => portOwner(Number(port)));
ipcMain.handle('port:free', async (_e, port) => {
  const o = await portOwner(Number(port));
  if (!o) return false;
  await killTree(o.pid);
  return true;
});

ipcMain.handle('shell:vscode', (_e, dir) => {
  if (dir && fs.existsSync(dir)) spawn('code', [`"${dir}"`], { shell: true, windowsHide: true, detached: true, stdio: 'ignore' }).unref();
});
ipcMain.handle('shell:terminal', (_e, dir) => {
  if (dir && fs.existsSync(dir)) spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
});

// QR for phone testing: localhost is meaningless on a phone, so use the LAN address
ipcMain.handle('qr:make', async (_e, url) => {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (lan) u.hostname = lan.address;
  }
  const target = u.toString();
  return { url: target, local: !/ngrok/i.test(u.hostname), dataUrl: await QRCode.toDataURL(target, { margin: 1, width: 280 }) };
});

ipcMain.handle('projects:get', () => projects);

ipcMain.handle('projects:save', (_e, p) => {
  p.id = p.id || crypto.randomUUID();
  p.services = (p.services || []).map((s) => ({ ...s, id: s.id || crypto.randomUUID() }));
  const i = projects.findIndex((x) => x.id === p.id);
  if (i >= 0) projects[i] = p;
  else projects.push(p);
  saveProjects();
  for (const s of p.services) rt(s.id);
  updateTray();
  return projects;
});

ipcMain.handle('projects:delete', async (_e, id) => {
  const p = projects.find((x) => x.id === id);
  if (p) {
    for (const s of p.services) {
      await stopService(s.id);
      runtimes.delete(s.id);
    }
    projects = projects.filter((x) => x.id !== id);
    saveProjects();
  }
  pushStatus();
  return projects;
});

ipcMain.handle('status:get', () => {
  for (const p of projects) for (const s of p.services) rt(s.id);
  return snapshot();
});
ipcMain.handle('logs:get', (_e, svcId) => rt(svcId).logs);
ipcMain.handle('logs:clear', (_e, svcId) => {
  const r = rt(svcId);
  r.logs = [];
  r.errors = 0;
  pushStatus();
});

ipcMain.handle('logs:export', async (_e, items, name, errorsOnly) => {
  const lines = [];
  const isErr = (l) => (l.text.startsWith('[runbay]') ? l.err : ERR_RE.test(l.text));
  for (const it of items) for (const l of rt(it.id).logs) if (!errorsOnly || isErr(l)) lines.push({ seq: l.seq, text: `[${it.name}] ${l.text}` });
  lines.sort((a, b) => a.seq - b.seq);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const r = await dialog.showSaveDialog(win, {
    defaultPath: `${String(name || 'logs').replace(/[^\w.-]+/g, '_')}-${stamp}.log`,
    filters: [{ name: 'Log file', extensions: ['log', 'txt'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, lines.map((l) => l.text).join('\n') + '\n');
  return r.filePath;
});

// ---------- git ----------
function git(dir, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) =>
      resolve({ ok: !err, out: out || '', err: errOut || (err ? err.message : '') }));
  });
}

async function gitRoots(p) {
  const roots = new Set();
  for (const s of p.services) {
    if (!s.cwd || !fs.existsSync(s.cwd)) continue;
    const r = await git(s.cwd, ['rev-parse', '--show-toplevel']);
    if (r.ok && r.out.trim()) roots.add(path.normalize(r.out.trim()));
  }
  return [...roots];
}

async function gitStatus(p) {
  const res = [];
  for (const root of await gitRoots(p)) {
    const r = await git(root, ['status', '--porcelain=v1', '-b']);
    if (!r.ok) continue;
    const lines = r.out.split(/\r?\n/).filter(Boolean);
    const head = (lines[0] || '').replace(/^## /, '');
    const bm = head.match(/^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/);
    const track = (bm && bm[3]) || '';
    res.push({
      root,
      name: path.basename(root),
      branch: bm ? bm[1] : head,
      upstream: !!(bm && bm[2]),
      ahead: Number((track.match(/ahead (\d+)/) || [])[1]) || 0,
      behind: Number((track.match(/behind (\d+)/) || [])[1]) || 0,
      changed: lines.length - 1,
    });
  }
  return res;
}

ipcMain.handle('git:status', (_e, pid) => {
  const p = projects.find((x) => x.id === pid);
  return p ? gitStatus(p) : [];
});
ipcMain.handle('git:pull', async (_e, pid, root) => {
  const p = projects.find((x) => x.id === pid);
  if (!p || !(await gitRoots(p)).includes(path.normalize(root))) return { ok: false, text: 'Unknown repository.' };
  const r = await git(root, ['pull', '--ff-only']);
  return { ok: r.ok, text: (r.out + r.err).trim() || (r.ok ? 'Done.' : 'git pull failed.') };
});

// ---------- profiles / bulk ----------
ipcMain.handle('profile:set', (_e, pid, name) => {
  const p = projects.find((x) => x.id === pid);
  if (p) {
    p.activeProfile = name || '';
    saveProjects();
  }
  return projects;
});
ipcMain.handle('all:stop', () => stopAll());

// ---------- ngrok request inspector (ngrok's local API) ----------
function ngrokApi(port, method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 3000 }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function splitRaw(b64) {
  const s = Buffer.from(b64 || '', 'base64').toString('utf8');
  const i = s.indexOf('\r\n\r\n');
  return i < 0 ? { head: s, body: '' } : { head: s.slice(0, i), body: s.slice(i + 4, i + 4 + 20000) };
}

ipcMain.handle('ngrok:requests', async (_e, port) => {
  try {
    const j = await ngrokApi(Number(port) || 4040, 'GET', '/api/requests/http?limit=60');
    return {
      ok: true,
      requests: (j.requests || []).map((q) => {
        const rq = splitRaw(q.request && q.request.raw);
        const rs = splitRaw(q.response && q.response.raw);
        return {
          id: q.id, start: q.start, ms: Math.round((q.duration || 0) / 1e6),
          method: q.request && q.request.method, uri: q.request && q.request.uri, status: q.response && q.response.status_code,
          reqHead: rq.head, reqBody: rq.body, resHead: rs.head, resBody: rs.body,
        };
      }),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('ngrok:clear', async (_e, port) => {
  try { await ngrokApi(Number(port) || 4040, 'DELETE', '/api/requests/http'); } catch {}
});

// ---------- import / export ----------
ipcMain.handle('config:export', async (_e, includeEnv) => {
  const data = {
    runbay: 1,
    exportedAt: new Date().toISOString(),
    projects: projects.map(({ id, ...p }) => ({
      ...p,
      services: p.services.map(({ id: _id, ...s }) => ({ ...s, env: includeEnv ? s.env : '' })),
      profiles: (p.profiles || []).map((x) => ({ ...x, vars: includeEnv ? x.vars : '' })),
    })),
  };
  const r = await dialog.showSaveDialog(win, { defaultPath: 'runbay-apps.json', filters: [{ name: 'RunBay config', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
  return r.filePath;
});

ipcMain.handle('config:import', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'RunBay config', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
  } catch {
    return { error: 'That file is not valid JSON.' };
  }
  if (!data || (data.runbay !== 1 && data.apprun !== 1) || !Array.isArray(data.projects)) return { error: 'That file is not a RunBay export.' };
  const str = (v) => (typeof v === 'string' ? v : '');
  let count = 0;
  for (const p of data.projects) {
    if (!p || !str(p.name)) continue;
    let name = p.name;
    while (projects.some((x) => x.name === name)) name += ' (imported)';
    const services = (Array.isArray(p.services) ? p.services : []).map((s) => ({
      id: crypto.randomUUID(), name: str(s.name) || 'Service', cwd: str(s.cwd), command: str(s.command), port: str(s.port),
      env: str(s.env), stopCommand: str(s.stopCommand), delay: Number(s.delay) || 0, autoRestart: !!s.autoRestart, maxRetries: Number(s.maxRetries) || 3,
    }));
    const profiles = (Array.isArray(p.profiles) ? p.profiles : []).filter((x) => x && str(x.name)).map((x) => ({ name: x.name, vars: str(x.vars) }));
    // never auto-run something that arrived from a file
    projects.push({
      id: crypto.randomUUID(), name, description: str(p.description), notes: str(p.notes), group: str(p.group),
      favorite: !!p.favorite, autoStart: false, profiles, activeProfile: profiles.some((x) => x.name === p.activeProfile) ? p.activeProfile : '', services,
    });
    for (const s of services) rt(s.id);
    count++;
  }
  saveProjects();
  updateTray();
  return { count, projects };
});

// ---------- dependencies (npm/pnpm/yarn install + build) ----------
const mtime = (f) => {
  try { return fs.statSync(f).mtimeMs; } catch { return 0; }
};

function depsInfo(svc) {
  const dir = svc.cwd;
  const pkgFile = dir && path.join(dir, 'package.json');
  if (!dir || !fs.existsSync(pkgFile)) return { hasPkg: false };
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch {}
  const pm = pkgManager(dir, path.parse(dir).root);
  const nm = path.join(dir, 'node_modules');
  let stale = false;
  let reason = '';
  // a package with no dependencies never gets a node_modules folder
  const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
  if (!hasDeps) {
    // nothing to install
  } else if (!fs.existsSync(nm)) {
    stale = true;
    reason = 'Dependencies are not installed';
  } else {
    const installed = Math.max(mtime(nm), ...['.package-lock.json', '.yarn-integrity', '.modules.yaml', '.apprun-installed', '.runbay-installed'].map((f) => mtime(path.join(nm, f))));
    const changed = Math.max(mtime(pkgFile), ...['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].map((f) => mtime(path.join(dir, f))));
    if (changed > installed + 1000) {
      stale = true;
      reason = 'package.json or the lockfile changed since the last install';
    }
  }
  return { hasPkg: true, stale, reason, pm, hasBuild: !!(pkg.scripts && pkg.scripts.build) };
}

function runTask(svcId, kind) {
  const svc = findService(svcId);
  const r = rt(svcId);
  if (!svc || r.task) return;
  const info = depsInfo(svc);
  if (!info.hasPkg) return;
  const { pm } = info;
  const cmd = kind === 'build' ? (pm === 'yarn' || pm === 'bun' ? `${pm} build` : `${pm} run build`) : `${pm} install`;
  r.task = kind;
  pushLog(svcId, `[runbay] > ${cmd}   (in ${svc.cwd})`);
  pushStatus();
  const proc = spawn(cmd, [], { cwd: svc.cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  r.taskProc = proc;
  const onData = (d) => d.toString('utf8').replace(ANSI, '').split(/\r\n|\n|\r/).filter(Boolean).forEach((l) => pushLog(svcId, '   ' + l));
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', (e) => pushLog(svcId, `[runbay] ${kind} failed to start: ${e.message}`, true));
  proc.on('exit', (code) => {
    r.task = null;
    r.taskProc = null;
    pushLog(svcId, `[runbay] ${kind} finished (exit code ${code})`, code !== 0);
    // mark the install so "changed since install" does not linger when npm had nothing to update
    if (kind === 'install' && code === 0) {
      try { fs.writeFileSync(path.join(svc.cwd, 'node_modules', '.runbay-installed'), String(Date.now())); } catch {}
    }
    notify(`${kind === 'build' ? 'Build' : 'Install'} ${code === 0 ? 'finished' : 'failed'}`, svcLabel(svcId));
    pushStatus();
  });
}

ipcMain.handle('deps:status', (_e, pid) => {
  const out = {};
  const p = projects.find((x) => x.id === pid);
  if (p) for (const s of p.services) out[s.id] = depsInfo(s);
  return out;
});
ipcMain.handle('svc:task', (_e, id, kind) => runTask(id, kind === 'build' ? 'build' : 'install'));

ipcMain.handle('svc:start', (_e, id) => startService(id));
ipcMain.handle('svc:stop', (_e, id) => stopService(id));
ipcMain.handle('svc:restart', (_e, id) => restartService(id));
ipcMain.handle('project:start', (_e, id) => { startProjectSeq(id); });
ipcMain.handle('project:stop', (_e, id) => Promise.all(projectServices(id).map((s) => stopService(s.id))));
ipcMain.handle('project:restart', async (_e, id) => {
  const list = projectServices(id);
  await Promise.all(list.map((s) => stopService(s.id)));
  startProjectSeq(id);
});

ipcMain.handle('detect:folder', (_e, dir) => detectFolder(dir));
ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:openUrl', (_e, u) => {
  if (/^https?:\/\//i.test(u)) shell.openExternal(u);
});

// ---------- about / updates ----------
const cmpVer = (a, b) => {
  const x = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const y = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
const updateUrl = () => String((pkgJson.runbay && pkgJson.runbay.updateUrl) || '').trim();

ipcMain.handle('app:info', () => {
  let changelog = '';
  try { changelog = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8'); } catch {}
  return { version: app.getVersion(), changelog, canCheckUpdates: !!updateUrl() };
});

ipcMain.handle('app:check-update', async () => {
  const url = updateUrl();
  if (!url) return { error: 'No update address is configured in this build.' };
  try {
    const res = await electronNet.fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) return { error: `The update server answered ${res.status}.` };
    const j = await res.json();
    if (!j || !j.version) return { error: 'The update file has no version.' };
    return { current: app.getVersion(), latest: String(j.version), newer: cmpVer(j.version, app.getVersion()) > 0, url: /^https?:\/\//i.test(j.url || '') ? j.url : '', notes: String(j.notes || '') };
  } catch (e) {
    return { error: `Could not reach the update server (${e.message}).` };
  }
});

// ---------- app lifecycle ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#0a0b10',
    title: 'RunBay',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  // closing/minimizing hides to the tray so servers keep running; quit from the tray menu
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('minimize', (e) => {
    e.preventDefault();
    win.hide();
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWin);
  app.whenReady().then(() => {
    loadProjects();
    refreshPath();
    for (const dir of [legacyNgrokDir(), ngrokDir()]) if (fs.existsSync(path.join(dir, 'ngrok.exe'))) process.env.PATH = dir + ';' + process.env.PATH;
    createWindow();
    createTray();
    setInterval(sample, SAMPLE_MS);
    setInterval(checkHealth, 4000);
    for (const p of projects) if (p.autoStart) startProjectSeq(p.id);
  });
}

app.on('before-quit', () => {
  quitting = true;
  for (const [id, r] of runtimes) {
    const svc = r.proc && findService(id);
    if (svc && svc.stopCommand && svc.stopCommand.trim()) {
      try {
        execFileSync('cmd.exe', ['/c', svc.stopCommand], { cwd: svc.cwd && fs.existsSync(svc.cwd) ? svc.cwd : undefined, windowsHide: true, stdio: 'ignore', timeout: 15000 });
      } catch {}
    }
    if (r.taskProc && r.taskProc.pid) {
      try {
        execFileSync('taskkill', ['/pid', String(r.taskProc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {}
    }
  }
  for (const r of runtimes.values()) {
    if (r.proc && r.pid) {
      try {
        execFileSync('taskkill', ['/pid', String(r.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {}
    }
  }
});

app.on('window-all-closed', () => app.quit());

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, globalShortcut, screen, safeStorage, net: electronNet } = require('electron');
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
const envtools = require('./envtools');
const dbtools = require('./dbtools');
const createDomains = require('./localdomains');
const versions = require('./runtimes');
const aihelper = require('./aihelper');

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

// ---------- settings + workspaces ----------
const DEFAULT_SETTINGS = {
  hotkey: 'Ctrl+Alt+R', startWithWindows: false, startMinimized: false, editor: 'code', logHistory: true,
  alerts: true, cpuLimit: 90, memLimitMB: 2048, silentMin: 0, // resource alerts (0 = off)
  domainsEnabled: false, httpsPort: 443, // local domains with HTTPS
  aiModel: aihelper.DEFAULT_MODEL, aiKeyEnc: '', // "Explain this error": the API key is kept encrypted with Windows (DPAPI)
};

// settings as the window may see them: never the stored key
const publicSettings = () => ({ ...settings, aiKeyEnc: undefined });
let settings = { ...DEFAULT_SETTINGS };
let workspaces = []; // [{ id, name, projectIds }]
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const workspacesFile = () => path.join(app.getPath('userData'), 'workspaces.json');

function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  try {
    const j = JSON.parse(fs.readFileSync(workspacesFile(), 'utf8'));
    workspaces = Array.isArray(j) ? j : [];
  } catch {
    workspaces = [];
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function saveWorkspaces() {
  fs.mkdirSync(path.dirname(workspacesFile()), { recursive: true });
  fs.writeFileSync(workspacesFile(), JSON.stringify(workspaces, null, 2));
}

// ---------- crash / health history ----------
const EVENTS_MAX = 300;
const eventsFile = () => path.join(app.getPath('userData'), 'history.json');
let events = {}; // svcId -> [{ t, type, detail }]; type: start | restart | stop | crash | down | up | alert
let eventsDirty = false;
const STATE_EVENTS = ['start', 'restart', 'stop', 'crash', 'down', 'up'];

function loadEvents() {
  try { events = JSON.parse(fs.readFileSync(eventsFile(), 'utf8')) || {}; } catch { events = {}; }
  // RunBay itself went away while a service was up: close that stretch of the timeline
  let at = Date.now();
  try { at = fs.statSync(eventsFile()).mtimeMs; } catch {}
  for (const list of Object.values(events)) {
    const last = [...list].reverse().find((e) => STATE_EVENTS.includes(e.type));
    if (last && ['start', 'restart', 'up', 'down'].includes(last.type)) list.push({ t: at, type: 'stop', detail: 'RunBay closed' });
  }
}

function recordEvent(svcId, type, detail = '') {
  const list = events[svcId] || (events[svcId] = []);
  list.push({ t: Date.now(), type, detail: String(detail).slice(0, 200) });
  if (list.length > EVENTS_MAX) list.splice(0, list.length - EVENTS_MAX);
  eventsDirty = true;
}

function saveEvents() {
  if (!eventsDirty) return;
  eventsDirty = false;
  try { fs.writeFileSync(eventsFile(), JSON.stringify(events)); } catch {}
}

const crashesSince = (svcId, ms) => (events[svcId] || []).filter((e) => e.type === 'crash' && e.t > Date.now() - ms).length;

// ---------- local domains (HTTPS proxy + certificate + hosts entries) ----------
let domains = null; // created once the app is ready (needs the userData folder)

// every service that has a domain, with the port its server is listening on right now
function domainRoutes() {
  const out = [];
  for (const p of projects) {
    for (const s of p.services) {
      const d = createDomains.cleanDomain(s.domain);
      if (!d) continue;
      const r = runtimes.get(s.id);
      const live = r && r.status === 'running' && r.ports.length ? (r.ports.includes(Number(s.port)) ? Number(s.port) : r.ports.find((x) => ![3306, 5432, 6379, 27017].includes(x)) || null) : null;
      out.push({ domain: d, port: live, label: `${p.name} › ${s.name}`, svcId: s.id });
    }
  }
  return out;
}

// what is still missing before this service's domain works in the browser: '' | 'proxy' | 'trust' | 'hosts'
function domainIssue(domain) {
  const st = domains.status();
  if (!settings.domainsEnabled || !st.running) return 'proxy';
  if (!st.trusted) return 'trust';
  if (st.hostsMissing.includes(domain)) return 'hosts';
  return '';
}

function domainsChanged() {
  if (!domains) return;
  domains.sync();
  domains.refreshStatus().then(pushStatusSoon);
}

// ---------- log history (kept on disk between sessions) ----------
const HISTORY_LINES = 2000;
const LOG_FILE_MAX = 4 * 1024 * 1024;
const logsDir = () => path.join(app.getPath('userData'), 'logs');
const logFile = (svcId) => path.join(logsDir(), `${svcId}.jsonl`);
const pendingLogs = new Map(); // svcId -> JSONL strings waiting for the next flush
const toJsonl = (l) => JSON.stringify({ t: l.t, e: l.err ? 1 : 0, x: l.text });

function persistLine(svcId, line) {
  if (!settings.logHistory) return;
  let a = pendingLogs.get(svcId);
  if (!a) pendingLogs.set(svcId, (a = []));
  a.push(toJsonl(line));
}

function flushLogs() {
  if (!pendingLogs.size) return;
  try { fs.mkdirSync(logsDir(), { recursive: true }); } catch {}
  for (const [id, arr] of pendingLogs) {
    const f = logFile(id);
    try {
      fs.appendFileSync(f, arr.join('\n') + '\n');
      if (fs.statSync(f).size > LOG_FILE_MAX) {
        const r = runtimes.get(id);
        const keep = r ? r.logs.filter((l) => !l.mem).slice(-HISTORY_LINES) : [];
        fs.writeFileSync(f, keep.map(toJsonl).join('\n') + (keep.length ? '\n' : ''));
      }
    } catch {}
  }
  pendingLogs.clear();
}

function dropLogFile(svcId) {
  pendingLogs.delete(svcId);
  try { fs.unlinkSync(logFile(svcId)); } catch {}
}

function loadHistory() {
  if (!settings.logHistory) return;
  let files = [];
  try { files = fs.readdirSync(logsDir()); } catch { return; }
  const known = new Set(projects.flatMap((p) => p.services.map((s) => s.id)));
  const all = [];
  const last = new Map(); // svcId -> time of its newest saved line
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -6);
    if (!known.has(id)) { try { fs.unlinkSync(path.join(logsDir(), f)); } catch {} continue; }
    let lines;
    try { lines = fs.readFileSync(logFile(id), 'utf8').split('\n').filter(Boolean); } catch { continue; }
    const tail = lines.slice(-HISTORY_LINES);
    if (lines.length > tail.length) { try { fs.writeFileSync(logFile(id), tail.join('\n') + '\n'); } catch {} }
    for (const raw of tail) {
      try {
        const j = JSON.parse(raw);
        all.push({ id, t: Number(j.t) || 0, err: !!j.e, text: String(j.x) });
        last.set(id, Number(j.t) || 0);
      } catch {}
    }
  }
  all.sort((a, b) => a.t - b.t);
  for (const e of all) rt(e.id).logs.push({ seq: ++seq, text: e.text, err: e.err, t: e.t });
  for (const [id, t] of last) {
    const when = t ? new Date(t).toLocaleString() : 'earlier';
    rt(id).logs.push({ seq: ++seq, text: `[runbay] ----- previous session (last output ${when}) -----`, err: false, t: Date.now(), mem: true });
  }
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
      id: svcId,
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
      alert: r.alert || null,
      crashes24: crashesSince(id, 864e5),
      runtime: r.runtime || [],
      runtimeMissing: r.runtimeMissing || [],
    };
    const svc = findService(id);
    if (svc) {
      const db = dbtools.describe(svc);
      out[id].dbKind = db ? db.kind : null;
      const d = createDomains.cleanDomain(svc.domain);
      out[id].domain = d;
      if (d && domains) {
        const issue = domainIssue(d);
        out[id].domainIssue = issue;
        out[id].domainUrl = issue === 'proxy' ? '' : domains.urlFor(d);
      }
    }
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
function notify(title, body, force = false) {
  if (!Notification.isSupported()) return;
  if (!force && win && win.isVisible() && win.isFocused()) return;
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
// lines of a stack trace (JS, Python, Java, PHP, Go); they belong to the error above them
const STACK_RE = /^\s+at\s+\S|^\s*File ".+", line \d+|^Traceback \(most recent call last\)|^\s*Caused by:|^\s+\.\.\. \d+ more|^\s*#\d+\s+\S.*\(\d+\)|^\s+\S+\.go:\d+/;
const URL_RE = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ngrok[a-z-]*\.[a-z]+\S*/gi;

function pushLog(svcId, text, err = false) {
  const r = rt(svcId);
  const line = { seq: ++seq, text, err, t: Date.now() };
  r.logs.push(line);
  if (!text.startsWith('[runbay]')) r.lastLogAt = line.t;
  persistLine(svcId, line);
  if (!text.startsWith('[runbay]') && !STACK_RE.test(text) && ERR_RE.test(text)) {
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
  r.attemptAt = Date.now();

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
  // server-side calls to https://yourapp.test must trust the local certificate too
  const ca = domains && settings.domainsEnabled ? domains.caPath() : null;
  if (ca && !env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = ca;
  // the Node / Python / PHP version the project asks for, only for this process
  const rp = versions.plan(cwd, svc.runtime || 'auto');
  versions.applyToEnv(env, rp.chosen);
  r.runtime = rp.chosen.map((c) => ({ label: versions.label(c), source: c.source, manager: c.manager }));
  r.runtimeMissing = rp.missing.map((m) => ({ text: `${versions.LANGS[m.lang]} ${m.spec}`, source: m.source, hint: m.hint }));
  for (const c of rp.chosen) if (c.dir) pushLog(svcId, `[runbay] using ${versions.label(c)} (${c.source}, ${c.manager})`);
  for (const m of rp.missing) pushLog(svcId, `[runbay] ${versions.LANGS[m.lang]} ${m.spec} is required by ${m.source} but is not installed here, so the system version is used. To fix: ${m.hint}`, true);

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
  r.alert = null;
  r.alertState = null;
  r.lastLogAt = Date.now();
  if (prof) pushLog(svcId, `[runbay] env profile: ${prof.name}`);
  pushLog(svcId, `[runbay] > ${svc.command}${cwd ? `   (in ${cwd})` : ''}`);
  const envCheck = envtools.missingKeys(cwd, [...Object.keys(parseEnv(svc.env)), ...Object.keys(parseEnv(prof && prof.vars))]);
  if (envCheck && envCheck.missing.length) {
    const n = envCheck.missing.length;
    pushLog(svcId, `[runbay] ${n} variable${n > 1 ? 's' : ''} from ${envCheck.template} ${n > 1 ? 'are' : 'is'} not set in your .env files: ${envCheck.missing.slice(0, 8).join(', ')}${n > 8 ? ', ...' : ''}`);
  }

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
  recordEvent(svcId, r.viaRestart ? 'restart' : 'start', r.viaRestart ? 'automatic restart after a crash' : '');
  r.viaRestart = false;

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
    recordEvent(svcId, r.status === 'crashed' ? 'crash' : 'stop', r.status === 'crashed' ? `exit code ${code}` : wasStopping ? 'stopped by user' : 'exited normally');
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
    if (r.status === 'crashed' && findService(svcId)) { r.viaRestart = true; startService(svcId); }
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
  for (const pid of starting) cancelled.add(pid);
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
    { label: `Quick launcher (${settings.hotkey || 'no shortcut'})`, click: toggleLauncher },
    { type: 'separator' },
    ...workspaces.map((w) => {
      const act = workspaceAction(w);
      return act === 'stop'
        ? { label: `■ Stop workspace ${w.name}`, click: () => stopWorkspace(w.id) }
        : { label: `▶ Run workspace ${w.name}`, click: () => startWorkspace(w.id) };
    }),
    ...(workspaces.length ? [{ type: 'separator' }] : []),
    ...projects.map((p) => {
      const n = running(p);
      return n
        ? { label: `■ Stop ${p.name} (${n}/${p.services.length})`, click: () => stopProject(p.id) }
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
const cancelled = new Set(); // ...whose sequence the user stopped before it finished

// stop every service of an app, and make sure a start sequence still in progress does not bring the rest up afterwards
function stopProject(pid) {
  if (starting.has(pid)) cancelled.add(pid);
  return Promise.all(projectServices(pid).map((s) => stopService(s.id)));
}

function hasDepCycle(list) {
  const byId = new Map(list.map((s) => [s.id, s]));
  const state = new Map(); // 1 = visiting, 2 = done
  const visit = (id) => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    for (const d of (byId.get(id) || {}).dependsOn || []) if (byId.has(d) && visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return list.some((s) => visit(s.id));
}

// "wait for" arrows: a service starts once everything it depends on is listening; the rest start straight away
async function startGraph(pid, list) {
  const byId = new Map(list.map((s) => [s.id, s]));
  const needed = new Set(list.flatMap((s) => (s.dependsOn || []).filter((d) => byId.has(d))));
  const done = new Map();
  const go = (s) => {
    if (!done.has(s.id)) {
      done.set(s.id, (async () => {
        await Promise.all((s.dependsOn || []).filter((d) => byId.has(d)).map((d) => go(byId.get(d))));
        if (cancelled.has(pid)) return;
        if (rt(s.id).status !== 'running') await startService(s.id);
        if (!needed.has(s.id)) return;
        if (!(await waitReady(s.id)) && !cancelled.has(pid)) pushLog(s.id, '[runbay] Did not become ready in time - starting the services that wait for it anyway.', true);
        const delay = Number(s.delay) || 0;
        if (delay > 0 && !cancelled.has(pid)) await sleep(delay * 1000);
      })());
    }
    return done.get(s.id);
  };
  await Promise.all(list.map(go));
}

async function restartProject(pid) {
  await stopProject(pid);
  // a start sequence that was cancelled needs a moment to wind down before a new one is accepted
  for (let i = 0; i < 40 && starting.has(pid); i++) await sleep(250);
  startProjectSeq(pid);
}

// services start in listed order; each waits until the previous one is ready
async function startProjectSeq(pid) {
  if (starting.has(pid)) return;
  starting.add(pid);
  cancelled.delete(pid);
  try {
    const list = projectServices(pid);
    if (list.some((x) => (x.dependsOn || []).length) && !hasDepCycle(list)) {
      await startGraph(pid, list);
      return;
    }
    for (let i = 0; i < list.length; i++) {
      if (cancelled.has(pid)) break;
      const s = list[i];
      if (rt(s.id).status !== 'running') await startService(s.id);
      if (i === list.length - 1) break;
      if (!(await waitReady(s.id)) && !cancelled.has(pid)) pushLog(s.id, '[runbay] Did not become ready in time - continuing with the next service.', true);
      const delay = Number(s.delay) || 0;
      if (delay > 0) await sleep(delay * 1000);
    }
  } finally {
    starting.delete(pid);
    cancelled.delete(pid);
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

// notify once when a service stays above a limit, and again only after it has calmed down
function checkAlerts(r, t) {
  if (!settings.alerts) { r.alert = null; return; }
  const a = r.alertState || (r.alertState = { cpuSince: null, cpu: false, mem: false, silent: false });
  const raise = (kind, title, msg) => {
    pushLog(r.id, `[runbay] ⚠ ${msg}`);
    recordEvent(r.id, 'alert', msg);
    notify(`${svcLabel(r.id)}: ${title}`, msg, true);
  };
  const cpuMax = Number(settings.cpuLimit) || 0;
  if (cpuMax) {
    if (r.cpu >= cpuMax) {
      a.cpuSince = a.cpuSince || t;
      if (!a.cpu && t - a.cpuSince >= 30000) { a.cpu = true; raise('cpu', 'high CPU', `CPU has been above ${cpuMax}% for 30 seconds (now ${r.cpu.toFixed(0)}%).`); }
    } else if (r.cpu < cpuMax * 0.8) { a.cpuSince = null; a.cpu = false; }
  }
  const memMax = (Number(settings.memLimitMB) || 0) * 1048576;
  if (memMax) {
    if (r.mem >= memMax && !a.mem) { a.mem = true; raise('mem', 'high memory', `Memory is above ${settings.memLimitMB} MB (now ${Math.round(r.mem / 1048576)} MB).`); }
    else if (r.mem < memMax * 0.9) a.mem = false;
  }
  const quiet = (Number(settings.silentMin) || 0) * 60000;
  if (quiet) {
    const last = r.lastLogAt || r.startedAt || t;
    if (t - last >= quiet && !a.silent) { a.silent = true; raise('silent', 'gone quiet', `No output for ${settings.silentMin} minutes - it may be stuck.`); }
    else if (t - last < quiet) a.silent = false;
  }
  r.alert = a.cpu ? 'cpu' : a.mem ? 'mem' : a.silent ? 'silent' : null;
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
      checkAlerts(r, t);
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
    if (h !== r.health) {
      if (h === 'down') recordEvent(id, 'down', `not answering on port ${port}`);
      else if (h === 'up' && r.health === 'down') recordEvent(id, 'up', 'answering again');
      r.health = h;
      changed = true;
    }
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

// ---------- workspaces ----------
const wsProjects = (w) => w.projectIds.map((id) => projects.find((p) => p.id === id)).filter(Boolean);
const projRunning = (p) => p.services.filter((s) => rt(s.id).status === 'running').length;
const findWorkspace = (id) => workspaces.find((w) => w.id === id);

// 'stop' when every app of the workspace is fully running, otherwise 'run'
function workspaceAction(w) {
  const ps = wsProjects(w);
  return ps.length && ps.every((p) => p.services.length && projRunning(p) === p.services.length) ? 'stop' : 'run';
}
function projectAction(p) {
  return p.services.length && projRunning(p) === p.services.length ? 'stop' : 'run';
}

function startWorkspace(id) {
  const w = findWorkspace(id);
  if (w) for (const p of wsProjects(w)) startProjectSeq(p.id);
}
function stopWorkspace(id) {
  const w = findWorkspace(id);
  if (!w) return Promise.resolve();
  return Promise.all(wsProjects(w).map((p) => stopProject(p.id)));
}

// ---------- editor / terminal helpers ----------
function hasCmd(name) {
  if (!name) return false;
  try {
    execFileSync('where', [name], { windowsHide: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// start a program that outlives RunBay; a missing program must never crash the app
function detach(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts });
  p.on('error', () => {});
  p.unref();
}

const editorCmd = () => {
  const e = String(settings.editor || '').trim();
  return /\s/.test(e) && !/^".*"$/.test(e) ? `"${e}"` : e;
};
const GOTO_EDITORS = ['code', 'code-insiders', 'cursor', 'windsurf', 'codium', 'vscodium'];

// ---------- quick launcher (global hotkey) ----------
let launcher = null;
let hotkeyError = '';

function createLauncher() {
  launcher = new BrowserWindow({
    width: 620,
    height: 430,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#12141b',
    webPreferences: { preload: path.join(__dirname, 'launcher-preload.js'), contextIsolation: true },
  });
  launcher.loadFile(path.join(__dirname, 'renderer', 'launcher.html'));
  launcher.on('blur', () => {
    if (launcher && !launcher.isDestroyed() && !launcher.webContents.isDevToolsOpened()) launcher.hide();
  });
  launcher.on('closed', () => { launcher = null; });
}

function toggleLauncher() {
  if (launcher && !launcher.isDestroyed() && launcher.isVisible()) return launcher.hide();
  if (!launcher || launcher.isDestroyed()) createLauncher();
  const open = () => {
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    launcher.setPosition(Math.round(wa.x + (wa.width - 620) / 2), Math.round(wa.y + wa.height * 0.16));
    launcher.show();
    launcher.focus();
    launcher.webContents.send('launcher:open');
  };
  if (launcher.webContents.isLoading()) launcher.webContents.once('did-finish-load', open);
  else open();
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  hotkeyError = '';
  const key = String(settings.hotkey || '').trim();
  if (!key) return true;
  try {
    if (globalShortcut.register(key, toggleLauncher)) return true;
    hotkeyError = `${key} is taken by another app.`;
  } catch {
    hotkeyError = `"${key}" is not a valid shortcut.`;
  }
  return false;
}

function applyLoginItem() {
  // dev runs would register electron.exe itself
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: !!settings.startWithWindows,
    path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
    args: settings.startMinimized ? ['--hidden'] : [],
  });
}

// ---------- port map (every listening port on the machine) ----------
const PROTECTED = new Set(['system', 'system idle process', 'registry', 'svchost.exe', 'lsass.exe', 'services.exe', 'wininit.exe', 'csrss.exe', 'smss.exe', 'winlogon.exe', 'spoolsv.exe', 'dwm.exe', 'explorer.exe']);

function listProcInfo() {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
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

function netstatListeners() {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const rows = new Map(); // "port:pid" -> { port, pid, addresses }
      if (!err) {
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
          if (!m) continue;
          const key = `${m[2]}:${m[3]}`;
          if (!rows.has(key)) rows.set(key, { port: Number(m[2]), pid: Number(m[3]), addresses: [] });
          const a = m[1].replace(/^\[|\]$/g, '');
          if (!rows.get(key).addresses.includes(a)) rows.get(key).addresses.push(a);
        }
      }
      resolve([...rows.values()]);
    });
  });
}

// the RunBay service whose process tree contains pid, if any
function serviceOfPid(pid, byPid) {
  const owner = new Map();
  for (const [id, r] of runtimes) if (r.proc && r.pid) owner.set(r.pid, id);
  let cur = pid;
  for (let i = 0; i < 40 && cur; i++) {
    if (owner.has(cur)) return owner.get(cur);
    const p = byPid.get(cur);
    if (!p) return null;
    cur = p.ParentProcessId;
  }
  return null;
}

const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a.startsWith('127.');

async function portMap() {
  const [procs, listeners] = await Promise.all([listProcInfo(), netstatListeners()]);
  const byPid = new Map(procs.map((p) => [p.ProcessId, p]));
  // services that are not running but whose configured port is taken by something else
  const wanted = new Map(); // port -> [labels]
  for (const p of projects) {
    for (const s of p.services) {
      const port = Number(s.port);
      if (!port || rt(s.id).status === 'running') continue;
      if (!wanted.has(port)) wanted.set(port, []);
      wanted.get(port).push(`${p.name} › ${s.name}`);
    }
  }
  return listeners
    .map((l) => {
      const proc = byPid.get(l.pid);
      const name = (proc && proc.Name) || (l.pid === 0 ? 'System Idle' : l.pid === 4 ? 'System' : 'unknown');
      const svcId = serviceOfPid(l.pid, byPid);
      return {
        port: l.port,
        pid: l.pid,
        name,
        cmd: proc && proc.CommandLine ? String(proc.CommandLine).slice(0, 400) : '',
        addresses: l.addresses,
        localOnly: l.addresses.every(isLoopback),
        svcId,
        svcLabel: svcId ? svcLabel(svcId) : '',
        needs: svcId ? [] : wanted.get(l.port) || [],
        protected: l.pid <= 4 || PROTECTED.has(name.toLowerCase()),
      };
    })
    .sort((a, b) => a.port - b.port || a.pid - b.pid);
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
  if (!dir || !fs.existsSync(dir)) return;
  if (editorCmd()) detach(editorCmd(), [`"${dir}"`], { shell: true });
  else shell.openPath(dir);
});
ipcMain.handle('shell:terminal', (_e, dir) => {
  if (!dir || !fs.existsSync(dir)) return;
  // Windows Terminal when it is installed, plain cmd otherwise
  if (hasCmd('wt')) detach('wt.exe', ['-d', dir]);
  else detach('cmd.exe', ['/c', 'start', 'cmd.exe'], { cwd: dir });
});

// open a file mentioned in the logs, at its line, in the chosen editor
ipcMain.handle('file:open', (_e, svcId, file, line, col) => {
  file = String(file || '');
  const p = findProject(svcId);
  const bases = [findService(svcId), ...(p ? p.services : [])].filter((s) => s && s.cwd).map((s) => s.cwd);
  const candidates = path.isAbsolute(file) ? [file] : bases.map((b) => path.resolve(b, file));
  const found = candidates.find((f) => {
    try { return fs.statSync(f).isFile(); } catch { return false; }
  });
  // the path comes from log text and ends up in a shell command: refuse anything with shell characters
  if (!found || /[&|^%"<>`!]/.test(found)) return { ok: false, error: 'File not found.' };
  const ed = editorCmd();
  if (!ed || !hasCmd(String(settings.editor).trim())) {
    shell.showItemInFolder(found);
    return { ok: true, fallback: true };
  }
  const exe = path.basename(String(settings.editor).trim().replace(/"/g, '')).toLowerCase().replace(/\.(cmd|exe|bat)$/, '');
  const ln = Math.max(1, parseInt(line, 10) || 1);
  const cl = Math.max(1, parseInt(col, 10) || 1);
  detach(ed, GOTO_EDITORS.includes(exe) ? ['--goto', `"${found}:${ln}:${cl}"`] : [`"${found}"`], { shell: true });
  return { ok: true };
});

ipcMain.handle('ports:list', () => portMap());
ipcMain.handle('ports:kill', async (_e, port, pid) => {
  port = Number(port);
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 4) return { ok: false, error: 'That process is protected.' };
  const rows = await portMap();
  const row = rows.find((r) => r.port === port && r.pid === pid);
  if (!row) return { ok: false, error: 'That port is no longer used by this process.' };
  if (row.protected) return { ok: false, error: `${row.name} is a Windows system process.` };
  if (row.svcId && rt(row.svcId).proc) await stopService(row.svcId);
  else await killTree(pid);
  return { ok: true };
});

// ---------- language versions ----------
ipcMain.handle('runtime:list', () => versions.catalog());
ipcMain.handle('runtime:detect', (_e, cwd, mode) => {
  if (!cwd || !fs.existsSync(cwd)) return { pins: [], chosen: [], missing: [] };
  const pl = versions.plan(cwd, mode || 'auto');
  return { pins: pl.pins, chosen: pl.chosen.map((c) => ({ label: versions.label(c), source: c.source, manager: c.manager })), missing: pl.missing };
});

// ---------- command line (runbay start myapp) ----------
let controlServer = null;
const cliFile = () => path.join(app.getPath('userData'), 'cli.json');
const targets = () => [
  ...projects.map((p) => ({ type: 'app', id: p.id, name: p.name })),
  ...workspaces.map((w) => ({ type: 'workspace', id: w.id, name: w.name })),
];

// "gem" finds "Gemstone ERP" when nothing else fits; ws: / app: in front narrows to one kind
function resolveTarget(query, onlyType) {
  let q = String(query || '').trim();
  let type = onlyType || '';
  const pre = q.match(/^(ws|workspace|app):/i);
  if (pre) { type = /^app/i.test(pre[1]) ? 'app' : 'workspace'; q = q.slice(pre[0].length).trim(); }
  const lc = q.toLowerCase();
  if (!lc) return { error: 'Name an app or workspace.' };
  const pool = targets().filter((t) => !type || t.type === type);
  const label = (t) => (t.type === 'workspace' ? `ws:${t.name}` : t.name);
  const tiers = [(t) => t.name.toLowerCase() === lc, (t) => t.name.toLowerCase().startsWith(lc), (t) => t.name.toLowerCase().includes(lc)];
  for (const test of tiers) {
    const hit = pool.filter(test);
    if (hit.length === 1) return { target: hit[0] };
    if (hit.length > 1) return { error: `"${q}" matches more than one name. Be more specific:`, candidates: hit.map(label) };
  }
  return { error: `No app or workspace matches "${q}".`, candidates: pool.slice(0, 15).map(label) };
}

function serviceState(s, since) {
  const r = rt(s.id);
  const up = r.startedAt ? Date.now() - r.startedAt : 0;
  const running = r.status === 'running';
  // a crash from an earlier run does not count as failure for a start that has only just been requested
  const failed = r.status === 'crashed' && !r.retryAt && (!since || (r.attemptAt || 0) >= since);
  return {
    id: s.id, name: s.name, status: r.status, health: r.health, ports: r.ports, urls: r.urls,
    domainUrl: s.domain && domains && domains.status().running ? domains.urlFor(s.domain) : '',
    ready: running && (r.ports.length > 0 || r.urls.length > 0 || (!s.port && up >= 3000)),
    cpu: r.cpu, memMB: r.mem / 1048576, uptimeSec: Math.round(up / 1000), exitCode: r.exitCode, retrying: !!r.retryAt, failed,
  };
}

function appState(p, since) {
  const services = p.services.map((s) => serviceState(s, since));
  const running = services.filter((x) => x.status === 'running').length;
  const busy = starting.has(p.id) || services.some((x) => x.retrying || x.status === 'installing');
  const state = services.some((x) => x.failed) ? 'failed'
    : services.length && services.every((x) => x.ready) ? 'running'
      : running || busy ? 'starting' : 'stopped';
  return { type: 'app', id: p.id, name: p.name, group: p.group || '', state, services };
}

function targetState(t, since) {
  if (t.type === 'app') return appState(projects.find((p) => p.id === t.id), since);
  const apps = wsProjects(findWorkspace(t.id)).map((p) => appState(p, since));
  const state = apps.some((a) => a.state === 'failed') ? 'failed'
    : apps.length && apps.every((a) => a.state === 'running') ? 'running'
      : apps.some((a) => a.state !== 'stopped') ? 'starting' : 'stopped';
  return { type: 'workspace', id: t.id, name: t.name, state, apps };
}

async function controlRun(b) {
  if (b.action === 'stop' && b.all) { await stopAll(); return { code: 200, body: { ok: true, all: true } }; }
  const r = resolveTarget(b.target);
  if (r.error) return { code: 404, body: r };
  const t = r.target;
  const at = Date.now() - 50;
  if (b.action === 'start') { if (t.type === 'app') startProjectSeq(t.id); else startWorkspace(t.id); }
  else if (b.action === 'stop') { if (t.type === 'app') await stopProject(t.id); else await stopWorkspace(t.id); }
  else if (b.action === 'restart') {
    if (t.type === 'app') await restartProject(t.id);
    else { await stopWorkspace(t.id); await sleep(500); startWorkspace(t.id); }
  } else return { code: 400, body: { error: 'Unknown action.' } };
  return { code: 200, body: { ok: true, type: t.type, id: t.id, name: t.name, at } };
}

function controlLogs(q) {
  const r = resolveTarget(q.get('target'), q.get('type') || '');
  if (r.error) return { code: 404, body: r };
  const t = r.target;
  let svcs = t.type === 'app' ? projects.find((p) => p.id === t.id).services : wsProjects(findWorkspace(t.id)).flatMap((p) => p.services);
  const only = String(q.get('service') || '').toLowerCase();
  if (only) svcs = svcs.filter((s) => s.name.toLowerCase() === only || s.name.toLowerCase().startsWith(only));
  const since = Number(q.get('since')) || 0;
  const n = Math.min(2000, Math.max(1, Number(q.get('n')) || 100));
  let lines = svcs.flatMap((s) => rt(s.id).logs.filter((l) => l.seq > since && !l.mem).map((l) => ({ seq: l.seq, svc: s.name, text: l.text, err: !!l.err })));
  lines.sort((a, b) => a.seq - b.seq);
  if (!since) lines = lines.slice(-n);
  return { code: 200, body: { lines, last: lines.length ? lines[lines.length - 1].seq : since, multi: svcs.length > 1 } };
}

function startControlServer() {
  const token = crypto.randomBytes(24).toString('hex');
  let port = 0;
  controlServer = http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      // only the command-line tool may call: no browser origin, our own address, and the secret token from cli.json
      if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: 'forbidden' });
      const given = Buffer.from(String(req.headers['x-runbay-token'] || ''));
      const want = Buffer.from(token);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(401, { error: 'bad token' });
      const u = new URL(req.url, 'http://127.0.0.1');
      let body = {};
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 65536) return send(413, { error: 'too large' }); }
        try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'bad json' }); }
      }
      if (u.pathname === '/v1/ping') return send(200, { ok: true, version: app.getVersion() });
      if (u.pathname === '/v1/list') {
        return send(200, {
          apps: projects.map((p) => { const a = appState(p); return { name: p.name, id: p.id, group: p.group || '', state: a.state, running: a.services.filter((x) => x.status === 'running').length, total: a.services.length }; }),
          workspaces: workspaces.map((w) => { const t = targetState({ type: 'workspace', id: w.id, name: w.name }); return { name: w.name, id: w.id, state: t.state, running: t.apps.filter((a) => a.state === 'running').length, total: t.apps.length }; }),
        });
      }
      if (u.pathname === '/v1/status') {
        const r = resolveTarget(u.searchParams.get('target'), u.searchParams.get('type') || '');
        if (r.error) return send(404, r);
        return send(200, targetState(r.target, Number(u.searchParams.get('since')) || 0));
      }
      if (u.pathname === '/v1/logs') { const r = controlLogs(u.searchParams); return send(r.code, r.body); }
      if (u.pathname === '/v1/run' && req.method === 'POST') { const r = await controlRun(body); return send(r.code, r.body); }
      if (u.pathname === '/v1/show' && req.method === 'POST') { showWin(); return send(200, { ok: true }); }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: e.message });
    }
  });
  controlServer.listen(0, '127.0.0.1', () => {
    port = controlServer.address().port;
    try { fs.writeFileSync(cliFile(), JSON.stringify({ port, token, pid: process.pid, version: app.getVersion() })); } catch {}
  });
}

function stopControlServer() {
  try {
    const j = JSON.parse(fs.readFileSync(cliFile(), 'utf8'));
    if (j.pid === process.pid) fs.unlinkSync(cliFile());
  } catch {}
}

// the "runbay" command: a small .cmd that runs cli.js with RunBay's own runtime (no Node needed on the PC)
const cliDir = () => process.env.RUNBAY_CLI_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'runbay', 'cli');
const cliShimFile = () => path.join(cliDir(), 'runbay.cmd');
const cliShimText = () => `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${process.execPath}" "${path.join(app.getAppPath(), 'cli.js')}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
const cliBlocked = () => (process.env.PORTABLE_EXECUTABLE_FILE ? 'The portable version cannot install the command. Use the installer version.' : '');

function psPath(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, RB_DIR: cliDir() } }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

async function cliStatus() {
  const installed = fs.existsSync(cliShimFile());
  let onPath = false;
  if (installed && !process.env.RUNBAY_CLI_NOPATH) {
    const p = await psPath("[Environment]::GetEnvironmentVariable('Path','User')");
    onPath = !!p && p.split(';').some((x) => x.replace(/[\\/]+$/, '').toLowerCase() === cliDir().replace(/[\\/]+$/, '').toLowerCase());
  }
  return { installed, onPath, dir: cliDir(), blocked: cliBlocked() };
}

async function cliInstall() {
  if (cliBlocked()) return { ok: false, error: cliBlocked() };
  fs.mkdirSync(cliDir(), { recursive: true });
  fs.writeFileSync(cliShimFile(), cliShimText());
  if (!process.env.RUNBAY_CLI_NOPATH) {
    await psPath("$d=$env:RB_DIR; $p=[Environment]::GetEnvironmentVariable('Path','User'); $parts=@($p -split ';' | Where-Object { $_ }); if (-not ($parts | Where-Object { $_.TrimEnd('\\') -ieq $d.TrimEnd('\\') })) { [Environment]::SetEnvironmentVariable('Path', (($parts + $d) -join ';'), 'User') }");
  }
  return { ok: true, ...(await cliStatus()) };
}

async function cliUninstall() {
  try { fs.unlinkSync(cliShimFile()); } catch {}
  if (!process.env.RUNBAY_CLI_NOPATH) {
    await psPath("$d=$env:RB_DIR; $p=[Environment]::GetEnvironmentVariable('Path','User'); $parts=@($p -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ine $d.TrimEnd('\\')) }); [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')");
  }
  return { ok: true, ...(await cliStatus()) };
}

// RunBay moved or was updated: keep an installed command pointing at the right place
function refreshCliShim() {
  try {
    if (!cliBlocked() && fs.existsSync(cliShimFile()) && fs.readFileSync(cliShimFile(), 'utf8') !== cliShimText()) fs.writeFileSync(cliShimFile(), cliShimText());
  } catch {}
}

ipcMain.handle('cli:status', () => cliStatus());
ipcMain.handle('cli:install', () => cliInstall());
ipcMain.handle('cli:uninstall', () => cliUninstall());

// ---------- "Explain this error" ----------
function aiStoredKey() {
  if (!settings.aiKeyEnc) return '';
  try { return safeStorage.decryptString(Buffer.from(settings.aiKeyEnc, 'base64')); } catch { return ''; }
}
const aiKeySource = () => (aiStoredKey() ? 'saved' : process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? 'environment' : '');

// the error line, the stack under it and a little context, with secrets removed
function aiContext(svcId, seq) {
  const svc = findService(svcId);
  const proj = findProject(svcId);
  const r = runtimes.get(svcId);
  if (!svc || !proj || !r) return null;
  const logs = r.logs;
  let at = logs.findIndex((l) => l.seq === Number(seq));
  if (at < 0) return null;
  while (at > 0 && STACK_RE.test(logs[at].text)) at--; // a stack line was clicked: start at the error above it
  let end = at + 1;
  while (end < logs.length && end - at <= 40 && STACK_RE.test(logs[end].text)) end++;
  end = Math.min(logs.length, end + 3);
  const slice = logs.slice(Math.max(0, at - 15), end).filter((l) => !l.mem);
  const cwd = svc.cwd && fs.existsSync(svc.cwd) ? svc.cwd : '';
  const prof = proj.activeProfile && (proj.profiles || []).find((x) => x.name === proj.activeProfile);
  const secrets = [...Object.values(parseEnv(svc.env)), ...Object.values(parseEnv(prof && prof.vars))];
  if (cwd) {
    for (const f of envtools.listFiles(cwd)) {
      if (f.template) continue;
      try { secrets.push(...envtools.parse(fs.readFileSync(path.join(cwd, f.name), 'utf8')).map((e) => e.value)); } catch {}
    }
  }
  let deps = [];
  if (cwd) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      deps = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 40).map(([k, v]) => `${k}@${v}`);
    } catch {}
  }
  const red = aihelper.makeRedactor(secrets);
  const prompt = aihelper.buildPrompt({
    project: proj.name, service: svc.name, command: red.apply(svc.command), folder: cwd ? path.basename(cwd) : '',
    runtime: (r.runtime || []).map((x) => x.label).join(', '), status: r.status, exitCode: r.exitCode, deps,
    lines: slice.map((l) => ({ text: red.apply(l.text), mark: l.seq === logs[at].seq })),
  });
  return { prompt: red.apply(prompt), redactions: red.count() };
}

ipcMain.handle('ai:status', () => ({ hasKey: !!aiKeySource(), source: aiKeySource(), model: settings.aiModel, models: aihelper.MODELS, canStore: safeStorage.isEncryptionAvailable() }));
ipcMain.handle('ai:set-key', (_e, key) => {
  key = String(key || '').trim();
  if (!key) { settings.aiKeyEnc = ''; saveSettings(); return { ok: true }; }
  if (!/^[\w-]{20,}$/.test(key)) return { ok: false, error: 'That does not look like an Anthropic API key.' };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Windows secure storage is not available, so the key cannot be saved safely.' };
  settings.aiKeyEnc = safeStorage.encryptString(key).toString('base64');
  saveSettings();
  return { ok: true };
});
ipcMain.handle('ai:preview', (_e, svcId, seq) => {
  const c = aiContext(svcId, seq);
  return c ? { ok: true, ...c, model: settings.aiModel, modelName: aihelper.MODELS[settings.aiModel], hasKey: !!aiKeySource() } : { ok: false, error: 'That line is no longer in the log.' };
});
ipcMain.handle('ai:ask', async (_e, svcId, seq) => {
  const c = aiContext(svcId, seq);
  if (!c) return { ok: false, error: 'That line is no longer in the log.' };
  if (!aiKeySource()) return { ok: false, error: 'Add your Anthropic API key first.' };
  return aihelper.ask({ apiKey: aiStoredKey() || undefined, model: settings.aiModel, prompt: c.prompt });
});

// ---------- history / env / database / domains IPC ----------
ipcMain.handle('history:get', (_e, ids) => {
  const out = {};
  for (const id of Array.isArray(ids) ? ids : []) out[id] = events[id] || [];
  return out;
});
ipcMain.handle('history:clear', (_e, ids) => {
  for (const id of Array.isArray(ids) ? ids : []) delete events[id];
  eventsDirty = true;
  saveEvents();
  pushStatus();
});

const svcDir = (svcId) => {
  const s = findService(svcId);
  return s && s.cwd && fs.existsSync(s.cwd) ? s.cwd : null;
};
ipcMain.handle('env:list', (_e, svcId) => {
  const dir = svcDir(svcId);
  return dir ? { dir, files: envtools.listFiles(dir) } : { dir: null, files: [] };
});
ipcMain.handle('env:read', (_e, svcId, name) => {
  try { return envtools.read(svcDir(svcId), name) || { error: 'Not an .env file.' }; } catch (e) { return { error: e.message }; }
});
ipcMain.handle('env:save', (_e, svcId, name, entries) => {
  try { envtools.save(svcDir(svcId), name, entries); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('env:status', (_e, pid) => {
  const out = {};
  const p = projects.find((x) => x.id === pid);
  if (!p) return out;
  const profile = p.activeProfile && (p.profiles || []).find((x) => x.name === p.activeProfile);
  for (const s of p.services) {
    const m = s.cwd && fs.existsSync(s.cwd) ? envtools.missingKeys(s.cwd, [...Object.keys(parseEnv(s.env)), ...Object.keys(parseEnv(profile && profile.vars))]) : null;
    if (m && m.missing.length) out[s.id] = m;
  }
  return out;
});

const dbOf = (svcId) => {
  const s = findService(svcId);
  return s ? dbtools.describe(s) : null;
};
ipcMain.handle('db:info', (_e, svcId) => {
  const info = dbOf(svcId);
  if (!info) return null;
  return { ...info, password: undefined, hasPassword: !!info.password, connection: dbtools.connectionString(info), running: rt(svcId).status === 'running' };
});
ipcMain.handle('db:backup', async (_e, svcId) => {
  const info = dbOf(svcId);
  if (!info) return { ok: false, error: 'Not a database.' };
  if (rt(svcId).status !== 'running') return { ok: false, error: 'Start the database first.' };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const ext = info.kind === 'redis' ? 'rdb' : 'sql';
  const r = await dialog.showSaveDialog(win, { defaultPath: `${info.container || info.kind}-${stamp}.${ext}`, filters: [{ name: 'Backup', extensions: [ext] }] });
  if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
  const res = await dbtools.backup(info, r.filePath);
  return res.ok ? { ...res, file: r.filePath, size: fs.statSync(r.filePath).size } : res;
});
ipcMain.handle('db:restore', async (_e, svcId) => {
  const info = dbOf(svcId);
  if (!info) return { ok: false, error: 'Not a database.' };
  if (rt(svcId).status !== 'running') return { ok: false, error: 'Start the database first.' };
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'SQL backup', extensions: ['sql'] }] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
  return dbtools.restore(info, r.filePaths[0]);
});
ipcMain.handle('db:query', async (_e, svcId, action, args) => {
  const info = dbOf(svcId);
  if (!info) return { ok: false, error: 'Not a database.' };
  if (rt(svcId).status !== 'running') return { ok: false, error: 'Start the database first.' };
  return dbtools.query(info, String(action), args && typeof args === 'object' ? args : {});
});

async function applyDomainsSetting() {
  if (!domains) return { ok: true };
  if (settings.domainsEnabled) {
    const r = await domains.start(settings.httpsPort);
    await domains.refreshStatus();
    return r;
  }
  await domains.stop();
  return { ok: true };
}
ipcMain.handle('domains:status', async () => {
  await domains.refreshStatus();
  return { ...domains.status(), enabled: settings.domainsEnabled, httpsPort: settings.httpsPort, routes: domainRoutes().map((r) => ({ domain: r.domain, label: r.label, running: !!r.port, url: domains.urlFor(r.domain) })) };
});
ipcMain.handle('domains:enable', async (_e, on, port) => {
  settings.domainsEnabled = !!on;
  if (port) settings.httpsPort = Math.min(65535, Math.max(1, Math.round(Number(port)) || 443));
  saveSettings();
  const r = await applyDomainsSetting();
  pushStatus();
  return r;
});
ipcMain.handle('domains:trust', async () => { const r = await domains.trust(); pushStatus(); return r; });
ipcMain.handle('domains:untrust', async () => { const r = await domains.untrust(); pushStatus(); return r; });
ipcMain.handle('domains:hosts', async (_e, remove) => { const r = remove ? await domains.removeHosts() : await domains.applyHosts(); pushStatus(); return r; });

// ---------- workspaces / settings / launcher IPC ----------
ipcMain.handle('workspaces:get', () => workspaces);
ipcMain.handle('workspaces:save', (_e, w) => {
  const name = String((w && w.name) || '').trim();
  if (!name) return workspaces;
  const ids = (Array.isArray(w.projectIds) ? w.projectIds : []).filter((id) => projects.some((p) => p.id === id));
  const id = w.id && findWorkspace(w.id) ? w.id : crypto.randomUUID();
  const rec = { id, name, projectIds: [...new Set(ids)] };
  const i = workspaces.findIndex((x) => x.id === id);
  if (i >= 0) workspaces[i] = rec;
  else workspaces.push(rec);
  saveWorkspaces();
  updateTray();
  return workspaces;
});
ipcMain.handle('workspaces:delete', (_e, id) => {
  workspaces = workspaces.filter((w) => w.id !== id);
  saveWorkspaces();
  updateTray();
  return workspaces;
});
ipcMain.handle('workspace:start', (_e, id) => { startWorkspace(id); });
ipcMain.handle('workspace:stop', (_e, id) => stopWorkspace(id));

ipcMain.handle('settings:get', () => ({ settings: publicSettings(), hotkeyError, packaged: app.isPackaged }));
ipcMain.handle('settings:save', (_e, s) => {
  const prev = settings;
  const next = {
    hotkey: String((s && s.hotkey) || '').trim().slice(0, 60),
    startWithWindows: !!(s && s.startWithWindows),
    startMinimized: !!(s && s.startMinimized),
    editor: String((s && s.editor) || '').trim().slice(0, 300),
    logHistory: !(s && s.logHistory === false),
    alerts: !(s && s.alerts === false),
    cpuLimit: Math.min(100, Math.max(0, Number(s && s.cpuLimit) || 0)),
    memLimitMB: Math.max(0, Math.round(Number(s && s.memLimitMB) || 0)),
    silentMin: Math.max(0, Math.round(Number(s && s.silentMin) || 0)),
    domainsEnabled: prev.domainsEnabled,
    httpsPort: Math.min(65535, Math.max(1, Math.round(Number(s && s.httpsPort) || prev.httpsPort || 443))),
    aiModel: aihelper.MODELS[s && s.aiModel] ? s.aiModel : prev.aiModel || aihelper.DEFAULT_MODEL,
    aiKeyEnc: prev.aiKeyEnc || '',
  };
  settings = next;
  let error = '';
  if (!registerHotkey()) {
    error = hotkeyError;
    settings = { ...next, hotkey: prev.hotkey };
    registerHotkey();
  }
  saveSettings();
  applyLoginItem();
  updateTray();
  const warning = next.startWithWindows && !app.isPackaged ? 'Start with Windows only works in the installed app, not in a development run.' : '';
  return { settings: publicSettings(), error, warning };
});
ipcMain.handle('logs:clear-history', () => {
  pendingLogs.clear();
  let n = 0;
  try {
    for (const f of fs.readdirSync(logsDir())) if (f.endsWith('.jsonl')) { fs.unlinkSync(path.join(logsDir(), f)); n++; }
  } catch {}
  return n;
});

ipcMain.handle('launcher:list', () => [
  ...workspaces.map((w) => {
    const ps = wsProjects(w);
    const n = ps.filter((p) => projRunning(p) > 0).length;
    return { type: 'workspace', id: w.id, name: w.name, sub: `Workspace · ${n}/${ps.length} apps running`, action: workspaceAction(w), running: n > 0, favorite: false };
  }),
  ...projects.map((p) => ({
    type: 'project', id: p.id, name: p.name, group: p.group || '', favorite: !!p.favorite,
    sub: `${projRunning(p)}/${p.services.length} running${p.description ? ' · ' + p.description : ''}`,
    action: projectAction(p), running: projRunning(p) > 0,
  })),
]);
ipcMain.handle('launcher:toggle', async (_e, type, id) => {
  if (launcher && !launcher.isDestroyed()) launcher.hide();
  if (type === 'workspace') {
    const w = findWorkspace(id);
    if (!w) return;
    return workspaceAction(w) === 'stop' ? stopWorkspace(id) : startWorkspace(id);
  }
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  return projectAction(p) === 'stop' ? stopProject(id) : startProjectSeq(id);
});
ipcMain.handle('launcher:show-app', (_e, type, id) => {
  if (launcher && !launcher.isDestroyed()) launcher.hide();
  showWin();
  if (type === 'project') send('select', id);
});
ipcMain.handle('launcher:hide', () => {
  if (launcher && !launcher.isDestroyed()) launcher.hide();
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
  p.services = (p.services || []).map((s) => ({ ...s, id: s.id || crypto.randomUUID(), runtime: /^(auto|off|(node|python|php):[\d.]+)$/.test(s.runtime) ? s.runtime : 'auto', domain: createDomains.cleanDomain(s.domain), dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((x) => typeof x === 'string') : [] }));
  const i = projects.findIndex((x) => x.id === p.id);
  if (i >= 0) projects[i] = p;
  else projects.push(p);
  saveProjects();
  for (const s of p.services) rt(s.id);
  updateTray();
  domainsChanged();
  return projects;
});

ipcMain.handle('projects:delete', async (_e, id) => {
  const p = projects.find((x) => x.id === id);
  if (p) {
    for (const s of p.services) {
      await stopService(s.id);
      runtimes.delete(s.id);
      dropLogFile(s.id);
    }
    projects = projects.filter((x) => x.id !== id);
    saveProjects();
    for (const w of workspaces) w.projectIds = w.projectIds.filter((x) => x !== id);
    saveWorkspaces();
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
  dropLogFile(svcId);
  pushStatus();
});

ipcMain.handle('logs:export', async (_e, items, name, errorsOnly) => {
  const lines = [];
  const isErr = (l) => (l.text.startsWith('[runbay]') ? l.err : STACK_RE.test(l.text) || ERR_RE.test(l.text));
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
      services: p.services.map(({ id: _id, ...s }) => ({
        ...s, env: includeEnv ? s.env : '',
        dependsOn: (s.dependsOn || []).map((d) => (p.services.find((x) => x.id === d) || {}).name).filter(Boolean), // ids change on import, so use names
      })),
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
      domain: createDomains.cleanDomain(s.domain), dependsOn: [], runtime: /^(auto|off|(node|python|php):[\d.]+)$/.test(s.runtime) ? s.runtime : 'auto',
    }));
    (Array.isArray(p.services) ? p.services : []).forEach((s, i) => {
      services[i].dependsOn = (Array.isArray(s.dependsOn) ? s.dependsOn : []).map((n) => (services.find((x) => x.name === n) || {}).id).filter(Boolean);
    });
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
  const taskEnv = versions.applyToEnv({ ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, versions.plan(svc.cwd, svc.runtime || 'auto').chosen);
  const proc = spawn(cmd, [], { cwd: svc.cwd, env: taskEnv, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
ipcMain.handle('project:stop', (_e, id) => stopProject(id));
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
    show: false,
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
  // started by Windows at login with "start minimized": stay in the tray until opened
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWin);
  app.whenReady().then(() => {
    loadProjects();
    loadSettings();
    loadHistory();
    loadEvents();
    domains = createDomains({ dir: path.join(app.getPath('userData'), 'certs'), getRoutes: domainRoutes });
    refreshPath();
    for (const dir of [legacyNgrokDir(), ngrokDir()]) if (fs.existsSync(path.join(dir, 'ngrok.exe'))) process.env.PATH = dir + ';' + process.env.PATH;
    createWindow();
    createTray();
    if (!registerHotkey() && Notification.isSupported()) {
      const n = new Notification({ title: 'RunBay quick launcher is off', body: `${hotkeyError} Pick another shortcut in Settings.` });
      n.on('click', showWin);
      n.show();
    }
    applyLoginItem();
    setInterval(flushLogs, 1000);
    setInterval(saveEvents, 5000);
    setInterval(() => domains.refreshStatus().then(pushStatusSoon), 30000);
    if (settings.domainsEnabled) applyDomainsSetting().then(pushStatusSoon);
    startControlServer();
    refreshCliShim();
    setInterval(sample, SAMPLE_MS);
    setInterval(checkHealth, 4000);
    for (const p of projects) if (p.autoStart) startProjectSeq(p.id);
  });
}

app.on('before-quit', () => {
  quitting = true;
  for (const [id, r] of runtimes) if (r.proc) recordEvent(id, 'stop', 'RunBay closed');
  saveEvents();
  flushLogs();
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

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopControlServer();
});
app.on('window-all-closed', () => app.quit());

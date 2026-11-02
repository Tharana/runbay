const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let projects = [];
let status = {};
const logs = new Map(); // svcId -> [{seq,text,err}]
let selectedId = null;
let logTab = 'all';
let autoscroll = true;
let appInfo = { version: '', changelog: '', canCheckUpdates: false };
let deps = {}; // svcId -> { hasPkg, stale, reason, pm, hasBuild }
let runtimeCatalog = {}; // installed Node / Python / PHP versions, for the editor's drop-down
let envs = {}; // svcId -> { template, missing: [keys] } for services whose .env lacks keys from .env.example
const hist = new Map(); // svcId -> [{cpu, mem}] for the sparklines
const HIST_MAX = 90;
const DB_PORTS = new Set([3306, 5432, 6379, 27017, 1433]); // not web pages: no "open" link
let inspTimer = null;
let inspPort = 4040;
let inspSel = null;
let inspData = [];
let search = '';
let workspaces = []; // [{ id, name, projectIds }]
let levelFilter = 'all'; // all | err | warn | info
let portsTimer = null;
let portRows = [];
let portArm = null; // "port:pid" waiting for a second click to confirm a kill
let portArmTimer = null;
const IDLE_MS = 15 * 60 * 1000;
let filter = '';
const MAX_DOM = 2500;
const COLORS = ['#6f9bff', '#4cd6a1', '#f5b83d', '#e784ff', '#ff8a65', '#5cd0e6'];

const ICONS = {
  play: '<polygon points="6 4 20 12 6 20 6 4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  star: '<polygon points="12 2.5 14.9 9 22 9.6 16.6 14.3 18.2 21.2 12 17.5 5.8 21.2 7.4 14.3 2 9.6 9.1 9"/>',
  ext: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  git: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10"/><path d="M18 11c0 4-6 3-12 6"/>',
  alert: '<path d="M12 3 2 21h20Z"/><path d="M12 10v5M12 18h.01"/>',
  pkg: '<path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  moon: '<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10Z"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  logs: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  note: '<path d="M5 4h14v16H5z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0Z"/><path d="M12 18v4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
const ic = (n) => `<svg class="ic" viewBox="0 0 24 24">${ICONS[n] || ''}</svg>`;
const sel = () => projects.find((p) => p.id === selectedId);
const st = (id) => status[id] || { status: 'stopped', ports: [], urls: [], cpu: 0, mem: 0 };

// ---------- formatting ----------
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m ${String(x).padStart(2, '0')}s` : m ? `${m}m ${String(x).padStart(2, '0')}s` : `${x}s`;
}
function fmtMem(b) {
  if (!b) return '0 MB';
  const mb = b / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(0) + ' MB';
}
const label = { running: 'Running', stopped: 'Stopped', crashed: 'Crashed', installing: 'Installing…' };

function projState(p) {
  const run = p.services.filter((s) => st(s.id).status === 'running').length;
  const busy = p.services.some((s) => st(s.id).status === 'installing');
  const crashed = p.services.some((s) => st(s.id).status === 'crashed');
  return { run, total: p.services.length, state: run ? 'running' : busy ? 'installing' : crashed ? 'crashed' : 'stopped' };
}

// ---------- rendering ----------
function sidebarList() {
  const q = search.trim().toLowerCase();
  const list = projects.filter((p) => !q || [p.name, p.description, p.group].some((x) => String(x || '').toLowerCase().includes(q)));
  const sec = (p) => (p.favorite ? 'Favourites' : p.group || 'Other');
  const rank = (p) => (p.favorite ? 0 : p.group ? 1 : 2);
  return list.sort((x, y) => rank(x) - rank(y) || sec(x).localeCompare(sec(y)) || x.name.localeCompare(y.name)).map((p) => ({ p, sec: sec(p) }));
}

// a workspace is "full" when every service of every app in it is running
function wsState(w) {
  const ps = w.projectIds.map((id) => projects.find((p) => p.id === id)).filter(Boolean).map(projState);
  const full = ps.length > 0 && ps.every((x) => x.total > 0 && x.run === x.total);
  const any = ps.some((x) => x.run > 0);
  return { full, any, apps: ps.length, runningApps: ps.filter((x) => x.run > 0).length, state: full ? 'running' : any ? 'installing' : ps.some((x) => x.state === 'crashed') ? 'crashed' : 'stopped' };
}

function renderWorkspaces() {
  const rows = workspaces.map((w) => {
    const s = wsState(w);
    return `<div class="ws-item" title="${s.apps} app(s)">
      <span class="dot ${s.state}"></span><span class="nmt">${esc(w.name)}</span><span class="dim">${s.runningApps}/${s.apps}</span>
      <button class="btn ghost small icon" data-action="ws-toggle" data-id="${w.id}" title="${s.full ? 'Stop' : 'Run'} every app in this workspace" ${s.apps ? '' : 'disabled'}>${ic(s.full ? 'stop' : 'play')}</button>
      <button class="btn ghost small icon" data-action="ws-edit" data-id="${w.id}" title="Edit workspace">${ic('edit')}</button></div>`;
  }).join('');
  $('#ws-wrap').innerHTML = `<div class="grp ws-head"><span>Workspaces</span><button class="btn ghost small icon" data-action="ws-new" title="New workspace">${ic('plus')}</button></div>
    ${rows || '<div class="dim ws-empty">Group apps into one stack and start it with one click.</div>'}`;
}

function renderSidebar() {
  renderWorkspaces();
  const rows = sidebarList();
  const heads = new Set(rows.map((r) => r.sec));
  let last = null;
  $('#project-list').innerHTML = rows.map(({ p, sec }) => {
    const ps = projState(p);
    const head = heads.size > 1 && sec !== last ? `<div class="grp">${esc(sec)}</div>` : '';
    last = sec;
    return `${head}<div class="proj-item ${p.id === selectedId ? 'active' : ''}" data-action="select" data-id="${p.id}">
      <div class="nm"><span class="dot ${ps.state}"></span><span class="nmt">${esc(p.name)}</span>
        <span class="star ${p.favorite ? 'on' : ''}" data-action="fav" data-id="${p.id}" title="Favourite">${ic('star')}</span></div>
      <div class="sub">${ps.run}/${ps.total} running${p.description ? ' · ' + esc(p.description) : ''}</div></div>`;
  }).join('') || `<div class="dim">${projects.length ? 'No match.' : 'No applications yet.'}</div>`;
  const all = projects.flatMap((p) => p.services);
  const run = all.filter((s) => st(s.id).status === 'running');
  const cpu = run.reduce((a, s) => a + st(s.id).cpu, 0);
  const mem = run.reduce((a, s) => a + st(s.id).mem, 0);
  $('#sidebar-foot').textContent = `${run.length} server(s) running · CPU ${cpu.toFixed(1)}% · ${fmtMem(mem)}`;
  const idle = run.filter((s) => st(s.id).idleSince && Date.now() - st(s.id).idleSince >= IDLE_MS);
  $('#idle-banner').innerHTML = idle.length
    ? `<div class="idle" data-action="free-mem">${ic('moon')}<span>${idle.length} server(s) idle ${IDLE_MS / 60000}+ min (${fmtMem(idle.reduce((a, s) => a + st(s.id).mem, 0))}). Review</span></div>`
    : '';
}

function spark(vals, minMax, color) {
  const w = 96, h = 24;
  const max = Math.max(...vals, minMax);
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`).join(' ');
  return `<svg class="sp" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" style="stroke:${color}" stroke-width="1.5"/></svg>`;
}

function sparkHtml(id, running) {
  const hh = hist.get(id) || [];
  if (!running || hh.length < 2) return '';
  return `<div class="spark"><span class="dim">CPU</span>${spark(hh.map((x) => x.cpu), 10, 'var(--accent)')}
    <span class="dim">Mem</span>${spark(hh.map((x) => x.mem), 1, 'var(--green)')}
    <span class="dim">peak ${fmtMem(Math.max(...hh.map((x) => x.mem)))}</span></div>`;
}

function taskBtns(s, r) {
  const d = deps[s.id];
  let h = '';
  if (/^\s*ngrok(\.exe)?(\s|$)/i.test(s.command || '')) h += `<button class="btn ghost small" data-action="inspect" data-port="${esc(s.port || 4040)}" title="Show requests going through the tunnel">Inspect</button>`;
  if (d && d.hasPkg) {
    h += `<button class="btn ghost small" data-action="task" data-kind="install" data-id="${s.id}" ${r.task ? 'disabled' : ''}>${r.task === 'install' ? 'Installing…' : 'Install'}</button>`;
    if (d.hasBuild) h += `<button class="btn ghost small" data-action="task" data-kind="build" data-id="${s.id}" ${r.task ? 'disabled' : ''}>${r.task === 'build' ? 'Building…' : 'Build'}</button>`;
  }
  return h;
}

function healthBadge(r, running) {
  if (!running) return '';
  if (r.health === 'up') return '<span class="badge up"><i class="pdot"></i>Responding</span>';
  if (r.health === 'down') return '<span class="badge down"><i class="pdot"></i>Not responding</span>';
  return '<span class="badge">Starting…</span>';
}

function alertsHtml(s, r) {
  let h = '';
  if (r.conflictPort && r.status !== 'running') {
    h += `<div class="alert">Port ${r.conflictPort} is already in use. <button class="btn amber small" data-action="free-port" data-port="${r.conflictPort}" data-id="${s.id}">Free port ${r.conflictPort} &amp; run</button></div>`;
  }
  if (r.retryAt) h += '<div class="alert">Crashed - restarting automatically…</div>';
  const d = deps[s.id];
  if (r.task) h += `<div class="alert">${r.task === 'build' ? 'Building' : 'Installing dependencies'}… (see Logs)</div>`;
  else if (d && d.stale) h += `<div class="alert">${ic('pkg')} ${esc(d.reason)}. <button class="btn amber small" data-action="task" data-kind="install" data-id="${s.id}">Install now</button></div>`;
  const e = envs[s.id];
  if (e && e.missing.length) h += `<div class="alert">${ic('file')} ${e.missing.length} variable${e.missing.length > 1 ? 's' : ''} from ${esc(e.template)} ${e.missing.length > 1 ? 'are' : 'is'} not set: <span class="mono">${esc(e.missing.slice(0, 4).join(', '))}${e.missing.length > 4 ? ', ...' : ''}</span> <button class="btn amber small" data-action="env-open" data-id="${s.id}">Open .env editor</button></div>`;
  for (const m of r.runtimeMissing || []) h += `<div class="alert">${ic('alert')} ${esc(m.text)} is required by ${esc(m.source)} but is not installed, so the system version is used. To fix: <span class="mono">${esc(m.hint)}</span>, then restart.</div>`;
  if (r.domain && r.domainIssue) {
    const why = { proxy: 'local HTTPS is switched off', trust: 'the certificate is not trusted yet', hosts: 'the hosts file has no entry for it yet' }[r.domainIssue];
    h += `<div class="alert">${ic('lock')} <span class="mono">${esc(r.domain)}</span> will not open yet: ${why}. <button class="btn amber small" data-action="domains-open">Set up</button></div>`;
  }
  return h;
}

function extraBadges(r, s) {
  let h = '';
  if (r.status === 'running') for (const v of r.runtime || []) h += `<span class="badge" title="${esc(v.source)}${v.manager ? ' · ' + esc(v.manager) : ''}">${esc(v.label)}</span>`;
  if (r.alert) h += `<span class="badge installing" title="A resource alert was raised - see the logs">${{ cpu: 'High CPU', mem: 'High memory', silent: 'No output' }[r.alert]}</span>`;
  if (r.crashes24 >= 3) h += `<span class="badge crashed" data-action="history-open" style="cursor:pointer" title="Crashed ${r.crashes24} times in the last 24 hours. Click for the timeline.">Flaky · ${r.crashes24} crashes</span>`;
  return h;
}

function domainLink(r) {
  return r.domainUrl && r.status === 'running' ? `<span class="link ng" data-action="url" data-url="${esc(r.domainUrl)}" title="${esc(r.domainUrl)}">${ic('lock')} ${esc(r.domain)} ${ic('ext')}</span>` : '';
}

// the address a developer most likely wants: first web port, else the first tunnel
function primaryUrl(r) {
  if (r.status !== 'running') return '';
  if (r.domainUrl) return r.domainUrl;
  const port = r.ports.find((x) => !DB_PORTS.has(x));
  return port ? `http://localhost:${port}` : r.urls[0] || '';
}

function cardHtml(s, idx) {
  const r = st(s.id);
  const running = r.status === 'running';
  const busy = r.status === 'installing';
  const ports = (r.ports.length ? r.ports : []).map((p) => (DB_PORTS.has(p) ? `<span class="dim" title="Database / queue port">localhost:${p}</span>` : `<span class="link" data-action="url" data-url="http://localhost:${p}">:${p} ${ic('ext')}</span>`)).join('');
  const urls = r.urls.map((u) => `<span class="link ng" data-action="url" data-url="${esc(u)}" title="${esc(u)}">${esc(u.replace('https://', ''))} ${ic('ext')}</span>`).join('');
  const cfg = !running && s.port ? `<span class="dim">Port ${esc(s.port)}</span>` : '';
  return `<div class="card ${r.status}" data-svc="${s.id}">
    <div class="card-h"><span class="dot ${r.status}"></span><b>${esc(s.name)}</b><span class="badge ${r.status}">${label[r.status]}</span>${healthBadge(r, running)}${extraBadges(r, s)}${r.errors ? `<span class="badge down" title="Error lines in the logs">${ic('alert')} ${r.errors} error${r.errors > 1 ? 's' : ''}</span>` : ''}</div>
    ${alertsHtml(s, r)}
    <div class="cmd mono" title="${esc(s.command)}">${esc(s.command || '(no command)')}</div>
    <div class="path mono" data-action="path" data-path="${esc(s.cwd)}" title="Open folder">${esc(s.cwd || '(no folder)')}</div>
    <div class="metrics">
      <div class="metric"><span>Uptime</span><b data-uptime="${r.startedAt || ''}">${running ? fmtUptime(Date.now() - r.startedAt) : '-'}</b></div>
      <div class="metric"><span>CPU</span><b>${running ? r.cpu.toFixed(1) + '%' : '-'}</b></div>
      <div class="metric"><span>Memory</span><b>${running ? fmtMem(r.mem) : '-'}</b></div>
      <div class="metric"><span>PID</span><b>${running ? r.pid : '-'}</b></div>
    </div>
    ${sparkHtml(s.id, running)}
    <div class="links">${domainLink(r)}${ports}${urls}${cfg}${running && !ports && !urls ? '<span class="dim">no listening port yet</span>' : ''}</div>
    <div class="card-btns">
      ${busy ? `<button class="btn small" disabled>Installing…</button>` : running
        ? `<button class="btn red small" data-action="svc-stop" data-id="${s.id}">${ic('stop')}Stop</button>`
        : `<button class="btn green small" data-action="svc-start" data-id="${s.id}">${ic('play')}Run</button>`}
      <button class="btn amber small" data-action="svc-restart" data-id="${s.id}">${ic('restart')}Restart</button>
      <span class="spacer"></span>
      ${taskBtns(s, r)}
      ${primaryUrl(r) ? `<button class="btn ghost small" data-action="url" data-url="${esc(primaryUrl(r))}" title="Open ${esc(primaryUrl(r))} in the browser">${ic('globe')}</button>
      <button class="btn ghost small" data-action="copy-svc-url" data-url="${esc(primaryUrl(r))}" title="Copy ${esc(primaryUrl(r))}">${ic('copy')}</button>` : ''}
      <button class="btn ghost small" data-action="path" data-path="${esc(s.cwd)}" title="Open folder in File Explorer" ${s.cwd ? '' : 'disabled'}>${ic('folder')}</button>
      <button class="btn ghost small" data-action="vscode" data-path="${esc(s.cwd)}" title="Open in editor" ${s.cwd ? '' : 'disabled'}>${ic('code')}</button>
      <button class="btn ghost small" data-action="terminal" data-path="${esc(s.cwd)}" title="Open terminal here" ${s.cwd ? '' : 'disabled'}>${ic('terminal')}</button>
      ${r.dbKind ? `<button class="btn ghost small" data-action="db-open" data-id="${s.id}" title="Database tools: connection string, backup, tables">${ic('db')}</button>` : ''}
      <button class="btn ghost small" data-action="env-open" data-id="${s.id}" title="Edit .env files" ${s.cwd ? '' : 'disabled'}>${ic('file')}</button>
      <button class="btn ghost small" data-action="log-tab" data-tab="${s.id}" title="Show logs">${ic('logs')}</button>
    </div></div>`;
}

// every reachable URL of an app (localhost ports + ngrok tunnels), for quick checking
function urlBarHtml(p) {
  const rows = [];
  for (const s of p.services) {
    const r = st(s.id);
    if (r.status !== 'running') continue;
    const urls = [...(r.domainUrl ? [r.domainUrl] : []), ...r.ports.filter((x) => !DB_PORTS.has(x)).map((x) => `http://localhost:${x}`), ...r.urls];
    for (const u of urls) {
      rows.push(`<div class="urlrow"><span class="dim">${esc(s.name)}</span>
        <span class="link ${u.includes('ngrok') ? 'ng' : ''}" data-action="url" data-url="${esc(u)}">${esc(u.replace(/^https?:\/\//, ''))} ${ic('ext')}</span>
        <button class="btn ghost small" data-action="copy-url" data-url="${esc(u)}">Copy</button>
        <button class="btn ghost small" data-action="qr" data-url="${esc(u)}">QR</button>
        ${u.includes('ngrok') ? `<button class="btn ghost small" data-action="webhook" data-url="${esc(u)}">Webhook</button>` : ''}</div>`);
    }
  }
  return rows.length ? `<div class="dim">URLs to check:</div>${rows.join('')}` : '<div class="dim">Run the app to get its URLs to check.</div>';
}

function renderMain() {
  const p = sel();
  const main = $('#main');
  if (!p) {
    main.innerHTML = `<div class="empty"><div class="logo"><svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7Z"/></svg></div>
      <h2>Welcome to RunBay</h2>
      <p>Add an application (backend, frontend, ngrok, databases…) and run all of it with one button.</p>
      <button class="btn primary" data-action="new-from-folder">${ic('folder')}Add from folder</button></div>`;
    return;
  }
  const ps = projState(p);
  const run = p.services.filter((s) => st(s.id).status === 'running');
  const cpu = run.reduce((a, s) => a + st(s.id).cpu, 0);
  const mem = run.reduce((a, s) => a + st(s.id).mem, 0);
  main.innerHTML = `
    <div class="head">
      <div class="info">
        <h1><span class="dot ${ps.state}"></span>${esc(p.name)} <span class="badge ${ps.state}">${ps.run}/${ps.total} running</span></h1>
        ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
        ${p.notes ? `<div class="note">${ic('note')}<span>${esc(p.notes)}</span></div>` : ''}
        <div class="totals">Total CPU ${cpu.toFixed(1)}% · Memory ${fmtMem(mem)}</div>
        <div class="urlbar" id="urlbar">${urlBarHtml(p)}</div>
        <div class="profbar" id="profbar">${profbarHtml(p, '')}</div>
        <div class="gitbar" id="gitbar"></div>
      </div>
      <div class="actions">
        <button class="btn green" data-action="proj-start" ${ps.run === ps.total ? 'disabled' : ''}>${ic('play')}Run all</button>
        <button class="btn red" data-action="proj-stop" ${ps.run === 0 ? 'disabled' : ''}>${ic('stop')}Stop all</button>
        <button class="btn amber" data-action="proj-restart">${ic('restart')}Restart</button>
        <button class="btn" data-action="history-open" title="Crashes, restarts and downtime">${ic('clock')}History</button>
        <span class="sep"></span>
        <button class="btn icon" data-action="edit-project" title="Edit">${ic('edit')}</button>
        <button class="btn icon" data-action="delete-project" title="Delete">${ic('trash')}</button>
      </div>
    </div>
    <div class="cards" id="cards">${p.services.map(cardHtml).join('') || '<div class="dim">No services. Click Edit to add one.</div>'}</div>
    <div class="logs">
      <div class="log-bar" id="log-bar"></div>
      <div class="log-body" id="log-body"></div>
    </div>`;
  renderLogBar();
  renderLogBody();
  loadGit();
  loadDeps();
}

function refreshLive() {
  // status updates: refresh sidebar + cards without rebuilding logs
  renderSidebar();
  const p = sel();
  if (!p) return;
  const cards = $('#cards');
  if (!cards) return renderMain();
  cards.innerHTML = p.services.map(cardHtml).join('') || '<div class="dim">No services. Click Edit to add one.</div>';
  const ps = projState(p);
  const run = p.services.filter((s) => st(s.id).status === 'running');
  $('.head h1').innerHTML = `<span class="dot ${ps.state}"></span>${esc(p.name)} <span class="badge ${ps.state}">${ps.run}/${ps.total} running</span>`;
  $('.totals').textContent = `Total CPU ${run.reduce((a, s) => a + st(s.id).cpu, 0).toFixed(1)}% · Memory ${fmtMem(run.reduce((a, s) => a + st(s.id).mem, 0))}`;
  $('#urlbar').innerHTML = urlBarHtml(p);
  const et = $('#err-total');
  if (et) et.textContent = p.services.reduce((n, s) => n + (st(s.id).errors || 0), 0) || '';
  p.services.forEach((s) => {
    const el = document.querySelector(`[data-errs="${s.id}"]`);
    if (el) el.textContent = st(s.id).errors || '';
  });
  $('[data-action="proj-start"]').disabled = ps.run === ps.total;
  $('[data-action="proj-stop"]').disabled = ps.run === 0;
}

// ---------- profiles / git ----------
function profbarHtml(p, note) {
  if (!(p.profiles || []).length) return '';
  return `<span class="dim">Env profile:</span>
    <select id="prof-select"><option value="">(none)</option>${p.profiles.map((x) => `<option ${x.name === p.activeProfile ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    ${note ? `<span class="dim">${esc(note)}</span>` : ''}`;
}

function gitbarHtml(list) {
  return list.map((g) => `<div class="gitrow">
    <span title="${esc(g.root)}">${ic('git')} <b>${esc(g.branch)}</b></span><span class="dim">${esc(g.name)}</span>
    <span class="${g.changed ? 'gdirty' : 'gclean'}">${g.changed ? g.changed + ' uncommitted change' + (g.changed > 1 ? 's' : '') : 'clean'}</span>
    ${g.ahead ? `<span class="dim">↑${g.ahead} ahead</span>` : ''}${g.behind ? `<span class="gdirty">↓${g.behind} behind</span>` : ''}
    <button class="btn ghost small" data-action="git-pull" data-root="${esc(g.root)}" ${g.upstream ? '' : 'disabled title="No upstream branch"'}>Pull</button></div>`).join('');
}

async function loadDeps() {
  const p = sel();
  if (!p) return;
  const id = p.id;
  const d = await api.depsStatus(id);
  if (selectedId !== id) return;
  deps = d;
  try { envs = await api.envStatus(id); } catch { envs = {}; }
  if (selectedId !== id) return;
  if ($('#cards')) refreshLive();
}

async function loadGit() {
  const p = sel();
  if (!p || !$('#gitbar')) return;
  const id = p.id;
  const g = await api.gitStatus(id);
  const el = $('#gitbar');
  if (selectedId === id && el) el.innerHTML = gitbarHtml(g);
}

// ---------- ngrok request inspector ----------
function prettyBody(s) {
  const t = (s || '').trim();
  if (!t) return '';
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return s; }
}

function inspRows() {
  return inspData.map((q) => `<div class="rq ${q.id === inspSel ? 'on' : ''}" data-action="rq-pick" data-id="${esc(q.id)}">
    <b class="m">${esc(q.method)}</b><span class="u" title="${esc(q.uri)}">${esc(q.uri)}</span>
    <span class="st ${q.status >= 400 ? 'bad' : 'ok'}">${q.status ?? '…'}</span><span class="dim">${q.ms}ms</span></div>`).join('');
}

function inspDetail() {
  const q = inspData.find((x) => x.id === inspSel);
  if (!q) return '<div class="dim">Select a request.</div>';
  const blk = (t, v) => (v ? `<h4>${t}</h4><pre class="mono pre">${esc(v)}</pre>` : '');
  return blk('Request', q.reqHead) + blk('Request body', prettyBody(q.reqBody)) + blk('Response', q.resHead) + blk('Response body', prettyBody(q.resBody));
}

function inspPaint() {
  const list = $('#insp-list');
  if (!list) return;
  const sc = list.scrollTop;
  list.innerHTML = inspData.length ? inspRows() : '<div class="dim pad">No requests yet. Send one to your ngrok URL.</div>';
  list.scrollTop = sc;
  $('#insp-detail').innerHTML = inspDetail();
}

async function inspRefresh() {
  if (!$('#insp')) { clearInterval(inspTimer); return; }
  const res = await api.ngrokRequests(inspPort);
  if (!$('#insp')) return;
  if (!res.ok) {
    $('#insp-list').innerHTML = `<div class="dim pad">Can't reach ngrok at localhost:${inspPort}. Is the ngrok service running?</div>`;
    return;
  }
  const changed = JSON.stringify(res.requests.map((q) => q.id + q.status)) !== JSON.stringify(inspData.map((q) => q.id + q.status));
  inspData = res.requests;
  if (!inspSel && inspData[0]) inspSel = inspData[0].id;
  if (changed) inspPaint();
}

function openInspector(port) {
  inspPort = Number(port) || 4040;
  inspSel = null;
  inspData = [];
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal wide">
    <h2>Request inspector <span class="dim">ngrok · localhost:${inspPort}</span></h2>
    <div class="insp" id="insp"><div id="insp-list" class="insp-list"></div><div id="insp-detail" class="insp-detail"></div></div>
    <div class="foot"><button class="btn" data-action="insp-clear">Clear list</button><span class="spacer"></span>
    <button class="btn" data-action="modal-close">Close</button></div></div></div>`;
  inspPaint();
  inspRefresh();
  inspTimer = setInterval(inspRefresh, 2000);
}

// ---------- webhook helper ----------
const WEBHOOKS = [
  { n: 'Stripe', p: '/api/webhooks/stripe' },
  { n: 'Dodo Payments', p: '/api/webhook/dodo-payments' },
  { n: 'GitHub', p: '/api/webhooks/github' },
];

function whUpdate() {
  const m = $('#wh-modal');
  if (!m) return;
  let p = $('#wh-path').value.trim();
  if (p && !p.startsWith('/')) p = '/' + p;
  $('#wh-full').textContent = m.dataset.base + p;
  try { localStorage.setItem('runbay.wh.' + selectedId, p); } catch {}
}

async function whCopy(msg) {
  await navigator.clipboard.writeText($('#wh-full').textContent);
  $('#wh-msg').textContent = msg || 'Copied to clipboard.';
}

function openWebhook(url) {
  let base = url;
  try { base = new URL(url).origin; } catch {}
  let saved = '';
  try { saved = localStorage.getItem('runbay.wh.' + selectedId) || ''; } catch {}
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal small" id="wh-modal" data-base="${esc(base)}">
    <h2>Webhook URL</h2><div class="body">
      <div class="dim">Click a provider to copy its URL. The paths are common defaults - edit the path to match your route.</div>
      <div class="chips">${WEBHOOKS.map((w) => `<button class="btn small" data-action="wh-pick" data-path="${esc(w.p)}">${esc(w.n)}</button>`).join('')}</div>
      <label class="f">Path<input type="text" id="wh-path" class="mono" value="${esc(saved || WEBHOOKS[0].p)}"></label>
      <div class="mono" id="wh-full"></div><div class="dim" id="wh-msg"></div>
    </div>
    <div class="foot"><button class="btn" data-action="modal-close">Close</button><button class="btn primary" data-action="wh-copy">Copy URL</button></div></div></div>`;
  whUpdate();
}

// ---------- about ----------
function parseChangelog(md) {
  const out = [];
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##\s+\[?([\d.]+)\]?\s*(?:-\s*(.+))?$/);
    if (h) { cur = { v: h[1], date: h[2] || '', items: [] }; out.push(cur); continue; }
    const b = line.match(/^\s*[-*]\s+(.*)/);
    if (b && cur) cur.items.push(b[1].replace(/[`*]/g, ''));
  }
  return out;
}

function openAbout() {
  const hist = parseChangelog(appInfo.changelog).map((r, i) => `<div class="rel">
    <div class="relh"><b>v${esc(r.v)}</b>${i === 0 ? '<span class="badge up">Current</span>' : ''}<span class="dim">${esc(r.date)}</span></div>
    <ul>${r.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('');
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal">
    <div class="about-top">
      <div class="logo"><svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7Z"/></svg></div>
      <div><h3>RunBay <span class="dim">v${esc(appInfo.version)}</span></h3>
        <div class="dim">Free and open source (MIT license)</div>
        <div class="credit">Made by <span class="link" data-action="url" data-url="https://webcrab.lk">WebCrab.lk ${ic('ext')}</span></div></div>
      <span class="spacer"></span>
      ${appInfo.canCheckUpdates ? '<button class="btn" data-action="check-update">Check for updates</button>' : ''}
    </div>
    <div id="upd-msg" class="upd"></div>
    <div class="body"><b>Version history</b>${hist || '<div class="dim">No history found.</div>'}</div>
    <div class="foot"><span class="dim">Free to use, share and modify.</span><span class="spacer"></span>
    <button class="btn primary" data-action="modal-close">Close</button></div></div></div>`;
}

// ---------- memory / idle ----------
function openMemModal() {
  const list = projects
    .flatMap((p) => p.services.filter((s) => st(s.id).status === 'running').map((s) => ({ p, s, r: st(s.id) })))
    .sort((x, y) => y.r.mem - x.r.mem);
  const rows = list.map(({ p, s, r }) => {
    const idle = r.idleSince ? Date.now() - r.idleSince : 0;
    return `<label class="memrow"><input type="checkbox" class="mem-pick" data-id="${s.id}" ${idle >= IDLE_MS ? 'checked' : ''}>
      <span><b>${esc(p.name)}</b> › ${esc(s.name)}</span>
      <span class="dim">${fmtMem(r.mem)} · ${idle >= 60000 ? 'idle ' + fmtUptime(idle) : 'active'}</span></label>`;
  }).join('');
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal small">
    <h2>Free up memory</h2>
    <div class="body">${rows ? '<div class="dim">Tick the servers to stop (idle ones are pre-selected).</div>' + rows : '<div class="dim">Nothing is running.</div>'}</div>
    <div class="foot"><button class="btn" data-action="modal-close">Cancel</button>
    ${rows ? '<button class="btn red" id="mem-ok">Stop selected</button>' : ''}</div></div></div>`;
  const ok = $('#mem-ok');
  if (ok) ok.onclick = async () => {
    const ids = [...document.querySelectorAll('.mem-pick:checked')].map((x) => x.dataset.id);
    closeModal();
    await Promise.all(ids.map((id) => api.stopService(id)));
  };
}

function infoModal(title, text) {
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal small">
    <h2>${esc(title)}</h2><div class="body"><pre class="mono pre">${esc(text)}</pre></div>
    <div class="foot"><button class="btn primary" data-action="modal-close">OK</button></div></div></div>`;
}

// ---------- logs ----------
function renderLogBar() {
  const p = sel();
  if (!p) return;
  if (logTab !== 'all' && logTab !== 'errors' && !p.services.some((s) => s.id === logTab)) logTab = 'all';
  const errTotal = p.services.reduce((n, s) => n + (st(s.id).errors || 0), 0);
  const isErr = logTab === 'errors';
  $('#log-bar').innerHTML = `
    <span class="tab ${logTab === 'all' ? 'active' : ''}" data-action="log-tab" data-tab="all">All</span>
    <span class="tab ${isErr ? 'active' : ''}" data-action="log-tab" data-tab="errors">${ic('alert')}Errors <span class="ebadge" id="err-total">${errTotal || ''}</span></span>
    ${p.services.map((s) => `<span class="tab ${logTab === s.id ? 'active' : ''}" data-action="log-tab" data-tab="${s.id}"><span class="dot ${st(s.id).status}"></span> ${esc(s.name)} <span class="ebadge" data-errs="${s.id}">${st(s.id).errors || ''}</span></span>`).join('')}
    <span class="spacer"></span>
    <select id="log-level" title="Show only one kind of line" ${isErr ? 'disabled' : ''}>
      ${[['all', 'All levels'], ['err', 'Errors'], ['warn', 'Warnings'], ['info', 'Info']].map(([v, n]) => `<option value="${v}" ${levelFilter === v ? 'selected' : ''}>${n}</option>`).join('')}
    </select>
    <input type="text" id="log-filter" placeholder="Filter logs…" value="${esc(filter)}">
    <label class="dim"><input type="checkbox" id="autoscroll" ${autoscroll ? 'checked' : ''}> Auto-scroll</label>
    <button class="btn small" data-action="log-copy" title="Copies the selected text, or everything shown">${isErr ? 'Copy errors' : 'Copy'}</button>
    <button class="btn small" data-action="log-export">Export</button>
    ${isErr ? '' : '<button class="btn small" data-action="log-clear">Clear</button>'}`;
}

const ERR_RE = /\b\w*(?:error|exception)\b|\b(?:failed|fatal|EADDRINUSE)\b/i;
const WARN_RE = /\bwarn(ing)?\b/i;
// lines of a stack trace (JS, Python, Java, PHP, Go); keep in sync with main.js
const STACK_RE = /^\s+at\s+\S|^\s*File ".+", line \d+|^Traceback \(most recent call last\)|^\s*Caused by:|^\s+\.\.\. \d+ more|^\s*#\d+\s+\S.*\(\d+\)|^\s+\S+\.go:\d+/;
// a file path, optionally followed by :line:col, ", line N" (Python) or (N) (PHP)
const PATH_RE = /(?:(?<![\w:/\\@.~-])|(?<=file:\/\/\/))((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\w@.-]+[\\/])[^\s:()'"<>|*?]*?\.[A-Za-z]\w{0,7})(?![\w/\\]|\.\w)(?::(\d+))?(?::(\d+))?(?:["']?,\s*line\s+(\d+)|\((\d+)\))?/g;

// cls = how the line looks, level = which filter it belongs to
function lineInfo(l) {
  if (l._i) return l._i;
  const t = l.text;
  let i;
  if (t.startsWith('[runbay]')) i = l.err ? { cls: 'err', level: 'err' } : { cls: 'sys', level: 'info' };
  else if (STACK_RE.test(t)) i = { cls: 'stack', level: 'err' };
  else if (ERR_RE.test(t)) i = { cls: 'err', level: 'err' };
  else if (WARN_RE.test(t)) i = { cls: 'warn', level: 'warn' };
  else i = { cls: '', level: 'info' };
  l._i = i;
  return i;
}

// the line, with file paths turned into links that open the editor
function linkify(el, text, svcId) {
  let last = 0;
  for (const m of text.matchAll(PATH_RE)) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('span');
    a.className = 'fl';
    a.dataset.action = 'open-file';
    a.dataset.svc = svcId;
    a.dataset.file = m[1];
    a.dataset.line = m[2] || m[4] || m[5] || '';
    a.dataset.col = m[2] ? m[3] || '' : '';
    a.title = 'Open in editor';
    a.textContent = m[0];
    el.appendChild(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

function lineEl(svc, l, idx, showTag) {
  const d = document.createElement('div');
  d.className = 'ln ' + lineInfo(l).cls;
  if (logTab === 'errors' && lineInfo(l).cls === 'err') {
    d.classList.add('askable');
    d.dataset.action = 'ai-explain';
    d.dataset.svc = svc.id;
    d.dataset.seq = l.seq;
    d.title = 'Click to have Claude explain this error';
  }
  d.dataset.seq = l.seq;
  if (showTag) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.style.color = COLORS[idx % COLORS.length];
    t.textContent = svc.name;
    d.appendChild(t);
  }
  linkify(d, l.text, svc.id);
  return d;
}

// does a line pass the active tab, level and text filters?
function passes(l) {
  const lv = lineInfo(l).level;
  if (logTab === 'errors' && lv !== 'err') return false;
  if (levelFilter !== 'all' && lv !== levelFilter) return false;
  return !filter || l.text.toLowerCase().includes(filter.toLowerCase());
}

function renderLogBody() {
  const p = sel();
  const body = $('#log-body');
  if (!p || !body) return;
  const list = [];
  p.services.forEach((s, i) => {
    if (logTab === 'all' || logTab === 'errors' || logTab === s.id) (logs.get(s.id) || []).forEach((l) => list.push({ s, i, l }));
  });
  list.sort((a, b) => a.l.seq - b.l.seq);
  const shown = list.filter((x) => passes(x.l)).slice(-MAX_DOM);
  body.textContent = '';
  if (!shown.length) {
    body.innerHTML = '<div class="log-empty">No logs yet. Press Run to start.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  shown.forEach((x) => frag.appendChild(lineEl(x.s, x.l, x.i, logTab === 'all' || logTab === 'errors')));
  body.appendChild(frag);
  if (autoscroll) body.scrollTop = body.scrollHeight;
}

function appendLog(svcId, line) {
  if (!logs.has(svcId)) logs.set(svcId, []);
  const arr = logs.get(svcId);
  arr.push(line);
  if (arr.length > 5000) arr.shift();
  const p = sel();
  const body = $('#log-body');
  if (!p || !body) return;
  const i = p.services.findIndex((s) => s.id === svcId);
  if (i < 0 || (logTab !== 'all' && logTab !== 'errors' && logTab !== svcId)) return;
  if (!passes(line)) return;
  if (body.querySelector('.log-empty')) body.textContent = '';
  body.appendChild(lineEl(p.services[i], line, i, logTab === 'all' || logTab === 'errors'));
  while (body.childElementCount > MAX_DOM) body.removeChild(body.firstChild);
  if (autoscroll) body.scrollTop = body.scrollHeight;
}

async function loadAllLogs() {
  for (const p of projects) for (const s of p.services) logs.set(s.id, await api.getLogs(s.id));
}

// ---------- modals ----------
const PRESETS = {
  next: { name: 'Frontend (Next.js)', command: 'npm run dev', port: '3000' },
  php: { name: 'Backend (PHP)', command: 'php -S localhost:8000', port: '8000' },
  ngrok: { name: 'ngrok', command: 'ngrok http 3000 --log=stdout', port: '' },
  custom: { name: 'New service', command: '', port: '' },
  python: { name: 'Backend (Python)', command: 'python manage.py runserver 8000', port: '8000' },
  go: { name: 'Backend (Go)', command: 'go run .', port: '8080' },
  dotnet: { name: 'Backend (.NET)', command: 'dotnet run', port: '5000' },
  spring: { name: 'Backend (Spring Boot)', command: 'mvn spring-boot:run', port: '8080' },
  compose: { name: 'Docker Compose', command: 'docker compose up', port: '', stopCommand: 'docker compose down' },
  redis: { name: 'Redis', command: 'docker run --rm --name runbay-redis -p 6379:6379 redis', port: '6379', stopCommand: 'docker stop runbay-redis' },
  postgres: { name: 'PostgreSQL', command: 'docker run --rm --name runbay-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres', port: '5432', stopCommand: 'docker stop runbay-postgres' },
  mysql: { name: 'MySQL', command: 'docker run --rm --name runbay-mysql -e MYSQL_ROOT_PASSWORD=root -p 3306:3306 mysql', port: '3306', stopCommand: 'docker stop runbay-mysql' },
  phpmyadmin: { name: 'phpMyAdmin', command: 'docker run --rm --name runbay-phpmyadmin -e PMA_HOST=host.docker.internal -p 8081:80 phpmyadmin', port: '8081', stopCommand: 'docker stop runbay-phpmyadmin' },
  prisma: { name: 'Prisma Studio', command: 'npx prisma studio --port 5555', port: '5555' },
};

function runtimeOptions(cur) {
  const o = [['auto', 'Automatic - follow .nvmrc, .node-version, .python-version ...'], ['off', "Don't change - use the versions installed system-wide"]];
  for (const [lang, name] of [['node', 'Node'], ['python', 'Python'], ['php', 'PHP']]) for (const v of runtimeCatalog[lang] || []) o.push([`${lang}:${v.version}`, `Always ${name} ${v.version} (${v.manager})`]);
  if (!o.some((x) => x[0] === cur)) o.push([cur, `${cur.replace(':', ' ')} (not installed)`]);
  return o.map(([v, n]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

function svcEditHtml(s) {
  const sid = s.id || crypto.randomUUID();
  return `<div class="svc-edit" data-sid="${esc(sid)}" data-deps="${esc(JSON.stringify(s.dependsOn || []))}">
    <div class="top">
      <label class="f">Name<input type="text" class="s-name" value="${esc(s.name)}"></label>
      <label class="f" style="max-width:110px">Port<input type="text" class="s-port" value="${esc(s.port)}" placeholder="3000"></label>
      <button class="btn small" data-action="rm-svc">Remove</button>
    </div>
    <div class="opts">
      <label class="chk"><input type="checkbox" class="s-restart" ${s.autoRestart ? 'checked' : ''}> Auto-restart on crash</label>
      <label class="f inline">Max retries<input type="number" min="1" class="s-retries" value="${esc(s.maxRetries || 3)}"></label>
      <label class="f inline">Wait after ready (s)<input type="number" min="0" class="s-delay" value="${esc(s.delay || 0)}"></label>
    </div>
    <div class="deps-box chips"></div>
    <label class="f">Language versions<select class="s-runtime" style="width:100%">${runtimeOptions(s.runtime || 'auto')}</select></label>
    <div class="rt-note"></div>
    <label class="f">Local domain (optional)<input type="text" class="s-domain mono" value="${esc(s.domain || '')}" placeholder="myshop.test"></label>
    <label class="f">Command<input type="text" class="s-cmd mono" value="${esc(s.command)}" placeholder="npm run dev"></label>
    <label class="f">Stop command (optional, e.g. docker stop name)<input type="text" class="s-stop mono" value="${esc(s.stopCommand)}"></label>
    <label class="f">Folder path
      <div class="pathrow"><input type="text" class="s-cwd mono" value="${esc(s.cwd)}" placeholder="C:\\projects\\my-app">
      <button class="btn small" data-action="browse">Browse…</button></div></label>
    <label class="f">Environment variables (KEY=value per line, optional)<textarea class="s-env mono" rows="2">${esc(s.env)}</textarea></label>
  </div>`;
}

function profEditHtml(pr) {
  return `<div class="prof-edit">
    <div class="top"><label class="f">Profile name<input type="text" class="p-name" value="${esc(pr.name)}" placeholder="dev"></label>
      <button class="btn small" data-action="rm-prof">Remove</button></div>
    <label class="f">Variables (KEY=value per line)<textarea class="p-vars mono" rows="3">${esc(pr.vars)}</textarea></label></div>`;
}

function openProjectModal(p, prefill) {
  const isNew = !p;
  p = p || prefill || { name: '', description: '', notes: '', services: [{ ...PRESETS.next }] };
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal">
    <h2>${isNew ? 'Add application' : 'Edit application'}</h2>
    <div class="body">
      <div class="detect-box">
        <button class="btn primary" data-action="detect">${ic('folder')}Select app folder &amp; auto-detect servers</button>
        <span class="dim" id="detect-msg">Picks the frontend, backend and ngrok, with their commands and ports.</span>
      </div>
      <div class="row">
        <label class="f">Application name<input type="text" id="m-name" value="${esc(p.name)}" placeholder="My Shop"></label>
        <label class="f">Short description<input type="text" id="m-desc" value="${esc(p.description)}" placeholder="Next.js frontend + PHP API"></label>
      </div>
      <label class="f">Group / tag (optional)<input type="text" id="m-group" value="${esc(p.group)}" placeholder="Clients, Personal, Work…"></label>
      <label class="chk"><input type="checkbox" id="m-auto" ${p.autoStart ? 'checked' : ''}> Start this app automatically when RunBay opens</label>
      <label class="f">Notes<textarea id="m-notes" rows="2" placeholder="Anything to remember…">${esc(p.notes)}</textarea></label>
      <div class="presets"><b>Env profiles</b><span class="dim">applied on top of each service's variables</span><span class="spacer"></span>
        <button class="btn small" data-action="add-prof">+ Profile</button></div>
      <div id="m-profiles" style="display:flex;flex-direction:column;gap:10px">${(p.profiles || []).map(profEditHtml).join('')}</div>
      <div class="presets"><b>Services</b><span class="spacer"></span>
        <span class="dim">Add:</span>
        <button class="btn small" data-action="add-svc" data-preset="next">Next.js</button>
        <button class="btn small" data-action="add-svc" data-preset="php">PHP</button>
        <button class="btn small" data-action="add-svc" data-preset="ngrok">ngrok</button>
        <button class="btn small" data-action="add-svc" data-preset="custom">Custom</button>
        <select id="preset-more"><option value="">More…</option>
          <optgroup label="Languages"><option value="python">Python</option><option value="go">Go</option><option value="dotnet">.NET</option><option value="spring">Spring Boot</option></optgroup>
          <optgroup label="Databases &amp; tools (Docker)"><option value="compose">Docker Compose</option><option value="redis">Redis</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="phpmyadmin">phpMyAdmin</option><option value="prisma">Prisma Studio</option></optgroup>
        </select>
      </div>
      <div id="m-services" style="display:flex;flex-direction:column;gap:10px">${p.services.map(svcEditHtml).join('')}</div>
      <div class="presets"><b>Start order</b><span class="dim">who waits for whom</span></div>
      <div id="dep-graph" style="display:flex;flex-direction:column;gap:8px"></div>
    </div>
    <div class="foot">
      <span id="m-err" style="color:var(--red);flex:1;text-align:left"></span>
      <button class="btn" data-action="modal-close">Cancel</button>
      <button class="btn primary" data-action="modal-save" data-id="${p.id || ''}">Save</button>
    </div></div></div>`;
  refreshDeps();
  $('#m-name').focus();
}

function confirmModal(msg, okLabel, onOk) {
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal small">
    <h2>Confirm</h2><div class="body">${esc(msg)}</div>
    <div class="foot"><button class="btn" data-action="modal-close">Cancel</button>
    <button class="btn red" id="confirm-ok">${esc(okLabel)}</button></div></div></div>`;
  $('#confirm-ok').onclick = () => { closeModal(); onOk(); };
}
const closeModal = () => {
  clearInterval(inspTimer);
  clearInterval(portsTimer);
  $('#modal-root').innerHTML = '';
};

// ---------- workspaces ----------
function openWorkspaceModal(w) {
  const isNew = !w;
  w = w || { name: '', projectIds: [] };
  const rows = projects.map((p) => `<label class="memrow"><input type="checkbox" class="ws-pick" data-id="${p.id}" ${w.projectIds.includes(p.id) ? 'checked' : ''}>
    <span><b>${esc(p.name)}</b></span><span class="dim">${p.services.length} service(s)${p.group ? ' · ' + esc(p.group) : ''}</span></label>`).join('');
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal small">
    <h2>${isNew ? 'New workspace' : 'Edit workspace'}</h2>
    <div class="body">
      <div class="dim">A workspace starts or stops several apps together, for example everything for one client.</div>
      <label class="f">Name<input type="text" id="ws-name" value="${esc(w.name)}" placeholder="Client X stack"></label>
      <div class="dim">Apps in this workspace:</div>
      ${rows || '<div class="dim">Add an app first.</div>'}
    </div>
    <div class="foot">${isNew ? '' : `<button class="btn red" data-action="ws-delete" data-id="${w.id}">Delete</button>`}<span class="spacer"></span>
      <button class="btn" data-action="modal-close">Cancel</button>
      <button class="btn primary" data-action="ws-save" data-id="${w.id || ''}">Save</button></div></div></div>`;
  $('#ws-name').focus();
}

// ---------- settings ----------
let settingsDraft = null;

// turn a key press into an Electron accelerator such as Ctrl+Alt+R
function accelFromEvent(e) {
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  let key = '';
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else key = { Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=' }[e.code] || '';
  return key && mods.length ? [...mods, key].join('+') : '';
}

async function openSettings() {
  const { settings: s, hotkeyError, packaged } = await api.getSettings();
  settingsDraft = s;
  setTimeout(() => { if (typeof settingsExtras === 'function') settingsExtras(); }, 0);
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal small">
    <h2>Settings</h2>
    <div class="body">
      <label class="f">Quick launcher shortcut
        <div class="pathrow"><input type="text" id="set-hotkey" class="mono" readonly value="${esc(s.hotkey)}" placeholder="Click here, then press the keys">
        <button class="btn small" data-action="set-hotkey-clear">Clear</button></div></label>
      <div class="dim">Press it anywhere in Windows to search your apps and start or stop them. Needs Ctrl, Alt, Shift or Win plus a key.</div>
      ${hotkeyError ? `<div class="alert">${esc(hotkeyError)}</div>` : ''}
      <label class="chk"><input type="checkbox" id="set-login" ${s.startWithWindows ? 'checked' : ''}> Start RunBay when Windows starts</label>
      <label class="chk" style="margin-left:22px"><input type="checkbox" id="set-min" ${s.startMinimized ? 'checked' : ''}> ...and keep it minimized in the tray</label>
      <div class="dim">${packaged ? 'Apps with "Start automatically" turned on will then be running as soon as you sign in.' : 'Start with Windows only works in the installed app.'}</div>
      <label class="f">Code editor command
        <input type="text" id="set-editor" class="mono" value="${esc(s.editor)}" placeholder="code"></label>
      <div class="dim">Used by the editor button and by clickable file paths in the logs. Examples: <span class="mono">code</span>, <span class="mono">cursor</span>, <span class="mono">windsurf</span>, or a full path to an .exe.</div>
      <label class="chk"><input type="checkbox" id="set-hist" ${s.logHistory ? 'checked' : ''}> Keep log history between sessions</label>
      <div class="dim">Saves the latest lines of every service to disk and shows them again after a restart.
        <span class="link" data-action="clear-history">Clear saved history</span></div>
      <label class="chk"><input type="checkbox" id="set-alerts" ${s.alerts ? 'checked' : ''}> Resource alerts</label>
      <div class="row">
        <label class="f">CPU above (%)<input type="number" id="set-cpu" min="0" max="100" value="${esc(s.cpuLimit)}"></label>
        <label class="f">Memory above (MB)<input type="number" id="set-mem" min="0" value="${esc(s.memLimitMB)}"></label>
        <label class="f">No output for (min)<input type="number" id="set-silent" min="0" value="${esc(s.silentMin)}"></label>
      </div>
      <div class="dim">Notifies you once when a service stays above these limits (CPU for 30 seconds), or says nothing for too long. 0 turns a limit off. "No output" suits servers that normally log a lot.</div>
      <b>Explain this error (Claude)</b>
      <div id="ai-box" class="dim">Loading…</div>
      <b>Command line</b>
      <div id="cli-box" class="dim">Loading…</div>
      <div class="dim" id="set-msg"></div>
    </div>
    <div class="foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn primary" data-action="settings-save">Save</button></div></div></div>`;
}

// ---------- port map ----------
function portRowsHtml() {
  const q = ($('#port-q') ? $('#port-q').value : '').trim().toLowerCase();
  const mode = $('#port-mode') ? $('#port-mode').value : 'all';
  const rows = portRows.filter((r) => {
    if (mode === 'runbay' && !r.svcId) return false;
    if (mode === 'conflict' && !r.needs.length) return false;
    return !q || [r.port, r.pid, r.name, r.cmd, r.svcLabel, r.needs.join(' ')].join(' ').toLowerCase().includes(q);
  });
  if (!rows.length) return '<tr><td colspan="5" class="dim pad">Nothing matches.</td></tr>';
  return rows.map((r) => {
    const key = `${r.port}:${r.pid}`;
    const armed = portArm === key;
    const owner = r.svcId ? `<span class="badge running">RunBay</span> ${esc(r.svcLabel)}`
      : r.needs.length ? `<span class="badge installing">Conflict</span> <span class="dim">blocks ${esc(r.needs.join(', '))}</span>` : '<span class="dim">-</span>';
    const btn = r.protected ? '<span class="dim">system</span>'
      : `<button class="btn small ${armed ? 'red' : 'ghost'}" data-action="port-kill" data-port="${r.port}" data-pid="${r.pid}">${armed ? 'Click again to confirm' : r.svcId ? 'Stop service' : 'Kill'}</button>`;
    return `<tr class="${r.needs.length ? 'warnrow' : ''}">
      <td class="mono"><b>${r.port}</b></td>
      <td class="dim" title="${esc(r.addresses.join(', '))}">${r.localOnly ? 'localhost only' : 'all interfaces'}</td>
      <td><span title="${esc(r.cmd)}">${esc(r.name)}</span> <span class="dim">PID ${r.pid}</span></td>
      <td>${owner}</td><td class="ar">${btn}</td></tr>`;
  }).join('');
}

async function refreshPorts() {
  if (!$('#ports-body')) { clearInterval(portsTimer); return; }
  portRows = await api.listPorts();
  const body = $('#ports-body');
  if (!body) return;
  body.innerHTML = portRowsHtml();
  const c = portRows.filter((r) => r.needs.length).length;
  $('#ports-sub').textContent = `${portRows.length} listening port(s)${c ? ` · ${c} blocking one of your apps` : ''}`;
}

function openPorts() {
  portRows = [];
  portArm = null;
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal wide">
    <h2>Port map <span class="dim" id="ports-sub">scanning…</span></h2>
    <div class="body">
      <div class="row" style="align-items:center">
        <input type="text" id="port-q" placeholder="Filter by port, process or app…">
        <select id="port-mode"><option value="all">All ports</option><option value="runbay">Started by RunBay</option><option value="conflict">Blocking my apps</option></select>
      </div>
      <div class="ptab-wrap"><table class="ptab"><thead><tr><th>Port</th><th>Reachable from</th><th>Process</th><th>RunBay</th><th></th></tr></thead>
      <tbody id="ports-body"><tr><td colspan="5" class="dim pad">Scanning…</td></tr></tbody></table></div>
      <div class="dim">Shows every program listening on this PC, including ones RunBay did not start. Killing a process stops it immediately.</div>
    </div>
    <div class="foot"><button class="btn" data-action="ports-refresh">Refresh</button><span class="spacer"></span><button class="btn primary" data-action="modal-close">Close</button></div></div></div>`;
  refreshPorts();
  portsTimer = setInterval(refreshPorts, 4000);
}

async function saveModal(id) {
  const name = $('#m-name').value.trim();
  if (!name) { $('#m-name').focus(); return; }
  const old = projects.find((p) => p.id === id);
  const services = [...document.querySelectorAll('.svc-edit')].map((el) => ({
    id: el.dataset.sid || undefined,
    name: $('.s-name', el).value.trim() || 'Service',
    port: $('.s-port', el).value.trim(),
    command: $('.s-cmd', el).value.trim(),
    cwd: $('.s-cwd', el).value.trim(),
    stopCommand: $('.s-stop', el).value.trim(),
    env: $('.s-env', el).value,
    autoRestart: $('.s-restart', el).checked,
    maxRetries: Number($('.s-retries', el).value) || 3,
    delay: Number($('.s-delay', el).value) || 0,
    domain: $('.s-domain', el).value.trim().toLowerCase(),
    runtime: $('.s-runtime', el).value || 'auto',
    dependsOn: JSON.parse(el.dataset.deps || '[]'),
  }));
  const bad = services.find((s) => s.domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.(test|localhost|internal)$/.test(s.domain));
  const taken = services.find((s, i) => s.domain && services.findIndex((x) => x.domain === s.domain) !== i)
    || services.find((s) => s.domain && projects.some((q) => q.id !== id && q.services.some((x) => x.domain === s.domain)));
  const err = $('#m-err');
  if (bad || taken) {
    err.textContent = bad ? `"${bad.domain}" is not allowed. Use a name ending in .test, .localhost or .internal, for example myshop.test.` : `The domain ${taken.domain} is already used by another service.`;
    return;
  }
  err.textContent = '';
  // services removed while running should be stopped
  if (old) for (const s of old.services) if (!services.some((x) => x.id === s.id)) await api.stopService(s.id);
  const profiles = [...document.querySelectorAll('.prof-edit')]
    .map((el) => ({ name: $('.p-name', el).value.trim(), vars: $('.p-vars', el).value }))
    .filter((x) => x.name);
  projects = await api.saveProject({
    id: id || undefined, name, description: $('#m-desc').value.trim(), notes: $('#m-notes').value,
    autoStart: $('#m-auto').checked, group: $('#m-group').value.trim(), favorite: !!(old && old.favorite),
    profiles, activeProfile: old && profiles.some((x) => x.name === old.activeProfile) ? old.activeProfile : '', services,
  });
  if (!id) selectedId = projects[projects.length - 1].id;
  status = await api.getStatus();
  await loadAllLogs();
  closeModal();
  renderSidebar();
  renderMain();
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const a = t.dataset.action;
  const p = sel();
  switch (a) {
    case 'new-project': return openProjectModal(null);
    case 'new-from-folder': {
      const dir = await api.pickFolder();
      if (!dir) return;
      const d = await api.detectFolder(dir);
      return openProjectModal(null, d.services.length ? d : null);
    }
    case 'detect': {
      const dir = await api.pickFolder();
      if (!dir) return;
      const d = await api.detectFolder(dir);
      if (!d.services.length) { $('#detect-msg').textContent = 'No runnable project found in that folder.'; return; }
      $('#m-name').value = d.name;
      $('#m-desc').value = d.description;
      $('#m-notes').value = $('#m-notes').value || `Folder: ${dir}`;
      $('#m-services').innerHTML = d.services.map(svcEditHtml).join('');
      refreshDeps();
      $('#detect-msg').textContent = `Found ${d.services.length} server(s) - review and press Save.`;
      return;
    }
    case 'edit-project': return openProjectModal(p);
    case 'delete-project':
      return confirmModal(`Delete "${p.name}"? Its running servers will be stopped. (Your project files are not touched.)`, 'Delete', async () => {
        projects = await api.deleteProject(p.id);
        workspaces = await api.getWorkspaces();
        selectedId = projects[0]?.id || null;
        renderSidebar(); renderMain();
      });
    case 'select': selectedId = t.dataset.id; logTab = 'all'; renderSidebar(); return renderMain();
    case 'proj-start': return api.startProject(p.id);
    case 'proj-stop': return api.stopProject(p.id);
    case 'proj-restart': return api.restartProject(p.id);
    case 'svc-start': return api.startService(t.dataset.id);
    case 'svc-stop': return api.stopService(t.dataset.id);
    case 'svc-restart': return api.restartService(t.dataset.id);
    case 'url': return api.openUrl(t.dataset.url);
    case 'vscode': return api.openVscode(t.dataset.path);
    case 'terminal': return api.openTerminal(t.dataset.path);
    case 'free-port': {
      const port = t.dataset.port;
      const o = await api.portOwner(port);
      if (!o) return api.startService(t.dataset.id);
      return confirmModal(`Port ${port} is used by ${o.name} (PID ${o.pid}). Kill it and start this service?`, 'Kill & run', async () => {
        await api.freePort(port);
        api.startService(t.dataset.id);
      });
    }
    case 'qr': {
      const q = await api.makeQr(t.dataset.url);
      if (!q) return;
      $('#modal-root').innerHTML = `<div class="overlay"><div class="modal small qr">
        <h2>Scan to open on your phone</h2>
        <div class="body"><img src="${q.dataUrl}" width="280" height="280" alt="QR code">
        <div class="mono">${esc(q.url)}</div>
        ${q.local ? '<div class="dim">Local network address: phone must be on the same Wi-Fi and the server must listen on all interfaces (0.0.0.0). Use the ngrok URL to work from anywhere.</div>' : ''}</div>
        <div class="foot"><button class="btn" data-action="modal-close">Close</button></div></div></div>`;
      return;
    }
    case 'copy-url': {
      await navigator.clipboard.writeText(t.dataset.url);
      t.textContent = 'Copied';
      return;
    }
    case 'path': return t.dataset.path && api.openPath(t.dataset.path);
    case 'copy-svc-url': {
      await navigator.clipboard.writeText(t.dataset.url);
      const old = t.innerHTML;
      t.innerHTML = ic('check');
      setTimeout(() => { if (t.isConnected) t.innerHTML = old; }, 1200);
      return;
    }
    case 'open-file': {
      if (window.getSelection().toString()) return; // the user is selecting text, not clicking a link
      const r = await api.openFile(t.dataset.svc, t.dataset.file, t.dataset.line, t.dataset.col);
      if (r && r.error) {
        t.classList.add('missing');
        t.title = r.error;
      }
      return;
    }
    case 'ws-new': return openWorkspaceModal(null);
    case 'ws-edit': return openWorkspaceModal(workspaces.find((x) => x.id === t.dataset.id));
    case 'ws-toggle': {
      const w = workspaces.find((x) => x.id === t.dataset.id);
      return w && (wsState(w).full ? api.stopWorkspace(w.id) : api.startWorkspace(w.id));
    }
    case 'ws-save': {
      const name = $('#ws-name').value.trim();
      if (!name) { $('#ws-name').focus(); return; }
      workspaces = await api.saveWorkspace({
        id: t.dataset.id || undefined, name,
        projectIds: [...document.querySelectorAll('.ws-pick:checked')].map((x) => x.dataset.id),
      });
      closeModal();
      return renderSidebar();
    }
    case 'ws-delete':
      return confirmModal('Delete this workspace? Your apps are not touched.', 'Delete', async () => {
        workspaces = await api.deleteWorkspace(t.dataset.id);
        renderSidebar();
      });
    case 'settings': return openSettings();
    case 'set-hotkey-clear': $('#set-hotkey').value = ''; return;
    case 'clear-history': {
      const n = await api.clearLogHistory();
      $('#set-msg').textContent = n ? `Removed saved history of ${n} service(s).` : 'No saved history found.';
      return;
    }
    case 'settings-save': {
      const res = await api.saveSettings({
        hotkey: $('#set-hotkey').value.trim(),
        startWithWindows: $('#set-login').checked,
        startMinimized: $('#set-min').checked,
        editor: $('#set-editor').value.trim(),
        logHistory: $('#set-hist').checked,
        alerts: $('#set-alerts').checked,
        cpuLimit: $('#set-cpu').value,
        memLimitMB: $('#set-mem').value,
        silentMin: $('#set-silent').value,
        aiModel: $('#set-ai-model') ? $('#set-ai-model').value : undefined,
      });
      if (res.error || res.warning) {
        $('#set-msg').textContent = [res.error && `Shortcut not changed: ${res.error}`, res.warning, 'Other settings were saved.'].filter(Boolean).join(' ');
        $('#set-hotkey').value = res.settings.hotkey;
        return;
      }
      return closeModal();
    }
    case 'ports': return openPorts();
    case 'ports-refresh': return refreshPorts();
    case 'port-kill': {
      const key = `${t.dataset.port}:${t.dataset.pid}`;
      if (portArm !== key) {
        // first click arms the button, a second click within a few seconds does it
        portArm = key;
        clearTimeout(portArmTimer);
        portArmTimer = setTimeout(() => { portArm = null; if ($('#ports-body')) $('#ports-body').innerHTML = portRowsHtml(); }, 4000);
        $('#ports-body').innerHTML = portRowsHtml();
        return;
      }
      portArm = null;
      clearTimeout(portArmTimer);
      const res = await api.killPort(t.dataset.port, t.dataset.pid);
      if (res && res.error) $('#ports-sub').textContent = res.error;
      else await refreshPorts();
      return;
    }
    case 'log-tab': logTab = t.dataset.tab; renderLogBar(); return renderLogBody();
    case 'log-clear': {
      const ids = logTab === 'all' ? p.services.map((s) => s.id) : [logTab];
      for (const id of ids) { await api.clearLogs(id); logs.set(id, []); }
      return renderLogBody();
    }
    case 'fav': {
      const pr = projects.find((x) => x.id === t.dataset.id);
      projects = await api.saveProject({ ...pr, favorite: !pr.favorite });
      return renderSidebar();
    }
    case 'stop-all':
      return confirmModal('Stop every running server in all apps?', 'Stop everything', () => api.stopAll());
    case 'free-mem': return openMemModal();
    case 'add-prof': return $('#m-profiles').insertAdjacentHTML('beforeend', profEditHtml({ name: '', vars: '' }));
    case 'rm-prof': return t.closest('.prof-edit').remove();
    case 'git-pull': {
      t.disabled = true;
      t.textContent = 'Pulling…';
      const res = await api.gitPull(p.id, t.dataset.root);
      infoModal(res.ok ? 'Pull finished' : 'Pull failed', res.text);
      return loadGit();
    }
    case 'log-copy': {
      const picked = window.getSelection().toString();
      const text = picked || [...document.querySelectorAll('#log-body .ln')].map((x) => x.textContent).join('\n');
      if (!text) return;
      await navigator.clipboard.writeText(text);
      const old = t.textContent;
      t.textContent = 'Copied ✓';
      setTimeout(() => { t.textContent = old; }, 1500);
      return;
    }
    case 'log-export': {
      const items = (logTab === 'all' || logTab === 'errors' ? p.services : p.services.filter((s) => s.id === logTab)).map((s) => ({ id: s.id, name: s.name }));
      const file = await api.exportLogs(items, p.name, logTab === 'errors');
      if (file) { t.textContent = 'Saved ✓'; setTimeout(() => { t.textContent = 'Export'; }, 2000); }
      return;
    }
    case 'inspect': return openInspector(t.dataset.port);
    case 'insp-clear': await api.ngrokClear(inspPort); inspData = []; inspSel = null; return inspPaint();
    case 'rq-pick': inspSel = t.dataset.id; return inspPaint();
    case 'webhook': return openWebhook(t.dataset.url);
    case 'wh-pick': $('#wh-path').value = t.dataset.path; whUpdate(); return whCopy();
    case 'wh-copy': return whCopy();
    case 'task': return api.runTask(t.dataset.id, t.dataset.kind);
    case 'export-cfg':
      $('#modal-root').innerHTML = `<div class="overlay"><div class="modal small"><h2>Export apps</h2><div class="body">
        <div class="dim">Saves all apps (services, commands, folders, profiles) to a JSON file you can back up or send to a teammate.</div>
        <label class="chk"><input type="checkbox" id="ex-env"> Include environment variables (may contain secrets)</label></div>
        <div class="foot"><button class="btn" data-action="modal-close">Cancel</button><button class="btn primary" id="ex-ok">Export…</button></div></div></div>`;
      $('#ex-ok').onclick = async () => {
        const inc = $('#ex-env').checked;
        closeModal();
        const file = await api.exportConfig(inc);
        if (file) infoModal('Exported', file);
      };
      return;
    case 'import-cfg':
      return confirmModal('Import apps from a RunBay export? Imported apps are added to your list and never start by themselves. Only import files you trust - their commands run on this PC when you press Run.', 'Choose file…', async () => {
        const r = await api.importConfig();
        if (!r) return;
        if (r.error) return infoModal('Import failed', r.error);
        projects = r.projects;
        status = await api.getStatus();
        await loadAllLogs();
        selectedId = projects[projects.length - 1].id;
        renderSidebar();
        renderMain();
        infoModal('Imported', `${r.count} app(s) added. Folder paths come from the other machine - use Edit to fix them if needed.`);
      });
    case 'about': return openAbout();
    case 'check-update': {
      const box = $('#upd-msg');
      box.textContent = 'Checking…';
      const r = await api.checkUpdate();
      if (r.error) box.textContent = r.error;
      else if (r.newer) {
        box.innerHTML = `<b>Version ${esc(r.latest)} is available</b> (you have ${esc(r.current)}). ${esc(r.notes)}
          ${r.url ? `<button class="btn primary small" data-action="url" data-url="${esc(r.url)}">Download</button>` : ''}`;
      } else box.textContent = `You are up to date (v${r.current}).`;
      return;
    }
    case 'modal-close': return closeModal();
    case 'modal-save': return saveModal(t.dataset.id);
    case 'add-svc': {
      const pr = PRESETS[t.dataset.preset];
      $('#m-services').insertAdjacentHTML('beforeend', svcEditHtml({ ...pr, cwd: '', env: '' }));
      refreshDeps();
      return;
    }
    case 'rm-svc': t.closest('.svc-edit').remove(); return refreshDeps();
    case 'browse': {
      const dir = await api.pickFolder();
      if (dir) { $('.s-cwd', t.closest('.svc-edit')).value = dir; refreshRuntimeNotes(); }
      return;
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'log-filter') { filter = e.target.value; renderLogBody(); }
  if (e.target.id === 'wh-path') whUpdate();
  if (e.target.id === 'proj-search') { search = e.target.value; renderSidebar(); }
  if (e.target.id === 'port-q' && $('#ports-body')) $('#ports-body').innerHTML = portRowsHtml();
});
// record the shortcut by pressing it instead of typing it
document.addEventListener('keydown', (e) => {
  if (e.target.id !== 'set-hotkey') return;
  if (e.key === 'Tab') return;
  e.preventDefault();
  e.stopPropagation();
  if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey) e.target.value = '';
  else {
    const accel = accelFromEvent(e);
    if (accel) e.target.value = accel;
  }
}, true);
document.addEventListener('change', async (e) => {
  if (e.target.id === 'preset-more' && e.target.value) {
    $('#m-services').insertAdjacentHTML('beforeend', svcEditHtml({ ...PRESETS[e.target.value], cwd: '', env: '' }));
    e.target.value = '';
    refreshDeps();
  }
  if (e.target.id === 'log-level') { levelFilter = e.target.value; renderLogBody(); }
  if (e.target.id === 'port-mode' && $('#ports-body')) $('#ports-body').innerHTML = portRowsHtml();
  if (e.target.id === 'prof-select') {
    projects = await api.setProfile(selectedId, e.target.value);
    const p = sel();
    const running = p.services.some((s) => st(s.id).status === 'running');
    $('#profbar').innerHTML = profbarHtml(p, running ? 'Restart the app to apply.' : '');
  }
  if (e.target.id === 'autoscroll') {
    autoscroll = e.target.checked;
    if (autoscroll) { const b = $('#log-body'); b.scrollTop = b.scrollHeight; }
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

setInterval(loadGit, 15000);
setInterval(loadDeps, 15000);

// tick uptime every second without rebuilding the cards
setInterval(() => {
  document.querySelectorAll('[data-uptime]').forEach((el) => {
    const t = Number(el.dataset.uptime);
    if (t) el.textContent = fmtUptime(Date.now() - t);
  });
}, 1000);

api.onLog(({ svcId, line }) => appendLog(svcId, line));
// the quick launcher asked to show an app
api.onSelect((id) => {
  if (!projects.some((p) => p.id === id)) return;
  selectedId = id;
  logTab = 'all';
  renderSidebar();
  renderMain();
});
let taskKey = '';
api.onStatus((s) => {
  status = s;
  for (const [id, v] of Object.entries(s)) {
    if (v.status !== 'running') { hist.delete(id); continue; }
    const hh = hist.get(id) || [];
    hh.push({ cpu: v.cpu, mem: v.mem });
    if (hh.length > HIST_MAX) hh.shift();
    hist.set(id, hh);
  }
  refreshLive();
  // an install/build just ended: re-check whether dependencies are still stale
  const key = Object.entries(s).map(([k, v]) => k + (v.task || '')).join();
  if (key !== taskKey) { taskKey = key; loadDeps(); }
});

(async function init() {
  projects = await api.getProjects();
  workspaces = await api.getWorkspaces();
  try { runtimeCatalog = await api.runtimeList(); } catch {}
  status = await api.getStatus();
  await loadAllLogs();
  selectedId = projects[0]?.id || null;
  renderSidebar();
  renderMain();
  appInfo = await api.appInfo();
  $('#about-link').textContent = `RunBay v${appInfo.version} · by WebCrab.lk`;
})();

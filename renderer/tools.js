// RunBay tools: start-order graph, crash / health history, .env editor, database tools and local domains.
// Loaded after app.js and shares its helpers ($, esc, ic, api, projects, status, closeModal, ...).

Object.assign(ICONS, {
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
});

const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};
const fmtWhen = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const toast = (el, text, ms = 1600) => {
  const old = el.innerHTML;
  el.innerHTML = text;
  setTimeout(() => { if (el.isConnected) el.innerHTML = old; }, ms);
};

// =====================================================================================
// Start-order graph (project editor)
// =====================================================================================
function depNodes() {
  return [...document.querySelectorAll('.svc-edit')].map((el) => ({
    el, id: el.dataset.sid, name: $('.s-name', el).value.trim() || 'Service', deps: JSON.parse(el.dataset.deps || '[]'),
  }));
}

function depLevels(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const level = new Map();
  const visiting = new Set();
  let cycle = false;
  const calc = (n) => {
    if (level.has(n.id)) return level.get(n.id);
    if (visiting.has(n.id)) { cycle = true; return 0; }
    visiting.add(n.id);
    let m = 0;
    for (const d of n.deps) if (byId.has(d)) m = Math.max(m, calc(byId.get(d)) + 1);
    visiting.delete(n.id);
    level.set(n.id, m);
    return m;
  };
  nodes.forEach(calc);
  return { level, cycle };
}

function depGraphSvg(nodes, level) {
  const W = 150, H = 30, GX = 70, GY = 14;
  const cols = new Map();
  for (const n of nodes) {
    const l = level.get(n.id) || 0;
    if (!cols.has(l)) cols.set(l, []);
    cols.get(l).push(n);
  }
  const pos = new Map();
  let rows = 0;
  for (const [l, list] of cols) {
    list.forEach((n, i) => pos.set(n.id, { x: l * (W + GX), y: i * (H + GY) }));
    rows = Math.max(rows, list.length);
  }
  const width = cols.size * (W + GX) - GX;
  const height = rows * (H + GY) - GY;
  const edges = nodes.flatMap((n) => n.deps.filter((d) => pos.has(d)).map((d) => {
    const a = pos.get(d), b = pos.get(n.id);
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    return `<path d="M${x1} ${y1} C${x1 + 32} ${y1} ${x2 - 32} ${y2} ${x2} ${y2}" class="dg-edge" marker-end="url(#dg-arrow)"/>`;
  })).join('');
  const boxes = nodes.map((n) => {
    const p = pos.get(n.id);
    const label = n.name.length > 20 ? n.name.slice(0, 19) + '…' : n.name;
    return `<g transform="translate(${p.x} ${p.y})"><rect width="${W}" height="${H}" rx="8" class="dg-node ${n.deps.length ? '' : 'root'}"/><text x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle" class="dg-text">${esc(label)}</text></g>`;
  }).join('');
  return `<svg class="dg" viewBox="-4 -4 ${width + 8} ${height + 8}" width="${width + 8}" height="${height + 8}">
    <defs><marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="dg-head"/></marker></defs>${edges}${boxes}</svg>`;
}

function refreshDeps() {
  const nodes = depNodes();
  for (const n of nodes) {
    const box = $('.deps-box', n.el);
    if (!box) continue;
    const others = nodes.filter((o) => o.id !== n.id);
    n.deps = n.deps.filter((d) => others.some((o) => o.id === d)); // services that were removed
    n.el.dataset.deps = JSON.stringify(n.deps);
    box.innerHTML = others.length
      ? `<span class="dim">Waits for:</span>${others.map((o) => `<label class="chip"><input type="checkbox" class="dep-pick" data-dep="${esc(o.id)}" ${n.deps.includes(o.id) ? 'checked' : ''}>${esc(o.name)}</label>`).join('')}`
      : '';
  }
  const g = $('#dep-graph');
  if (!g) return;
  if (!nodes.some((n) => n.deps.length)) {
    g.innerHTML = `<div class="dim">No "waits for" set: services start top to bottom, each one waiting for the previous. Tick "Waits for" on a service to build your own order.</div>`;
    return;
  }
  const { level, cycle } = depLevels(nodes);
  g.innerHTML = (cycle ? '<div class="alert">These services wait for each other in a circle. RunBay will ignore the arrows and start them top to bottom until you break the circle.</div>' : '')
    + `<div class="dg-wrap">${depGraphSvg(nodes, level)}</div>
    <div class="dim">An arrow means "wait until this is listening". Services without an incoming arrow start immediately, side by side.</div>`;
}

document.addEventListener('change', (e) => {
  if (!e.target.classList || !e.target.classList.contains('dep-pick')) return;
  const el = e.target.closest('.svc-edit');
  const set = new Set(JSON.parse(el.dataset.deps || '[]'));
  if (e.target.checked) set.add(e.target.dataset.dep);
  else set.delete(e.target.dataset.dep);
  el.dataset.deps = JSON.stringify([...set]);
  refreshDeps();
});
document.addEventListener('input', (e) => {
  if (e.target.classList && e.target.classList.contains('s-name')) refreshDeps();
});

// =====================================================================================
// Crash and health history
// =====================================================================================
const TL_STATE = { start: 'running', restart: 'running', up: 'running', down: 'unhealthy', crash: 'crashed', stop: 'stopped' };
const TL_LABEL = { running: 'Running', unhealthy: 'Not responding', crashed: 'Crashed', stopped: 'Stopped', unknown: 'No data' };
const EV_LABEL = { start: 'Started', restart: 'Restarted automatically', stop: 'Stopped', crash: 'Crashed', down: 'Stopped responding', up: 'Responding again', alert: 'Resource alert' };
let histRange = 24 * 3600 * 1000;
let histData = {};

function timeline(events, from, to) {
  const evs = events.filter((e) => TL_STATE[e.type]).sort((a, b) => a.t - b.t);
  let cur = 'unknown';
  for (const e of evs) if (e.t <= from) cur = TL_STATE[e.type];
  const segs = [];
  const push = (a, b, state) => {
    if (b <= a) return;
    const last = segs[segs.length - 1];
    if (last && last.state === state) last.to = b;
    else segs.push({ from: a, to: b, state });
  };
  let t = from;
  for (const e of evs) {
    if (e.t <= from || e.t >= to) continue;
    push(t, e.t, cur);
    cur = TL_STATE[e.type];
    t = e.t;
  }
  push(t, to, cur);
  return segs;
}

function histBlock(s, from, to) {
  const events = histData[s.id] || [];
  const segs = timeline(events, from, to);
  const sum = (st) => segs.filter((x) => x.state === st).reduce((a, x) => a + x.to - x.from, 0);
  const inRange = events.filter((e) => e.t >= from);
  const crashes = inRange.filter((e) => e.type === 'crash').length;
  const restarts = inRange.filter((e) => e.type === 'restart').length;
  const downs = inRange.filter((e) => e.type === 'down').length;
  const known = to - from - sum('unknown');
  const run = sum('running');
  const downtime = sum('crashed') + sum('unhealthy');
  const crashSegs = segs.filter((x) => x.state === 'crashed');
  const typical = crashSegs.length ? crashSegs.reduce((a, x) => a + x.to - x.from, 0) / crashSegs.length : 0;
  const longest = segs.filter((x) => x.state === 'running').reduce((m, x) => Math.max(m, x.to - x.from), 0);
  const verdict = crashes >= 3 ? '<span class="badge crashed">Flaky</span>' : crashes || downs ? '<span class="badge installing">Some trouble</span>' : known > 0 ? '<span class="badge up">Stable</span>' : '';
  const bar = segs.map((x) => `<i class="tl-${x.state}" style="width:${((x.to - x.from) / (to - from)) * 100}%" title="${TL_LABEL[x.state]} · ${fmtDur(x.to - x.from)}&#10;${fmtWhen(x.from)} → ${fmtWhen(x.to)}"></i>`).join('');
  const shown = [...events].reverse().slice(0, 40);
  return `<div class="hist-svc">
    <div class="hist-h"><b>${esc(s.name)}</b>${verdict}<span class="spacer"></span>
      <span class="dim">${crashes} crash${crashes === 1 ? '' : 'es'} · ${restarts} auto-restart${restarts === 1 ? '' : 's'} · ${downs} health failure${downs === 1 ? '' : 's'}</span></div>
    <div class="tl">${bar || '<i class="tl-unknown" style="width:100%"></i>'}</div>
    <div class="tl-axis"><span>${fmtWhen(from)}</span><span>now</span></div>
    <div class="hist-stats">
      <span><b>${known > 0 ? ((run / known) * 100).toFixed(1) + '%' : '-'}</b> up</span>
      <span><b>${fmtDur(downtime)}</b> down</span>
      <span><b>${typical ? fmtDur(typical) : '-'}</b> typical outage</span>
      <span><b>${longest ? fmtDur(longest) : '-'}</b> longest run</span>
    </div>
    <details><summary>Events (${events.length})</summary>
      <div class="ev-list">${shown.map((e) => `<div class="ev ev-${e.type}"><span class="dim">${fmtWhen(e.t)}</span><b>${EV_LABEL[e.type] || e.type}</b><span class="dim">${esc(e.detail)}</span></div>`).join('') || '<div class="dim">Nothing recorded yet.</div>'}</div>
    </details></div>`;
}

function paintHistory() {
  const p = sel();
  const body = $('#hist-body');
  if (!p || !body) return;
  const to = Date.now();
  body.innerHTML = p.services.map((s) => histBlock(s, to - histRange, to)).join('')
    + `<div class="hist-legend">${['running', 'unhealthy', 'crashed', 'stopped', 'unknown'].map((k) => `<span><i class="tl-${k}"></i>${TL_LABEL[k]}</span>`).join('')}</div>`;
  document.querySelectorAll('[data-action=history-range]').forEach((b) => b.classList.toggle('primary', Number(b.dataset.ms) === histRange));
}

async function openHistory() {
  const p = sel();
  if (!p) return;
  histData = await api.getHistory(p.services.map((s) => s.id));
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal">
    <h2>History <span class="dim">${esc(p.name)}</span></h2>
    <div class="body"><div class="presets"><span class="dim">Show the last</span>
      <button class="btn small" data-action="history-range" data-ms="${24 * 3600e3}">24 hours</button>
      <button class="btn small" data-action="history-range" data-ms="${7 * 24 * 3600e3}">7 days</button>
      <button class="btn small" data-action="history-range" data-ms="${30 * 24 * 3600e3}">30 days</button></div>
      <div id="hist-body"></div></div>
    <div class="foot"><button class="btn" data-action="history-clear">Clear history</button><span class="spacer"></span><button class="btn primary" data-action="modal-close">Close</button></div></div></div>`;
  paintHistory();
}

// =====================================================================================
// .env editor
// =====================================================================================
const SECRET_KEY = /(secret|token|passw|pwd|private|credential|api[_-]?key|auth|salt|signature|dsn|database_url|connection|_key$|^key$)/i;
const envS = { svcId: null, files: [], cur: '', cache: {}, reveal: false, cmp: '', showSame: false, msg: '' };
const envDirty = (name) => {
  const c = envS.cache[name];
  return !!c && JSON.stringify(c.rows.map((r) => [r.key, r.value])) !== JSON.stringify(c.orig);
};

async function envLoad(name) {
  if (envS.cache[name]) return envS.cache[name];
  const r = await api.envRead(envS.svcId, name);
  if (r.error) { envS.msg = r.error; return { rows: [], orig: [], template: false }; }
  const rows = r.entries.map((e) => ({ key: e.key, value: e.value }));
  envS.cache[name] = { rows, orig: rows.map((e) => [e.key, e.value]), template: r.template };
  return envS.cache[name];
}

const envTemplate = () => envS.files.find((f) => f.template && f.name === '.env.example') || envS.files.find((f) => f.template);

async function openEnv(svcId) {
  const l = await api.envList(svcId);
  const svc = projects.flatMap((p) => p.services).find((s) => s.id === svcId);
  if (!l.dir) return infoModal('.env files', 'Set the folder of this service first (Edit), then open the editor again.');
  Object.assign(envS, { svcId, files: l.files, cache: {}, reveal: false, cmp: '', showSame: false, msg: '', svcName: svc ? svc.name : '' });
  envS.cur = (l.files.find((f) => !f.template) || l.files[0] || {}).name || '';
  if (envS.cur) await envLoad(envS.cur);
  paintEnv();
}

function envRowHtml(r, i) {
  const masked = SECRET_KEY.test(r.key) && !envS.reveal && !r.show;
  return `<div class="env-row"><input type="text" class="env-k mono" data-i="${i}" value="${esc(r.key)}" placeholder="KEY" spellcheck="false">
    <input type="text" class="env-v mono ${masked ? 'masked' : ''}" data-i="${i}" value="${esc(r.value)}" placeholder="value" spellcheck="false" autocomplete="off">
    <button class="btn ghost small" data-action="env-eye" data-i="${i}" title="Show or hide the value">${ic('eye')}</button>
    <button class="btn ghost small" data-action="env-del" data-i="${i}" title="Remove this variable">${ic('trash')}</button></div>`;
}

function envCompareHtml(cur, other) {
  const a = new Map(cur.rows.map((r) => [r.key, r.value]));
  const b = new Map(other.rows.map((r) => [r.key, r.value]));
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const show = (k, v) => (v === undefined ? '<span class="dim">-</span>' : SECRET_KEY.test(k) && !envS.reveal ? '<span class="dim">••••••</span>' : `<span class="mono">${esc(v)}</span>`);
  const rows = keys.map((k) => {
    const st = !b.has(k) ? 'only-here' : !a.has(k) ? 'only-there' : a.get(k) !== b.get(k) ? 'diff' : 'same';
    return { k, st };
  });
  const counts = (s) => rows.filter((r) => r.st === s).length;
  const body = rows.filter((r) => envS.showSame || r.st !== 'same').map(({ k, st }) => {
    const tag = { 'only-here': '<span class="badge up">only here</span>', 'only-there': '<span class="badge installing">missing here</span>', diff: '<span class="badge down">different</span>', same: '<span class="badge">same</span>' }[st];
    const act = st === 'only-there' ? `<button class="btn small" data-action="env-cmp-add" data-k="${esc(k)}">Add here</button>` : st === 'diff' ? `<button class="btn small" data-action="env-cmp-use" data-k="${esc(k)}">Use other value</button>` : '';
    return `<tr><td class="mono"><b>${esc(k)}</b></td><td>${show(k, a.get(k))}</td><td>${show(k, b.get(k))}</td><td>${tag}</td><td class="ar">${act}</td></tr>`;
  }).join('');
  return `<div class="dim">${counts('only-here')} only here · ${counts('only-there')} missing here · ${counts('diff')} different · ${counts('same')} identical
      <label class="chk" style="display:inline-flex;margin-left:12px"><input type="checkbox" id="env-same" ${envS.showSame ? 'checked' : ''}> show identical</label></div>
    <div class="ptab-wrap"><table class="ptab"><thead><tr><th>Key</th><th>${esc(envS.cur)}</th><th>${esc(envS.cmp)}</th><th></th><th></th></tr></thead>
    <tbody>${body || '<tr><td colspan="5" class="dim pad">The two files match.</td></tr>'}</tbody></table></div>`;
}

async function paintEnv() {
  const cur = envS.cur ? await envLoad(envS.cur) : null;
  const tpl = envTemplate();
  let main = '';
  if (!envS.files.length) {
    main = `<div class="dim pad">This folder has no .env files yet.</div><button class="btn primary" data-action="env-create">Create .env</button>`;
  } else if (envS.cmp) {
    main = envCompareHtml(cur, await envLoad(envS.cmp));
  } else {
    const have = new Set(cur.rows.map((r) => r.key));
    let missing = [];
    if (tpl && tpl.name !== envS.cur && !cur.template) {
      const t = await envLoad(tpl.name);
      missing = t.rows.filter((r) => !have.has(r.key));
    }
    const dup = cur.rows.map((r) => r.key).filter((k, i, a) => k && a.indexOf(k) !== i);
    main = `${missing.length ? `<div class="alert">${missing.length} variable${missing.length > 1 ? 's' : ''} from ${esc(tpl.name)} ${missing.length > 1 ? 'are' : 'is'} missing: <span class="mono">${esc(missing.slice(0, 6).map((r) => r.key).join(', '))}${missing.length > 6 ? ', ...' : ''}</span>
        <button class="btn amber small" data-action="env-addmissing">Add them</button></div>` : ''}
      ${dup.length ? `<div class="alert">Defined twice: ${esc([...new Set(dup)].join(', '))}. The first one usually wins.</div>` : ''}
      <div class="env-rows">${cur.rows.map(envRowHtml).join('') || '<div class="dim pad">No variables yet.</div>'}</div>
      <div><button class="btn small" data-action="env-add">${ic('plus')}Add variable</button></div>`;
  }
  const dirtyFiles = envS.files.filter((f) => envDirty(f.name)).map((f) => f.name);
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal wide">
    <h2>Environment files <span class="dim">${esc(envS.svcName || '')}</span></h2>
    <div class="body">
      <div class="presets">${envS.files.map((f) => `<button class="btn small ${f.name === envS.cur ? 'primary' : ''}" data-action="env-tab" data-name="${esc(f.name)}">${esc(f.name)}${envDirty(f.name) ? ' •' : ''}${f.template ? ' <span class="dim">template</span>' : ''}</button>`).join('')}
        <span class="spacer"></span>
        ${envS.files.length > 1 ? `<label class="dim">Compare with <select id="env-cmp"><option value="">(nothing)</option>${envS.files.filter((f) => f.name !== envS.cur).map((f) => `<option ${f.name === envS.cmp ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>` : ''}
        <label class="chk"><input type="checkbox" id="env-reveal" ${envS.reveal ? 'checked' : ''}> Show secret values</label></div>
      ${envS.msg ? `<div class="alert">${esc(envS.msg)}</div>` : ''}
      ${main}
    </div>
    <div class="foot"><span class="dim">${dirtyFiles.length ? 'Unsaved changes in ' + esc(dirtyFiles.join(', ')) : 'Restart the service after saving for the changes to apply.'}</span><span class="spacer"></span>
      <button class="btn" data-action="modal-close">Close</button>
      <button class="btn primary" data-action="env-save" ${envS.cmp || !envDirty(envS.cur) ? 'disabled' : ''}>Save ${esc(envS.cur)}</button></div></div></div>`;
}

document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t.classList || !(t.classList.contains('env-k') || t.classList.contains('env-v'))) return;
  const row = envS.cache[envS.cur].rows[Number(t.dataset.i)];
  if (t.classList.contains('env-k')) row.key = t.value.trim();
  else row.value = t.value;
  const save = $('[data-action=env-save]');
  if (save) save.disabled = !envDirty(envS.cur);
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'env-reveal') { envS.reveal = e.target.checked; await paintEnv(); }
  if (e.target.id === 'env-cmp') { envS.cmp = e.target.value; await paintEnv(); }
  if (e.target.id === 'env-same') { envS.showSame = e.target.checked; await paintEnv(); }
});

// =====================================================================================
// Database tools
// =====================================================================================
const dbS = { svcId: null, info: null, tab: 'connect', db: '', dbs: [], list: null, result: null, sel: '', msg: '', busy: false };

async function openDb(svcId) {
  const info = await api.dbInfo(svcId);
  if (!info) return infoModal('Database', 'RunBay does not recognise this service as a database.');
  const svc = projects.flatMap((p) => p.services).find((s) => s.id === svcId);
  Object.assign(dbS, { svcId, info, svc, tab: 'connect', db: info.database || '', dbs: [], list: null, result: null, sel: '', msg: '', busy: false });
  paintDb();
}

function gridHtml(res, clickAction) {
  if (!res) return '';
  if (!res.ok) return `<div class="alert">${esc(res.error)}</div>`;
  if (res.text !== undefined) return `<pre class="mono pre">${esc(res.text)}</pre>`;
  if (!res.rows.length) return '<div class="dim pad">Empty.</div>';
  const cut = (v) => (String(v).length > 120 ? String(v).slice(0, 117) + '…' : String(v));
  return `<div class="ptab-wrap"><table class="ptab"><thead><tr>${res.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${res.rows.map((r) => `<tr ${clickAction ? `class="clickable" data-action="${clickAction}" data-v="${esc(r[0])}"` : ''}>${r.map((c) => `<td class="mono" title="${esc(c)}">${esc(cut(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function dbTabBody() {
  const i = dbS.info;
  if (dbS.tab === 'connect') {
    const shown = i.connection.replace(/(:\/\/[^:@/]+):[^@/]*@/, '$1:••••@');
    return `<label class="f">Connection string<div class="pathrow"><input type="text" class="mono" readonly value="${esc(shown)}"><button class="btn small" data-action="db-copy">Copy</button></div></label>
      <div class="dim">${i.docker ? `Docker container <span class="mono">${esc(i.container || '(no --name)')}</span> · ` : ''}localhost:${i.port}${i.user ? ` · user <span class="mono">${esc(i.user)}</span>` : ''}${i.hasPassword ? ' · password hidden above, copied in full' : ''}</div>
      ${!i.docker ? '<div class="dim">Backups and the table viewer need a database started with <span class="mono">docker run --name ...</span>, like RunBay\'s presets.</div>' : ''}
      ${!i.running ? '<div class="alert">Start this database to use backups and the table viewer.</div>' : ''}`;
  }
  if (dbS.tab === 'backup') {
    const volatile = dbS.svc && /--rm\b/.test(dbS.svc.command) && !/(\s-v\s|--volume|--mount)/.test(dbS.svc.command);
    return `${volatile ? '<div class="alert">This container was started with <span class="mono">--rm</span> and no volume, so its data is deleted when it stops. Back up before stopping.</div>' : ''}
      <div class="dim">${i.kind === 'redis' ? 'Saves the current dataset (dump.rdb).' : 'Saves every database as one SQL file.'}</div>
      <div class="presets"><button class="btn primary" data-action="db-backup" ${dbS.busy ? 'disabled' : ''}>Back up now…</button>
        ${i.kind === 'postgres' || i.kind === 'mysql' ? `<button class="btn red" data-action="db-restore" ${dbS.busy ? 'disabled' : ''}>Restore from file…</button>` : ''}</div>
      ${dbS.busy ? '<div class="dim">Working…</div>' : ''}${dbS.msg ? `<div class="alert">${dbS.msg}</div>` : ''}
      ${i.kind === 'postgres' || i.kind === 'mysql' ? '<div class="dim">Restoring runs the SQL file on this server and replaces objects with the same names.</div>' : ''}`;
  }
  // browse
  if (i.kind === 'redis') {
    return `<div class="insp" style="height:380px"><div class="insp-list">${gridHtml(dbS.list, 'db-key')}</div><div class="insp-detail">${dbS.result ? gridHtml(dbS.result) : '<div class="dim">Pick a key.</div>'}</div></div>`;
  }
  return `<div class="presets"><label class="dim">Database <select id="db-pick">${dbS.dbs.map((d) => `<option ${d === dbS.db ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select></label>
      <span class="dim">Read-only · first 100 rows</span></div>
    <div class="insp" style="height:360px"><div class="insp-list">${gridHtml(dbS.list, 'db-table')}</div><div class="insp-detail">${dbS.result ? gridHtml(dbS.result) : '<div class="dim">Pick a table.</div>'}</div></div>`;
}

function paintDb() {
  const i = dbS.info;
  const canBrowse = i.docker && i.container && ['postgres', 'mysql', 'redis'].includes(i.kind);
  const tabs = [['connect', 'Connect'], ...(i.docker && i.container ? [['backup', 'Backup & restore']] : []), ...(canBrowse ? [['browse', 'Browse']] : [])];
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal wide">
    <h2>${esc({ postgres: 'PostgreSQL', mysql: 'MySQL', redis: 'Redis', mongo: 'MongoDB' }[i.kind])} <span class="dim">${esc(dbS.svc ? dbS.svc.name : '')}</span></h2>
    <div class="body"><div class="presets">${tabs.map(([k, n]) => `<button class="btn small ${dbS.tab === k ? 'primary' : ''}" data-action="db-tab" data-tab="${k}">${n}</button>`).join('')}</div>
      ${dbTabBody()}</div>
    <div class="foot"><span class="spacer"></span><button class="btn primary" data-action="modal-close">Close</button></div></div></div>`;
}

async function dbLoadList() {
  const i = dbS.info;
  dbS.list = null;
  dbS.result = null;
  if (i.kind === 'redis') { dbS.list = await api.dbQuery(dbS.svcId, 'keys'); return paintDb(); }
  if (!dbS.dbs.length) {
    const r = await api.dbQuery(dbS.svcId, 'dbs');
    if (!r.ok) { dbS.list = r; return paintDb(); }
    dbS.dbs = r.rows.map((x) => x[0]).filter((d) => !['information_schema', 'performance_schema', 'sys'].includes(d));
    if (!dbS.db || !dbS.dbs.includes(dbS.db)) dbS.db = dbS.dbs.find((d) => d !== 'mysql') || dbS.dbs[0] || '';
  }
  dbS.list = await api.dbQuery(dbS.svcId, 'tables', { db: dbS.db });
  paintDb();
}

// =====================================================================================
// Local domains
// =====================================================================================
let domBusy = '';

async function openDomains(note) {
  const st = await api.domainsStatus();
  const ok = (v) => (v ? '<span class="badge up">ready</span>' : '<span class="badge installing">to do</span>');
  const rows = st.routes.map((r) => `<tr><td class="mono"><b>${esc(r.domain)}</b></td><td>${esc(r.label)}</td>
    <td>${r.running ? '<span class="badge running">running</span>' : '<span class="badge">stopped</span>'}</td>
    <td class="ar"><button class="btn small" data-action="url" data-url="${esc(r.url)}" ${st.running ? '' : 'disabled'}>Open</button></td></tr>`).join('');
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal wide">
    <h2>Local domains with HTTPS</h2>
    <div class="body">
      <div class="dim">Give a service a name like <span class="mono">myshop.test</span> and open it at <span class="mono">https://myshop.test</span> instead of <span class="mono">localhost:3000</span>. Cookies, OAuth redirects and webhooks behave like a real site. Set the domain in the service's Edit window.</div>
      ${note ? `<div class="alert">${esc(note)}</div>` : ''}${st.error ? `<div class="alert">${esc(st.error)}</div>` : ''}
      <div class="dom-step"><div><b>1 · Proxy</b><div class="dim">Receives https:// requests and passes them to your servers. Only reachable from this PC.</div></div>
        <div class="dom-ctl"><label class="dim">Port <input type="number" id="dom-port" min="1" max="65535" value="${st.httpsPort}" style="width:76px"></label>
          <button class="btn ${st.enabled && st.running ? 'red' : 'primary'} small" data-action="dom-toggle" ${domBusy ? 'disabled' : ''}>${st.enabled && st.running ? 'Switch off' : 'Switch on'}</button></div></div>
      <div class="dom-step"><div><b>2 · Certificate</b> ${ok(st.trusted)}<div class="dim">RunBay creates its own private certificate authority and signs your domains with it. Windows asks you to confirm adding it. It only exists for your Windows account.</div></div>
        <div class="dom-ctl">${st.trusted ? '<button class="btn small" data-action="dom-untrust">Remove trust</button>' : `<button class="btn primary small" data-action="dom-trust" ${domBusy ? 'disabled' : ''}>Trust certificate</button>`}</div></div>
      <div class="dom-step"><div><b>3 · Hosts file</b> ${ok(st.hostsMissing.length === 0)}<div class="dim">${st.hostsMissing.length ? `Missing: <span class="mono">${esc(st.hostsMissing.join(', '))}</span>. ` : ''}Maps your names to this PC. Windows asks for administrator permission once. Names ending in <span class="mono">.localhost</span> need no hosts entry.</div></div>
        <div class="dom-ctl"><button class="btn small ${st.hostsMissing.length ? 'primary' : ''}" data-action="dom-hosts" ${domBusy ? 'disabled' : ''}>Update hosts file</button>
          <button class="btn ghost small" data-action="dom-hosts-remove" ${domBusy ? 'disabled' : ''}>Remove entries</button></div></div>
      ${domBusy ? `<div class="dim">${esc(domBusy)}</div>` : ''}
      <b>Your domains</b>
      ${rows ? `<div class="ptab-wrap"><table class="ptab"><thead><tr><th>Domain</th><th>Service</th><th>State</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="dim pad">No service has a domain yet. Open a service with Edit and fill in "Local domain" (for example myshop.test).</div>'}
      <div class="dim">Firefox keeps its own certificate list: turn on <span class="mono">security.enterprise_roots.enabled</span> in about:config. Vite blocks unknown host names by default: add your domain to <span class="mono">server.allowedHosts</span>. Server-side requests from services started by RunBay already trust the certificate.</div>
    </div>
    <div class="foot"><span class="spacer"></span><button class="btn primary" data-action="modal-close">Close</button></div></div></div>`;
}

async function domRun(label, fn) {
  domBusy = label;
  await openDomains();
  const r = await fn();
  domBusy = '';
  await openDomains(r && r.ok === false ? r.error : '');
}

// =====================================================================================
// Click handling for everything above
// =====================================================================================
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const a = t.dataset.action;
  const p = sel();
  switch (a) {
    // history
    case 'history-open': return openHistory();
    case 'history-range': histRange = Number(t.dataset.ms); return paintHistory();
    case 'history-clear':
      await api.clearHistory(p.services.map((s) => s.id));
      histData = await api.getHistory(p.services.map((s) => s.id));
      return paintHistory();

    // env editor
    case 'env-open': return openEnv(t.dataset.id);
    case 'env-tab': envS.cur = t.dataset.name; envS.cmp = ''; envS.msg = ''; return paintEnv();
    case 'env-add': envS.cache[envS.cur].rows.push({ key: '', value: '' }); await paintEnv(); { const k = [...document.querySelectorAll('.env-k')].pop(); if (k) k.focus(); } return;
    case 'env-del': envS.cache[envS.cur].rows.splice(Number(t.dataset.i), 1); return paintEnv();
    case 'env-eye': { const r = envS.cache[envS.cur].rows[Number(t.dataset.i)]; r.show = !r.show; const v = t.parentElement.querySelector('.env-v'); v.classList.toggle('masked', SECRET_KEY.test(r.key) && !envS.reveal && !r.show); return; }
    case 'env-addmissing': {
      const have = new Set(envS.cache[envS.cur].rows.map((r) => r.key));
      envS.cache[envS.cur].rows.push(...envS.cache[envTemplate().name].rows.filter((r) => !have.has(r.key)).map((r) => ({ key: r.key, value: r.value })));
      return paintEnv();
    }
    case 'env-create': {
      const r = await api.envSave(envS.svcId, '.env', []);
      if (!r.ok) { envS.msg = r.error; return paintEnv(); }
      const l = await api.envList(envS.svcId);
      envS.files = l.files;
      envS.cur = '.env';
      envS.cache = {};
      return paintEnv();
    }
    case 'env-cmp-add': { const o = envS.cache[envS.cmp].rows.find((r) => r.key === t.dataset.k); envS.cache[envS.cur].rows.push({ key: o.key, value: o.value }); return paintEnv(); }
    case 'env-cmp-use': {
      const o = envS.cache[envS.cmp].rows.find((r) => r.key === t.dataset.k);
      envS.cache[envS.cur].rows.find((r) => r.key === t.dataset.k).value = o.value;
      return paintEnv();
    }
    case 'env-save': {
      const c = envS.cache[envS.cur];
      const keys = c.rows.map((r) => r.key).filter(Boolean);
      const r = await api.envSave(envS.svcId, envS.cur, c.rows.filter((x) => x.key));
      if (!r.ok) { envS.msg = r.error; return paintEnv(); }
      c.rows = c.rows.filter((x) => x.key);
      c.orig = c.rows.map((x) => [x.key, x.value]);
      envS.msg = '';
      await paintEnv();
      toast($('[data-action=env-save]'), keys.length ? 'Saved ✓' : 'Saved');
      return loadDeps();
    }

    // database
    case 'db-open': return openDb(t.dataset.id);
    case 'db-tab':
      dbS.tab = t.dataset.tab;
      dbS.msg = '';
      paintDb();
      return dbS.tab === 'browse' ? dbLoadList() : undefined;
    case 'db-copy': await navigator.clipboard.writeText(dbS.info.connection); return toast(t, 'Copied ✓');
    case 'db-backup': {
      dbS.busy = true; dbS.msg = ''; paintDb();
      const r = await api.dbBackup(dbS.svcId);
      dbS.busy = false;
      if (r.cancelled) dbS.msg = '';
      else if (r.ok) dbS.msg = `Saved ${esc(r.file)} (${(r.size / 1024).toFixed(0)} KB). <span class="link" data-action="path" data-path="${esc(r.file.replace(/[\\/][^\\/]*$/, ''))}">Show folder</span>`;
      else dbS.msg = esc(r.error);
      return paintDb();
    }
    case 'db-restore':
      if (!t.dataset.armed) {
        t.dataset.armed = '1';
        t.textContent = 'Click again to choose the file';
        setTimeout(() => { if (t.isConnected) { delete t.dataset.armed; t.textContent = 'Restore from file…'; } }, 4000);
        return;
      }
      dbS.busy = true; dbS.msg = ''; paintDb();
      { const r = await api.dbRestore(dbS.svcId); dbS.busy = false; dbS.msg = r.cancelled ? '' : r.ok ? `Restore finished.${r.note ? ' ' + esc(r.note) : ''}` : esc(r.error); }
      return paintDb();
    case 'db-table':
      dbS.sel = t.dataset.v;
      dbS.result = await api.dbQuery(dbS.svcId, 'rows', { db: dbS.db, table: dbS.sel });
      return paintDb();
    case 'db-key':
      dbS.result = await api.dbQuery(dbS.svcId, 'key', { key: t.dataset.v });
      return paintDb();

    // domains
    case 'domains-open': return openDomains();
    case 'dom-toggle': {
      const st = await api.domainsStatus();
      const on = !(st.enabled && st.running);
      const port = Number($('#dom-port').value) || 443;
      return domRun(on ? 'Starting the proxy…' : 'Stopping…', () => api.domainsEnable(on, port));
    }
    case 'dom-trust': return domRun('Waiting for Windows to confirm the certificate…', () => api.domainsTrust());
    case 'dom-untrust': return domRun('Removing the certificate…', () => api.domainsUntrust());
    case 'dom-hosts': return domRun('Waiting for administrator permission…', () => api.domainsHosts(false));
    case 'dom-hosts-remove': return domRun('Waiting for administrator permission…', () => api.domainsHosts(true));
  }
});

// the database browser: changing the database re-lists its tables
document.addEventListener('change', (e) => {
  if (e.target.id === 'db-pick') { dbS.db = e.target.value; dbLoadList(); }
});

// =====================================================================================
// Language versions (service editor)
// =====================================================================================
let rtCatalogAt = 0;

async function refreshRuntimeNotes() {
  const els = [...document.querySelectorAll('.svc-edit')];
  if (!els.length) return;
  if (Date.now() - rtCatalogAt > 5000) {
    rtCatalogAt = Date.now();
    try {
      runtimeCatalog = await api.runtimeList();
      // new installs show up in the drop-downs without losing the current choice
      document.querySelectorAll('.s-runtime').forEach((sel) => { const cur = sel.value; sel.innerHTML = runtimeOptions(cur); });
    } catch {}
  }
  for (const el of els) {
    const cwd = $('.s-cwd', el).value.trim();
    const mode = $('.s-runtime', el).value || 'auto';
    const key = cwd + '|' + mode;
    if (el.dataset.rtKey === key) continue;
    el.dataset.rtKey = key;
    const box = $('.rt-note', el);
    const r = cwd ? await api.runtimeDetect(cwd, mode) : { pins: [], chosen: [], missing: [] };
    if (el.dataset.rtKey !== key) continue; // the folder changed while we were asking
    const lines = [
      ...r.chosen.map((c) => `<div class="dim">${ic('check')} ${esc(c.label)} <span class="dim">· ${esc(c.source)}${c.manager && c.manager !== 'system' ? ' · ' + esc(c.manager) : c.manager === 'system' ? ' · already the system version' : ''}</span></div>`),
      ...r.missing.map((m) => `<div style="color:var(--amber);font-size:12px">${ic('alert')} ${esc(({ node: 'Node', python: 'Python', php: 'PHP' })[m.lang])} ${esc(m.spec)} is required by ${esc(m.source)} but is not installed. To fix: <span class="mono">${esc(m.hint)}</span></div>`),
    ];
    box.innerHTML = lines.length ? lines.join('') : (mode === 'auto' && cwd ? '<div class="dim">No version file found in this folder: the system versions are used.</div>' : '');
  }
}

document.addEventListener('change', (e) => {
  if (e.target.classList && (e.target.classList.contains('s-cwd') || e.target.classList.contains('s-runtime'))) refreshRuntimeNotes();
});

// the start-order refresh runs whenever the service list changes: piggy-back on it
const refreshDepsOnly = refreshDeps;
refreshDeps = function refreshDepsAndRuntimes() { refreshDepsOnly(); refreshRuntimeNotes(); };

// =====================================================================================
// "Explain this error" with Claude
// =====================================================================================
const aiS = { svcId: null, seq: null, pv: null, answer: null, busy: false, err: '', keyMsg: '' };

// a small, safe Markdown subset: headings, bold, inline code, fenced code, lists, paragraphs
function mdHtml(src) {
  const blocks = [];
  const NUL = String.fromCharCode(0);
  const t = esc(src).replace(/```[\w-]*\n([\s\S]*?)```/g, (m, code) => { blocks.push(`<pre class="mono pre">${code.replace(/\n$/, '')}</pre>`); return `${NUL}${blocks.length - 1}${NUL}`; });
  const inline = (x) => x.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of t.split('\n')) {
    let m;
    if ((m = line.match(new RegExp(`^${NUL}(\\d+)${NUL}$`)))) { close(); out.push(blocks[Number(m[1])]); }
    else if ((m = line.match(/^\s*(\d+)\.\s+(.*)$/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[2])}</li>`); }
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^#{1,4}\s+(.*)$/)) || (m = line.match(/^\*\*([^*]+)\*\*:?\s*$/))) { close(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('');
}

async function openAi(svcId, seq) {
  Object.assign(aiS, { svcId, seq, pv: null, answer: null, busy: false, err: '', keyMsg: '' });
  $('#modal-root').innerHTML = '<div class="overlay"><div class="modal"><h2>Explain this error</h2><div class="body"><div class="dim">Preparing…</div></div></div></div>';
  aiS.pv = await api.aiPreview(svcId, seq);
  paintAi();
}

function paintAi() {
  const pv = aiS.pv;
  let body;
  if (!pv || !pv.ok) body = `<div class="alert">${esc((pv && pv.error) || 'Something went wrong.')}</div>`;
  else if (aiS.answer) {
    body = `<div class="ai-answer">${mdHtml(aiS.answer.text)}</div>
      <details><summary>What was sent to Claude</summary><pre class="mono pre">${esc(pv.prompt)}</pre></details>
      <div class="dim">${esc(aiS.answer.model)}${aiS.answer.usage ? ` · ${aiS.answer.usage.input} tokens in, ${aiS.answer.usage.output} out` : ''}. AI can be wrong: check the fix before you run it.</div>`;
  } else {
    body = `<div class="dim">Claude (${esc(pv.modelName)}) will receive only the text below. Nothing is sent until you press <b>Ask Claude</b>.
        ${pv.redactions ? `<b>${pv.redactions}</b> secret${pv.redactions > 1 ? 's' : ''} (variables from your .env files, tokens, passwords, user name) ${pv.redactions > 1 ? 'were' : 'was'} replaced with [hidden].` : 'No secrets were found to hide, but please read it.'}</div>
      <pre class="mono pre" style="max-height:300px">${esc(pv.prompt)}</pre>
      ${pv.hasKey ? '' : `<div class="alert" style="flex-direction:column;align-items:stretch">Add your Anthropic API key to use this. It is stored encrypted on this PC.
        <div class="pathrow"><input type="password" id="ai-key-inline" class="mono" placeholder="sk-ant-..." autocomplete="off"><button class="btn small primary" data-action="ai-key-inline">Save key</button></div>
        ${aiS.keyMsg ? `<div>${esc(aiS.keyMsg)}</div>` : ''}<div class="dim">Get one at <span class="link" data-action="url" data-url="https://console.anthropic.com/settings/keys">console.anthropic.com ${ic('ext')}</span></div></div>`}`;
  }
  if (aiS.err) body += `<div class="alert">${esc(aiS.err)}</div>`;
  $('#modal-root').innerHTML = `<div class="overlay"><div class="modal">
    <h2>Explain this error</h2><div class="body">${body}${aiS.busy ? '<div class="dim">Claude is thinking…</div>' : ''}</div>
    <div class="foot">${aiS.answer ? '<button class="btn" data-action="ai-copy">Copy answer</button>' : ''}<span class="spacer"></span>
      <button class="btn" data-action="modal-close">${aiS.answer ? 'Close' : 'Cancel'}</button>
      ${aiS.answer || !pv || !pv.ok ? '' : `<button class="btn primary" data-action="ai-ask" ${aiS.busy || !pv.hasKey ? 'disabled' : ''}>Ask Claude</button>`}</div></div></div>`;
}

// =====================================================================================
// Settings: AI key + command line
// =====================================================================================
async function settingsExtras() {
  if (!$('#ai-box') || !$('#cli-box')) return;
  const [a, c] = await Promise.all([api.aiStatus(), api.cliStatus()]);
  const ai = $('#ai-box');
  const cli = $('#cli-box');
  if (!ai || !cli) return;
  ai.innerHTML = `<div>${a.source === 'saved' ? 'API key saved (encrypted with Windows).' : a.source === 'environment' ? 'Using the ANTHROPIC_API_KEY found on this PC.' : 'No API key yet.'}</div>
    <div class="pathrow" style="margin-top:6px"><input type="password" id="set-ai-key" class="mono" placeholder="${a.source === 'saved' ? 'Paste a new key to replace it' : 'sk-ant-...'}" autocomplete="off" ${a.canStore ? '' : 'disabled'}>
      <button class="btn small" data-action="ai-key-save">Save</button>${a.source === 'saved' ? '<button class="btn small" data-action="ai-key-clear">Remove</button>' : ''}</div>
    <label class="f" style="margin-top:8px">Model<select id="set-ai-model" style="width:100%">${Object.entries(a.models).map(([id, n]) => `<option value="${id}" ${id === a.model ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
    <div class="dim" style="margin-top:6px">In the Errors tab, click an error to ask Claude what it means. You see exactly what is sent first, with secrets removed, and nothing leaves your PC otherwise.${a.canStore ? '' : ' Windows secure storage is unavailable, so a key cannot be saved.'}</div>`;
  cli.innerHTML = c.blocked ? esc(c.blocked) : `<div>${c.installed ? (c.onPath ? 'Installed. Open a new terminal and type <span class="mono">runbay help</span>.' : 'Installed, but not on your PATH yet.') : 'Control RunBay from a terminal, scripts or CI: <span class="mono">runbay start myshop --wait</span>.'}</div>
    <div class="presets" style="margin-top:6px">${c.installed ? '<button class="btn small" data-action="cli-uninstall">Remove command</button>' : '<button class="btn small primary" data-action="cli-install">Install the "runbay" command</button>'}</div>
    <div class="dim" style="margin-top:4px">${c.installed ? '' : 'Adds <span class="mono">' + esc(c.dir) + '</span> to your user PATH (not the system PATH).'}</div>`;
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  switch (t.dataset.action) {
    case 'ai-explain':
      if (window.getSelection().toString()) return; // selecting text, not clicking
      return openAi(t.dataset.svc, Number(t.dataset.seq));
    case 'ai-ask': {
      aiS.busy = true;
      aiS.err = '';
      paintAi();
      const r = await api.aiAsk(aiS.svcId, aiS.seq);
      aiS.busy = false;
      if (r.ok) aiS.answer = r; else aiS.err = r.error;
      return paintAi();
    }
    case 'ai-copy': await navigator.clipboard.writeText(aiS.answer.text); return toast(t, 'Copied ✓');
    case 'ai-key-inline': {
      const r = await api.aiSetKey($('#ai-key-inline').value);
      aiS.keyMsg = r.ok ? '' : r.error;
      if (r.ok) aiS.pv = await api.aiPreview(aiS.svcId, aiS.seq);
      return paintAi();
    }
    case 'ai-key-save':
    case 'ai-key-clear': {
      const r = await api.aiSetKey(t.dataset.action === 'ai-key-clear' ? '' : $('#set-ai-key').value);
      if (!r.ok) { $('#set-msg').textContent = r.error; return; }
      return settingsExtras();
    }
    case 'cli-install': t.disabled = true; t.textContent = 'Installing…'; await api.cliInstall(); return settingsExtras();
    case 'cli-uninstall': t.disabled = true; await api.cliUninstall(); return settingsExtras();
  }
});

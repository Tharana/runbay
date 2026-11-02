// Per-app Node / Python / PHP versions: read the version a project asks for (.nvmrc, .node-version, .python-version,
// .php-version, engines, composer.json ...), find it among the versions installed on this PC, and put it first on the
// PATH of the processes RunBay starts. Nothing global is switched, so two apps can run two versions side by side.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const E = process.env;
const LANGS = { node: 'Node', python: 'Python', php: 'PHP' };

// ---------- versions ----------
const parseVer = (s) => {
  const m = String(s).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const fmt = (v) => v.join('.');

function satisfiesComparator(v, token) {
  const m = token.match(/^(>=|<=|>|<|=|\^|~)?v?(\d+|x|\*)?(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/i);
  if (!m || m[2] === undefined) return m ? /^[x*]?$/i.test(token.replace(/^(>=|<=|>|<|=|\^|~)/, '')) : false;
  const op = m[1] || '=';
  const nums = [m[2], m[3], m[4]].map((p) => (p === undefined || /^[x*]$/i.test(p) ? null : Number(p)));
  const base = nums.map((n) => n ?? 0);
  const specified = nums.findIndex((n) => n === null) === -1 ? 3 : nums.findIndex((n) => n === null);
  const bump = (k) => { const b = base.slice(); b[k] += 1; for (let i = k + 1; i < 3; i++) b[i] = 0; return b; };
  const last = Math.max(0, specified - 1);
  switch (op) {
    case '=': return nums.every((n, i) => n === null || v[i] === n);
    case '>=': return cmp(v, base) >= 0;
    case '>': return specified === 3 ? cmp(v, base) > 0 : cmp(v, bump(last)) >= 0;
    case '<': return cmp(v, base) < 0;
    case '<=': return specified === 3 ? cmp(v, base) <= 0 : cmp(v, bump(last)) < 0;
    case '~': return cmp(v, base) >= 0 && cmp(v, bump(specified >= 2 ? 1 : 0)) < 0;
    case '^': {
      const nz = base.findIndex((n, i) => i < specified && n > 0);
      return cmp(v, base) >= 0 && cmp(v, bump(nz >= 0 ? nz : last)) < 0;
    }
    default: return false;
  }
}

function satisfiesRange(v, range) {
  return String(range).split('||').some((part) => {
    const toks = part.trim().replace(/,/g, ' ').replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    return toks.length > 0 && toks.every((t) => satisfiesComparator(v, t));
  });
}

// the highest installed version that fits the request; list = [{ v, ... }]
function pick(spec, list) {
  const s = String(spec || '').trim().replace(/^v(?=\d)/i, '');
  if (!s || !list.length) return null;
  const sorted = [...list].sort((a, b) => cmp(b.v, a.v));
  if (/^lts(\/.*)?$/i.test(s)) return sorted.find((e) => e.v[0] % 2 === 0) || sorted[0];
  if (/^(node|latest|stable|current|\*|x)$/i.test(s)) return sorted[0];
  return sorted.find((e) => satisfiesRange(e.v, s)) || null;
}

// ---------- what a project asks for ----------
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const json = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };
const firstLine = (t) => (t || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';

function folders(dir) {
  const out = [];
  let d = path.resolve(dir);
  for (let i = 0; i < 4; i++) {
    out.push(d);
    if (fs.existsSync(path.join(d, '.git'))) break; // do not look outside the repository
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

function detect(dir) {
  const pins = [];
  if (!dir) return pins;
  for (const d of folders(dir)) {
    const where = (f) => (d === path.resolve(dir) ? f : `${f} (in ${path.basename(d)})`);
    if (!pins.some((p) => p.lang === 'node')) {
      const pkg = json(path.join(d, 'package.json'));
      const nvmrc = firstLine(read(path.join(d, '.nvmrc')));
      const nv = firstLine(read(path.join(d, '.node-version')));
      if (nvmrc) pins.push({ lang: 'node', spec: nvmrc, source: where('.nvmrc') });
      else if (nv) pins.push({ lang: 'node', spec: nv, source: where('.node-version') });
      else if (pkg && pkg.volta && pkg.volta.node) pins.push({ lang: 'node', spec: pkg.volta.node, source: where('package.json (volta)') });
      else if (pkg && pkg.engines && pkg.engines.node) pins.push({ lang: 'node', spec: pkg.engines.node, source: where('package.json (engines)') });
    }
    if (!pins.some((p) => p.lang === 'python')) {
      const pv = (read(path.join(d, '.python-version')) || '').split(/\r?\n/).map((l) => l.trim()).find((l) => /^\d/.test(l));
      const rt = (read(path.join(d, 'runtime.txt')) || '').match(/python-(\d[\d.]*)/i);
      const req = (read(path.join(d, 'pyproject.toml')) || '').match(/requires-python\s*=\s*["']([^"']+)["']/);
      if (pv) pins.push({ lang: 'python', spec: pv, source: where('.python-version') });
      else if (rt) pins.push({ lang: 'python', spec: rt[1], source: where('runtime.txt') });
      else if (req) pins.push({ lang: 'python', spec: req[1], source: where('pyproject.toml') });
    }
    if (!pins.some((p) => p.lang === 'php')) {
      const pv = firstLine(read(path.join(d, '.php-version')));
      const comp = json(path.join(d, 'composer.json'));
      const need = comp && ((comp.config && comp.config.platform && comp.config.platform.php) || (comp.require && comp.require.php));
      if (pv) pins.push({ lang: 'php', spec: pv, source: where('.php-version') });
      else if (need) pins.push({ lang: 'php', spec: need, source: where('composer.json') });
    }
  }
  return pins;
}

// ---------- what is installed ----------
const subdirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
const has = (...p) => fs.existsSync(path.join(...p));
const uniq = (list) => [...new Set(list.filter(Boolean))];

function listNode() {
  const out = [];
  for (const root of uniq([E.NVM_HOME, E.APPDATA && path.join(E.APPDATA, 'nvm')])) {
    for (const name of subdirs(root)) if (/^v\d/.test(name) && has(root, name, 'node.exe')) out.push({ v: parseVer(name), dir: path.join(root, name), manager: 'nvm-windows' });
  }
  for (const root of uniq([E.FNM_DIR, E.APPDATA && path.join(E.APPDATA, 'fnm'), E.LOCALAPPDATA && path.join(E.LOCALAPPDATA, 'fnm')])) {
    for (const name of subdirs(path.join(root, 'node-versions'))) {
      const d = path.join(root, 'node-versions', name, 'installation');
      if (/^v\d/.test(name) && has(d, 'node.exe')) out.push({ v: parseVer(name), dir: d, manager: 'fnm' });
    }
  }
  for (const root of uniq([E.VOLTA_HOME, E.LOCALAPPDATA && path.join(E.LOCALAPPDATA, 'Volta')])) {
    const base = path.join(root, 'tools', 'image', 'node');
    for (const name of subdirs(base)) if (has(base, name, 'node.exe')) out.push({ v: parseVer(name), dir: path.join(base, name), manager: 'Volta' });
  }
  return out;
}

const exeVersion = (exe, args) => {
  try { return parseVer(execFileSync(exe, args, { windowsHide: true, timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; }
};
const verCache = new Map();
const cachedVersion = (exe, args) => {
  if (!verCache.has(exe)) verCache.set(exe, exeVersion(exe, args));
  return verCache.get(exe);
};

function listPython() {
  const out = [];
  for (const root of uniq([E.PYENV_ROOT && path.join(E.PYENV_ROOT, 'pyenv-win'), E.PYENV, E.USERPROFILE && path.join(E.USERPROFILE, '.pyenv', 'pyenv-win'), E.PYENV_ROOT])) {
    const base = path.join(root, 'versions');
    for (const name of subdirs(base)) {
      const d = path.join(base, name);
      if (has(d, 'python.exe') && parseVer(name)) out.push({ v: parseVer(name), dir: d, extra: [path.join(d, 'Scripts')], manager: 'pyenv-win' });
    }
  }
  const pyDirs = [];
  if (E.LOCALAPPDATA) for (const n of subdirs(path.join(E.LOCALAPPDATA, 'Programs', 'Python'))) pyDirs.push(path.join(E.LOCALAPPDATA, 'Programs', 'Python', n));
  for (const n of subdirs('C:\\')) if (/^Python\d+/i.test(n)) pyDirs.push(path.join('C:\\', n));
  for (const d of pyDirs) {
    const exe = path.join(d, 'python.exe');
    if (!fs.existsSync(exe)) continue;
    const v = cachedVersion(exe, ['--version']);
    if (v) out.push({ v, dir: d, extra: [path.join(d, 'Scripts')], manager: 'python.org' });
  }
  return out;
}

function listPhp() {
  const out = [];
  const roots = [
    ...(E.PHP_ROOTS ? E.PHP_ROOTS.split(';') : []),
    'C:\\laragon\\bin\\php',
    E.USERPROFILE && path.join(E.USERPROFILE, 'scoop', 'apps', 'php'),
  ].filter(Boolean);
  for (const root of roots) {
    for (const name of subdirs(root)) {
      const d = path.join(root, name);
      const v = parseVer(name.replace(/^php-?/i, ''));
      if (has(d, 'php.exe') && v) out.push({ v, dir: d, manager: /laragon/i.test(root) ? 'Laragon' : /scoop/i.test(root) ? 'Scoop' : 'folder' });
    }
  }
  if (has('C:\\xampp\\php', 'php.exe')) {
    const v = cachedVersion('C:\\xampp\\php\\php.exe', ['-r', 'echo PHP_VERSION;']);
    if (v) out.push({ v, dir: 'C:\\xampp\\php', manager: 'XAMPP' });
  }
  return out;
}

let cache = { at: 0, data: null };
function installed(fresh = false) {
  if (!fresh && cache.data && Date.now() - cache.at < 30000) return cache.data;
  const data = { node: listNode(), python: listPython(), php: listPhp() };
  for (const k of Object.keys(data)) {
    const seen = new Set();
    data[k] = data[k].filter((e) => { const key = fmt(e.v); if (seen.has(key)) return false; seen.add(key); return true; }).sort((a, b) => cmp(b.v, a.v));
  }
  cache = { at: Date.now(), data };
  return data;
}

// what the PC uses when RunBay changes nothing
function systemVersion(lang) {
  const probe = { node: ['node', ['-v']], python: ['python', ['--version']], php: ['php', ['-r', 'echo PHP_VERSION;']] }[lang];
  return cachedVersion(`system:${lang}`, null) || (verCache.set(`system:${lang}`, exeVersion(probe[0], probe[1])), verCache.get(`system:${lang}`));
}

// for the editor's drop-down
function catalog() {
  const inst = installed(true);
  const out = {};
  for (const k of Object.keys(inst)) out[k] = inst[k].map((e) => ({ version: fmt(e.v), manager: e.manager }));
  return out;
}

const HINTS = {
  node: (spec, inst) => {
    const base = String(spec).replace(/^v/i, '').match(/\d+(\.\d+)?/);
    const n = base ? base[0] : spec;
    if (E.NVM_HOME || (E.APPDATA && fs.existsSync(path.join(E.APPDATA, 'nvm')))) return `nvm install ${n}`;
    if (E.FNM_DIR || (E.APPDATA && fs.existsSync(path.join(E.APPDATA, 'fnm')))) return `fnm install ${n}`;
    if (E.LOCALAPPDATA && fs.existsSync(path.join(E.LOCALAPPDATA, 'Volta'))) return `volta install node@${n}`;
    return `install Node ${n} (nodejs.org, or a version manager such as fnm or nvm-windows)`;
  },
  python: (spec) => {
    const n = (String(spec).match(/\d+(\.\d+)?/) || [spec])[0];
    return fs.existsSync(path.join(E.USERPROFILE || '', '.pyenv')) ? `pyenv install ${n}` : `install Python ${n} (python.org or pyenv-win)`;
  },
  php: (spec) => `install PHP ${(String(spec).match(/\d+(\.\d+)?/) || [spec])[0]} (Laragon or "scoop install php")`,
};

// mode: 'auto' (follow the project files), 'off' (leave the PATH alone) or 'lang:version' (an explicit choice for one language)
function plan(dir, mode = 'auto') {
  const res = { mode: mode || 'auto', pins: [], chosen: [], missing: [] };
  if (res.mode === 'off') return res;
  const inst = installed();
  let pins = detect(dir);
  res.pins = pins;
  const explicit = String(res.mode).match(/^(node|python|php):(.+)$/);
  if (explicit) {
    const e = inst[explicit[1]].find((x) => fmt(x.v) === explicit[2]);
    pins = pins.filter((p) => p.lang !== explicit[1]);
    if (e) res.chosen.push({ lang: explicit[1], version: fmt(e.v), dir: e.dir, extra: e.extra || [], manager: e.manager, source: 'chosen in RunBay' });
    else res.missing.push({ lang: explicit[1], spec: explicit[2], source: 'chosen in RunBay', hint: HINTS[explicit[1]](explicit[2]) });
  }
  for (const p of pins) {
    const sys = systemVersion(p.lang);
    if (sys && pick(p.spec, [{ v: sys }])) { res.chosen.push({ lang: p.lang, version: fmt(sys), dir: null, extra: [], manager: 'system', source: p.source }); continue; }
    const e = pick(p.spec, inst[p.lang]);
    if (e) res.chosen.push({ lang: p.lang, version: fmt(e.v), dir: e.dir, extra: e.extra || [], manager: e.manager, source: p.source });
    else res.missing.push({ lang: p.lang, spec: p.spec, source: p.source, hint: HINTS[p.lang](p.spec) });
  }
  return res;
}

// put the chosen versions first on PATH (Windows keeps the key's original spelling, usually "Path")
function applyToEnv(env, chosen) {
  const dirs = chosen.flatMap((c) => (c.dir ? [c.dir, ...(c.extra || [])] : [])).filter((d) => fs.existsSync(d));
  if (!dirs.length) return env;
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env[key] = dirs.join(';') + ';' + (env[key] || '');
  return env;
}

const label = (c) => `${LANGS[c.lang]} ${c.version}`;

module.exports = { detect, installed, catalog, plan, pick, parseVer, applyToEnv, label, satisfiesRange, LANGS };

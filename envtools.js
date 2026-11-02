// Reading, merging and comparing .env files. Everything is limited to .env* files directly inside a service folder.
const fs = require('fs');
const path = require('path');

const ENV_FILE = /^\.env(\..+)?$/i;
const TEMPLATE = /\.(example|sample|template|dist|defaults?)$/i;
const TEMPLATE_ORDER = ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults'];

// KEY=value, optionally "export KEY=value"; quotes and trailing comments are removed from the value
function parseLine(raw) {
  const m = raw.match(/^\s*(export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/);
  if (!m) return null;
  let v = m[3];
  if (v.startsWith('"')) {
    const end = v.slice(1).search(/(?<!\\)"/);
    v = end >= 0 ? v.slice(1, end + 1) : v.slice(1);
    v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  } else if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    v = end >= 0 ? v.slice(1, end) : v.slice(1);
  } else {
    v = v.replace(/\s+#.*$/, '').trim();
  }
  return { prefix: m[1] || '', key: m[2], value: v };
}

function parse(text) {
  const entries = [];
  for (const line of String(text).split(/\r?\n/)) {
    const p = parseLine(line);
    if (p) entries.push({ key: p.key, value: p.value });
  }
  return entries;
}

const fmt = (v) => (/^[\w@%+=:,./-]*$/.test(v) ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`);

// keep comments, blank lines and order; only touch lines whose value changed
function merge(raw, entries) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const want = new Map(entries.map((e) => [e.key, String(e.value)]));
  const seen = new Set();
  const out = [];
  const lines = raw.split(/\r?\n/);
  const endsWithNewline = lines.length > 1 && lines[lines.length - 1] === '';
  if (endsWithNewline) lines.pop();
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) { out.push(line); continue; }
    if (!want.has(p.key)) continue; // removed in the editor
    if (seen.has(p.key)) { out.push(line); continue; }
    seen.add(p.key);
    out.push(p.value === want.get(p.key) ? line : `${p.prefix}${p.key}=${fmt(want.get(p.key))}`);
  }
  for (const [k, v] of want) if (!seen.has(k)) out.push(`${k}=${fmt(v)}`);
  return out.join(eol) + (out.length && (endsWithNewline || !raw) ? eol : '');
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => ENV_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile())
      .sort((a, b) => (a === '.env' ? -1 : b === '.env' ? 1 : a.localeCompare(b)))
      .map((name) => ({ name, template: TEMPLATE.test(name) }));
  } catch {
    return [];
  }
}

const safeName = (name) => typeof name === 'string' && path.basename(name) === name && ENV_FILE.test(name);

function read(dir, name) {
  if (!dir || !safeName(name)) return null;
  const raw = fs.readFileSync(path.join(dir, name), 'utf8');
  return { name, template: TEMPLATE.test(name), entries: parse(raw) };
}

function save(dir, name, entries) {
  if (!dir || !safeName(name)) throw new Error('Not an .env file.');
  const f = path.join(dir, name);
  let raw = '';
  try { raw = fs.readFileSync(f, 'utf8'); } catch {}
  const clean = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && /^[A-Za-z_][\w.-]*$/.test(String(e.key)))
    .map((e) => ({ key: String(e.key), value: String(e.value ?? '') }));
  fs.writeFileSync(f, merge(raw, clean));
}

// which keys of the template are not defined anywhere (any real .env file or RunBay's own variables)
function missingKeys(dir, extraKeys = []) {
  if (!dir) return null;
  const files = listFiles(dir);
  const template = TEMPLATE_ORDER.find((t) => files.some((f) => f.name === t));
  if (!template) return null;
  const have = new Set(extraKeys);
  const actual = files.filter((f) => !f.template);
  for (const f of actual) {
    try { for (const e of parse(fs.readFileSync(path.join(dir, f.name), 'utf8'))) have.add(e.key); } catch {}
  }
  let wanted = [];
  try { wanted = parse(fs.readFileSync(path.join(dir, template), 'utf8')).map((e) => e.key); } catch { return null; }
  return { template, actual: actual.map((f) => f.name), missing: wanted.filter((k) => !have.has(k)) };
}

module.exports = { parse, merge, listFiles, read, save, missingKeys, safeName };

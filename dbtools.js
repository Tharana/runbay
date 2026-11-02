// Quick actions for the databases RunBay starts (mostly Docker presets): connection string, backup / restore, and a read-only browser.
const fs = require('fs');
const { spawn } = require('child_process');

const STD_PORTS = { 5432: 'postgres', 5433: 'postgres', 3306: 'mysql', 3307: 'mysql', 6379: 'redis', 27017: 'mongo' };
const IMAGE = /(?:^|\/)(postgres|postgis|mysql|mariadb|redis|valkey|mongo)(?::|@|$)/;
const KIND_OF_IMAGE = { postgres: 'postgres', postgis: 'postgres', mysql: 'mysql', mariadb: 'mysql', redis: 'redis', valkey: 'redis', mongo: 'mongo' };
const DEFAULT_PORT = { postgres: 5432, mysql: 3306, redis: 6379, mongo: 27017 };
const NAME_OK = /^[A-Za-z0-9][\w.-]{0,127}$/;

const cache = new Map();

// what database (if any) does this service run?
function describe(svc) {
  const key = `${svc.command}|${svc.port}`;
  if (cache.has(key)) return cache.get(key);
  const info = compute(svc);
  cache.set(key, info);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return info;
}

function compute(svc) {
  const cmd = String(svc.command || '');
  const tokens = cmd.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const clean = (t) => t.replace(/^["']|["']$/g, '');
  const dockerRun = tokens.some((t, i) => /^docker(\.exe)?$/i.test(clean(t)) && clean(tokens[i + 1] || '') === 'run');
  if (dockerRun) {
    let container = '';
    let hostPort = 0;
    const env = {};
    let image = '';
    for (let i = 0; i < tokens.length; i++) {
      const t = clean(tokens[i]);
      const next = clean(tokens[i + 1] || '');
      if (t === '--name') { container = next; i++; }
      else if (t.startsWith('--name=')) container = t.slice(7);
      else if (t === '-p' || t === '--publish') {
        const parts = next.split(':');
        if (!hostPort && parts.length >= 2) hostPort = Number(parts[parts.length - 2]) || 0;
        i++;
      } else if (t === '-e' || t === '--env') {
        const m = next.match(/^([^=]+)=(.*)$/);
        if (m) env[m[1]] = m[2];
        i++;
      } else if (!image && !t.startsWith('-') && IMAGE.test(t) && clean(tokens[i - 1] || '') !== '--name') {
        image = t;
      }
    }
    const kind = image ? KIND_OF_IMAGE[image.match(IMAGE)[1]] : null;
    if (!kind) return null;
    const port = hostPort || Number(svc.port) || DEFAULT_PORT[kind];
    const info = { kind, docker: true, container: NAME_OK.test(container) ? container : '', port };
    if (kind === 'postgres') {
      info.user = env.POSTGRES_USER || 'postgres';
      info.password = env.POSTGRES_PASSWORD || '';
      info.database = env.POSTGRES_DB || info.user;
    } else if (kind === 'mysql') {
      info.user = 'root';
      info.password = env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD || '';
      info.database = env.MYSQL_DATABASE || env.MARIADB_DATABASE || '';
    }
    return info;
  }
  const kind = STD_PORTS[Number(svc.port)];
  return kind ? { kind, docker: false, container: '', port: Number(svc.port) } : null;
}

function connectionString(info) {
  const enc = encodeURIComponent;
  const cred = info.user ? `${enc(info.user)}${info.password ? ':' + enc(info.password) : ''}@` : '';
  const host = `localhost:${info.port}`;
  switch (info.kind) {
    case 'postgres': return `postgresql://${cred}${host}${info.database ? '/' + enc(info.database) : ''}`;
    case 'mysql': return `mysql://${cred}${host}${info.database ? '/' + enc(info.database) : ''}`;
    case 'redis': return `redis://${host}`;
    default: return `mongodb://${host}`;
  }
}

// ---------- running docker commands ----------
const MAX_OUT = 4 * 1024 * 1024;

// docker <args>; stdout goes to a string, or to `out` (a writable stream); `input` is a readable stream for stdin
function docker(args, { input, out } = {}) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn('docker', args, { windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out: '', err: e.message });
    }
    let stdout = '';
    let stderr = '';
    if (out) p.stdout.pipe(out);
    else p.stdout.on('data', (d) => { if (stdout.length < MAX_OUT) stdout += d.toString('utf8'); });
    p.stderr.on('data', (d) => { if (stderr.length < 65536) stderr += d.toString('utf8'); });
    p.on('error', (e) => resolve({ code: -1, out: stdout, err: e.code === 'ENOENT' ? 'Docker is not installed or not on PATH.' : e.message }));
    p.on('close', (code) => resolve({ code, out: stdout, err: stderr.trim() }));
    if (input) { input.pipe(p.stdin); p.stdin.on('error', () => {}); }
  });
}

// ---------- backup / restore ----------
async function backup(info, file) {
  if (!info.docker || !info.container) return { ok: false, error: 'Backups need a database started with "docker run --name ...".' };
  if (info.kind === 'redis') {
    const s = await docker(['exec', info.container, 'redis-cli', 'SAVE']);
    if (s.code !== 0) return { ok: false, error: s.err || s.out || 'redis-cli SAVE failed.' };
    const c = await docker(['cp', `${info.container}:/data/dump.rdb`, file]);
    return c.code === 0 ? { ok: true } : { ok: false, error: c.err || 'Could not copy dump.rdb.' };
  }
  if (info.kind === 'mongo') return { ok: false, error: 'MongoDB backups are not supported yet.' };
  const tries = info.kind === 'postgres'
    ? [['pg_dumpall', '-U', info.user, '--clean', '--if-exists']]
    : [['mysqldump', '-u', info.user, '--all-databases', '--single-transaction', '--routines'], ['mariadb-dump', '-u', info.user, '--all-databases', '--single-transaction', '--routines']];
  let last = null;
  for (const t of tries) {
    const env = info.kind === 'mysql' && info.password ? ['-e', `MYSQL_PWD=${info.password}`] : [];
    const out = fs.createWriteStream(file);
    const done = new Promise((res) => { out.on('close', res); out.on('error', res); });
    const r = await docker(['exec', ...env, info.container, ...t], { out });
    await done;
    if (r.code === 0) return { ok: true };
    last = r;
    try { fs.unlinkSync(file); } catch {}
    if (r.code !== 127 && !/not found|executable file/i.test(r.err)) break;
  }
  return { ok: false, error: (last && (last.err || 'The dump command failed.')) || 'The dump command failed.' };
}

async function restore(info, file) {
  if (!info.docker || !info.container) return { ok: false, error: 'Restore needs a database started with "docker run --name ...".' };
  if (info.kind === 'postgres') {
    const r = await docker(['exec', '-i', info.container, 'psql', '-U', info.user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=0'], { input: fs.createReadStream(file) });
    return r.code === 0 ? { ok: true, note: r.err ? r.err.split('\n').slice(-3).join('\n') : '' } : { ok: false, error: r.err || 'psql failed.' };
  }
  if (info.kind === 'mysql') {
    const env = info.password ? ['-e', `MYSQL_PWD=${info.password}`] : [];
    for (const bin of ['mysql', 'mariadb']) {
      const r = await docker(['exec', '-i', ...env, info.container, bin, '-u', info.user], { input: fs.createReadStream(file) });
      if (r.code === 0) return { ok: true };
      if (!/not found|executable file/i.test(r.err) && r.code !== 127) return { ok: false, error: r.err || 'mysql failed.' };
    }
    return { ok: false, error: 'No mysql client found in the container.' };
  }
  return { ok: false, error: 'Restore is only available for PostgreSQL and MySQL / MariaDB.' };
}

// ---------- read-only browser ----------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function parseTsv(text) {
  return text.split(/\r?\n/).filter((l, i, a) => l !== '' || i < a.length - 1).filter(Boolean)
    .map((l) => l.split('\t').map((c) => c.replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')));
}

const IDENT = /^[A-Za-z0-9_$-]{1,64}$/;
const tableOk = (t) => typeof t === 'string' && t.split('.').length <= 2 && t.split('.').every((p) => IDENT.test(p));
const ROW_LIMIT = 100;

// action: 'dbs' | 'tables' | 'rows' | 'keys' | 'key'
async function query(info, action, args = {}) {
  if (!info.docker || !info.container) return { ok: false, error: 'Browsing needs a database started with "docker run --name ...".' };
  const c = info.container;
  const grid = (rows) => ({ ok: true, columns: rows[0] || [], rows: rows.slice(1) });

  if (info.kind === 'postgres') {
    const db = args.db && IDENT.test(args.db) ? args.db : info.database || 'postgres';
    const run = async (sql) => {
      const r = await docker(['exec', c, 'psql', '-U', info.user, '-d', db, '-X', '-A', '--csv', '-c', sql]);
      return r.code === 0 ? grid(parseCsv(r.out)) : { ok: false, error: r.err || 'Query failed.' };
    };
    if (action === 'dbs') return run('SELECT datname AS database FROM pg_database WHERE NOT datistemplate ORDER BY 1');
    if (action === 'tables') return run("SELECT schemaname || '.' || relname AS \"table\", n_live_tup AS approx_rows FROM pg_stat_user_tables ORDER BY 1");
    if (action === 'rows' && tableOk(args.table)) {
      const q = args.table.split('.').map((p) => `"${p}"`).join('.');
      return run(`SELECT * FROM ${q} LIMIT ${ROW_LIMIT}`);
    }
  } else if (info.kind === 'mysql') {
    const db = args.db && IDENT.test(args.db) ? args.db : info.database;
    const env = info.password ? ['-e', `MYSQL_PWD=${info.password}`] : [];
    const run = async (sql) => {
      for (const bin of ['mysql', 'mariadb']) {
        const r = await docker(['exec', ...env, c, bin, '-u', info.user, '-B', ...(db ? ['-D', db] : []), '-e', sql]);
        if (r.code === 0) return grid(parseTsv(r.out));
        if (!/not found|executable file/i.test(r.err) && r.code !== 127) return { ok: false, error: r.err || 'Query failed.' };
      }
      return { ok: false, error: 'No mysql client found in the container.' };
    };
    if (action === 'dbs') return run('SHOW DATABASES');
    if (action === 'tables') return db ? run(`SELECT table_name AS \`table\`, table_rows AS approx_rows FROM information_schema.tables WHERE table_schema = '${db}' ORDER BY 1`) : { ok: false, error: 'Pick a database first.' };
    if (action === 'rows' && tableOk(args.table) && db) return run(`SELECT * FROM \`${db}\`.\`${args.table}\` LIMIT ${ROW_LIMIT}`);
  } else if (info.kind === 'redis') {
    if (action === 'keys') {
      const r = await docker(['exec', c, 'redis-cli', '--scan', '--count', '200']);
      if (r.code !== 0) return { ok: false, error: r.err || 'redis-cli failed.' };
      return { ok: true, columns: ['key'], rows: r.out.split(/\r?\n/).filter(Boolean).slice(0, 200).map((k) => [k]) };
    }
    if (action === 'key' && typeof args.key === 'string' && args.key.length < 512) {
      const t = await docker(['exec', c, 'redis-cli', 'TYPE', args.key]);
      const type = t.out.trim();
      const cmd = { string: ['GET'], hash: ['HGETALL'], list: ['LRANGE', '0', '49'], set: ['SMEMBERS'], zset: ['ZRANGE', '0', '49', 'WITHSCORES'] }[type];
      if (!cmd) return { ok: true, text: `type: ${type || 'none'}` };
      const v = await docker(['exec', c, 'redis-cli', ...cmd.slice(0, 1), args.key, ...cmd.slice(1)]);
      return { ok: true, text: `type: ${type}\n\n${v.out.slice(0, 20000)}` };
    }
  }
  return { ok: false, error: 'Not supported for this database.' };
}

module.exports = { describe, connectionString, backup, restore, query };

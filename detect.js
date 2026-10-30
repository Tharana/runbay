// Scans an app folder and works out which servers it contains
// (Next.js, NestJS/Node API, PHP/Laravel, ...), their run command and port.
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.claude', '.agents', 'vendor', 'public', 'src', 'img']);

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
const exists = (f) => fs.existsSync(f);

function envPort(dir) {
  for (const n of ['.env', '.env.local', '.env.development']) {
    const m = readText(path.join(dir, n)).match(/^\s*PORT\s*=\s*"?(\d+)"?/m);
    if (m) return m[1];
  }
  return '';
}

// nearest lock file between dir and root decides the package manager
function pkgManager(dir, root) {
  let d = dir;
  for (;;) {
    if (exists(path.join(d, 'pnpm-lock.yaml'))) return 'pnpm';
    if (exists(path.join(d, 'yarn.lock'))) return 'yarn';
    if (exists(path.join(d, 'bun.lockb')) || exists(path.join(d, 'bun.lock'))) return 'bun';
    if (exists(path.join(d, 'package-lock.json'))) return 'npm';
    if (d === root || path.dirname(d) === d) return 'npm';
    d = path.dirname(d);
  }
}

function detectNode(dir, root) {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts || {};
  const script = ['dev', 'start:dev', 'develop', 'serve', 'start'].find((s) => scripts[s]);
  if (!script) return null;

  let kind = 'Node';
  let port = '';
  const body = scripts[script];
  const flag = body.match(/(?:\s-p|--port)[ =](\d+)/);
  if (flag) port = flag[1];

  if (deps.next) { kind = 'Next.js'; port = port || envPort(dir) || '3000'; }
  else if (deps['@nestjs/core']) { kind = 'NestJS'; port = port || envPort(dir) || '3000'; }
  else if (deps.vite) { kind = 'Vite'; port = port || '5173'; }
  else if (deps.express || deps.fastify || deps.koa) { kind = 'Node API'; port = port || envPort(dir) || '3000'; }
  else port = port || envPort(dir);

  const isFront = kind === 'Next.js' || kind === 'Vite' || /front|web|client|ui/i.test(path.basename(dir));
  const pm = pkgManager(dir, root);
  let command = pm === 'yarn' || pm === 'bun' ? `${pm} ${script}` : `${pm} run ${script}`;
  if (!exists(path.join(dir, 'node_modules'))) command = `${pm} install && ${command}`;

  return { role: isFront ? 'Frontend' : 'Backend', kind, name: `${isFront ? 'Frontend' : 'Backend'} (${kind})`, cwd: dir, command, port, env: '', pkg };
}

function detectPhp(dir) {
  const composer = readJson(path.join(dir, 'composer.json'));
  const hasArtisan = exists(path.join(dir, 'artisan'));
  const pubIndex = exists(path.join(dir, 'public', 'index.php'));
  const rootIndex = exists(path.join(dir, 'index.php'));
  if (!composer && !hasArtisan && !pubIndex && !rootIndex) return null;
  const isFront = /front|web|client|ui/i.test(path.basename(dir));
  if (hasArtisan) {
    return { role: isFront ? 'Frontend' : 'Backend', kind: 'Laravel', name: `${isFront ? 'Frontend' : 'Backend'} (Laravel)`, cwd: dir, command: 'php artisan serve --port=8000', port: '8000', env: '' };
  }
  return {
    role: isFront ? 'Frontend' : 'Backend', kind: 'PHP', name: `${isFront ? 'Frontend' : 'Backend'} (PHP)`, cwd: dir,
    command: `php -S localhost:8000${pubIndex ? ' -t public' : ''}`, port: '8000', env: '',
  };
}

const FRONT_RE = /front|web|client|ui/i;

// shared shape for the non-Node detectors below
function svc(dir, kind, command, port, extra = {}) {
  const role = extra.role || (FRONT_RE.test(path.basename(dir)) ? 'Frontend' : 'Backend');
  return { role, kind, name: `${role} (${kind})`, cwd: dir, command, port: String(port || ''), env: '', ...extra };
}

function detectPython(dir) {
  const text = ['requirements.txt', 'pyproject.toml', 'Pipfile'].map((f) => readText(path.join(dir, f))).join('\n').toLowerCase();
  const py = exists(path.join(dir, '.venv', 'Scripts', 'python.exe')) ? '.venv\\Scripts\\python'
    : exists(path.join(dir, 'venv', 'Scripts', 'python.exe')) ? 'venv\\Scripts\\python' : 'python';
  const has = (f) => exists(path.join(dir, f));
  if (has('manage.py')) {
    const port = envPort(dir) || '8000';
    return svc(dir, 'Django', `${py} manage.py runserver ${port}`, port);
  }
  if (/fastapi/.test(text)) {
    const mod = has('main.py') ? 'main:app' : has(path.join('app', 'main.py')) ? 'app.main:app' : 'main:app';
    const port = envPort(dir) || '8000';
    return svc(dir, 'FastAPI', `${py} -m uvicorn ${mod} --reload --port ${port}`, port);
  }
  if (/flask/.test(text)) {
    const port = envPort(dir) || '5000';
    const app = has('app.py') || has('wsgi.py') ? '' : has('main.py') ? ' --app main' : '';
    return svc(dir, 'Flask', `${py} -m flask${app} run --port ${port}`, port);
  }
  const entry = ['app.py', 'main.py', 'server.py'].find(has);
  if (entry && text) return svc(dir, 'Python', `${py} ${entry}`, envPort(dir));
  return null;
}

function detectGo(dir) {
  if (!exists(path.join(dir, 'go.mod'))) return null;
  let target = '.';
  if (!exists(path.join(dir, 'main.go'))) {
    try {
      const cmd = fs.readdirSync(path.join(dir, 'cmd'), { withFileTypes: true }).find((e) => e.isDirectory());
      if (cmd) target = `./cmd/${cmd.name}`;
    } catch {}
  }
  const m = readText(path.join(dir, 'main.go')).match(/":(\d{4,5})"/);
  const port = envPort(dir) || (m && m[1]) || '8080';
  return svc(dir, 'Go', `go run ${target}`, port);
}

function detectDotnet(dir) {
  let proj = '';
  try { proj = fs.readdirSync(dir).find((f) => f.endsWith('.csproj')) || ''; } catch {}
  if (!proj || !/Microsoft\.NET\.Sdk\.Web/.test(readText(path.join(dir, proj)))) return null;
  const ls = readJson(path.join(dir, 'Properties', 'launchSettings.json'));
  let port = '5000';
  for (const p of Object.values((ls && ls.profiles) || {})) {
    const m = String(p.applicationUrl || '').match(/http:\/\/[^:;]+:(\d+)/);
    if (m) { port = m[1]; break; }
  }
  return svc(dir, '.NET', 'dotnet run', port);
}

function detectJava(dir) {
  const has = (f) => exists(path.join(dir, f));
  let command = '';
  if (has('pom.xml') && /spring-boot/.test(readText(path.join(dir, 'pom.xml')))) command = has('mvnw.cmd') ? 'mvnw.cmd spring-boot:run' : 'mvn spring-boot:run';
  else {
    const g = ['build.gradle', 'build.gradle.kts'].find(has);
    if (g && /org\.springframework\.boot|spring-boot/.test(readText(path.join(dir, g)))) command = has('gradlew.bat') ? 'gradlew.bat bootRun' : 'gradle bootRun';
  }
  if (!command) return null;
  const res = path.join(dir, 'src', 'main', 'resources');
  const props = readText(path.join(res, 'application.properties')).match(/server\.port\s*[=:]\s*(\d+)/);
  const yml = readText(path.join(res, 'application.yml')).match(/^\s*port:\s*(\d+)/m);
  return svc(dir, 'Spring Boot', command, (props && props[1]) || (yml && yml[1]) || '8080');
}

// databases/queues usually live here, so it is listed before the app servers
function detectCompose(dir) {
  const f = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find((n) => exists(path.join(dir, n)));
  if (!f) return null;
  const m = readText(path.join(dir, f)).match(/-\s*["']?(?:\d+\.\d+\.\d+\.\d+:)?(\d+):\d+/);
  return svc(dir, 'Docker', 'docker compose up', m ? m[1] : '', { role: 'Infra', name: 'Docker Compose', stopCommand: 'docker compose down' });
}

function findNgrokDomain(root) {
  const files = [];
  for (const dir of [root, path.join(root, 'backend'), path.join(root, 'frontend')]) {
    try {
      for (const f of fs.readdirSync(dir)) if (/\.(bat|cmd|ps1|sh)$|^\.env/i.test(f)) files.push(path.join(dir, f));
    } catch {}
  }
  for (const f of files) {
    const t = readText(f);
    const m =
      t.match(/NGROK_DOMAIN\s*=\s*"?([a-z0-9.-]+\.ngrok[a-z.-]*)/i) ||
      t.match(/--(?:url|domain)[= ]+"?(?:https?:\/\/)?([a-z0-9.-]+\.ngrok[a-z.-]*)/i);
    if (m) return m[1];
  }
  return '';
}

const MONO = new Set(['apps', 'packages', 'services', 'servers', 'projects', 'modules']);
const detectDir = (dir, root) => detectNode(dir, root) || detectPhp(dir) || detectPython(dir) || detectGo(dir) || detectDotnet(dir) || detectJava(dir);

// one level of sub-folders, plus one more level inside monorepo folders (apps/, packages/, ...)
function scanSubs(root, dir, depth, found) {
  let subs = [];
  try {
    subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !SKIP.has(d.name) && !d.name.startsWith('.'));
  } catch {}
  for (const d of subs) {
    const sub = path.join(dir, d.name);
    const s = detectDir(sub, root);
    const c = detectCompose(sub);
    if (s) found.push(s);
    if (c) found.push(c);
    if (!s && !c && depth < 2 && MONO.has(d.name)) scanSubs(root, sub, depth + 1, found);
  }
}

function detectFolder(root) {
  const found = [];
  scanSubs(root, root, 1, found);
  // single-app folder (no sub-apps): the root itself is the service
  if (!found.some((s) => s.role !== 'Infra')) {
    const s = detectDir(root, root);
    if (s) found.push(s);
  }
  const rc = detectCompose(root);
  if (rc) found.push(rc);

  // infra first, then backend, then frontend
  const rank = { Infra: 0, Backend: 1, Frontend: 2 };
  found.sort((a, b) => rank[a.role] - rank[b.role]);
  // monorepos repeat names: tell apart by folder
  const count = {};
  for (const s of found) count[s.name] = (count[s.name] || 0) + 1;
  for (const s of found) if (count[s.name] > 1) s.name = `${s.name} · ${path.basename(s.cwd)}`;

  // monorepo apps often share a default port (3000): give repeats the next free one (passed as PORT)
  const used = new Set();
  for (const s of found) {
    if (!s.port) continue;
    let n = Number(s.port);
    while (used.has(n)) n++;
    s.port = String(n);
    used.add(n);
  }

  const rootPkg = readJson(path.join(root, 'package.json')) || {};
  const services = found.map(({ name, cwd, command, port, env, stopCommand }) => ({ name, cwd, command, port, env, stopCommand }));

  // ngrok tunnels the backend (webhooks etc.); fall back to the first app service
  const apps = found.filter((s) => s.role !== 'Infra');
  const target = apps.find((s) => s.role === 'Backend' && s.port) || apps.find((s) => s.port);
  if (target) {
    const domain = findNgrokDomain(root);
    services.push({
      name: 'ngrok',
      cwd: root,
      command: `ngrok http ${domain ? `--url=${domain} ` : ''}${target.port} --log=stdout`,
      port: '4040',
      env: '',
    });
  }

  return {
    name: rootPkg.name ? rootPkg.name.replace(/[-_]/g, ' ') : path.basename(root),
    description: rootPkg.description || [...new Set(found.map((s) => s.kind))].join(' + '),
    notes: '',
    services,
  };
}

module.exports = { detectFolder, pkgManager };

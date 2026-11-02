// Local domains with HTTPS: a private CA, a certificate for your domains, a reverse proxy and the hosts-file entries.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const forge = require('node-forge');

const CA_NAME = 'RunBay Local CA';
const HOSTS_BEGIN = '# BEGIN RunBay local domains';
const HOSTS_END = '# END RunBay local domains';
const HOSTS_FILE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
// only reserved names, so a typo can never hijack a real website
const ALLOWED_TLDS = new Set(['test', 'localhost', 'internal']);

// returns the cleaned domain, or '' when it is not allowed
function cleanDomain(input) {
  const d = String(input || '').trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) || d.length > 120) return '';
  return ALLOWED_TLDS.has(d.split('.').pop()) ? d : '';
}

const needsHostsEntry = (d) => !d.endsWith('.localhost'); // browsers resolve *.localhost on their own

// ---------- hosts file (pure text helpers, easy to test) ----------
function stripBlock(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const l of lines) {
    if (l.trim() === HOSTS_BEGIN) { skipping = true; continue; }
    if (skipping) { if (l.trim() === HOSTS_END) skipping = false; continue; }
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return { text: out.join(eol), eol };
}

function withBlock(text, domains) {
  const { text: base, eol } = stripBlock(text);
  const list = [...new Set(domains.filter(needsHostsEntry))];
  if (!list.length) return base + eol;
  return base + eol + HOSTS_BEGIN + eol + list.map((d) => `127.0.0.1 ${d}`).join(eol) + eol + HOSTS_END + eol;
}

function domainsInHosts(text) {
  const found = new Set();
  let inside = false;
  for (const l of text.split(/\r?\n/)) {
    if (l.trim() === HOSTS_BEGIN) { inside = true; continue; }
    if (l.trim() === HOSTS_END) { inside = false; continue; }
    if (inside) { const m = l.trim().match(/^127\.0\.0\.1\s+(\S+)/); if (m) found.add(m[1]); }
  }
  return found;
}

module.exports = function createDomains({ dir, getRoutes }) {
  const caCert = path.join(dir, 'ca.pem');
  const caKey = path.join(dir, 'ca-key.pem');
  const leafCert = path.join(dir, 'leaf.pem');
  const leafKey = path.join(dir, 'leaf-key.pem');
  const leafMeta = path.join(dir, 'leaf.json');

  const state = { running: false, port: 443, error: '', trusted: false, hostsMissing: [], caExists: fs.existsSync(caCert) };
  let httpsServer = null;
  let httpServer = null;
  let servedKey = '';

  // ---------- certificates ----------
  const serial = () => '01' + crypto.randomBytes(8).toString('hex');

  function ensureCA() {
    if (fs.existsSync(caCert) && fs.existsSync(caKey)) return;
    fs.mkdirSync(dir, { recursive: true });
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400000);
    const attrs = [{ name: 'commonName', value: CA_NAME }, { name: 'organizationName', value: 'RunBay' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    fs.writeFileSync(caCert, forge.pki.certificateToPem(cert));
    fs.writeFileSync(caKey, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
    state.caExists = true;
  }

  // one certificate that covers every configured domain (and their subdomains)
  function ensureLeaf(domains) {
    const key = [...domains].sort().join(',');
    try {
      const meta = JSON.parse(fs.readFileSync(leafMeta, 'utf8'));
      if (meta.key === key && meta.notAfter - Date.now() > 30 * 86400000 && fs.existsSync(leafCert) && fs.existsSync(leafKey)) return key;
    } catch {}
    ensureCA();
    const ca = forge.pki.certificateFromPem(fs.readFileSync(caCert, 'utf8'));
    const caPriv = forge.pki.privateKeyFromPem(fs.readFileSync(caKey, 'utf8'));
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 397 * 86400000); // browsers refuse longer
    const names = domains.length ? domains : ['localhost'];
    cert.setSubject([{ name: 'commonName', value: names[0] }]);
    cert.setIssuer(ca.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: names.flatMap((d) => [{ type: 2, value: d }, { type: 2, value: `*.${d}` }]) },
    ]);
    cert.sign(caPriv, forge.md.sha256.create());
    fs.writeFileSync(leafCert, forge.pki.certificateToPem(cert) + fs.readFileSync(caCert, 'utf8'));
    fs.writeFileSync(leafKey, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
    fs.writeFileSync(leafMeta, JSON.stringify({ key, notAfter: cert.validity.notAfter.getTime() }));
    return key;
  }

  const currentDomains = () => getRoutes().map((r) => r.domain);

  // call after the set of domains changed; swaps the live certificate without restarting the proxy
  function sync() {
    if (!httpsServer) return;
    try {
      const key = ensureLeaf(currentDomains());
      if (key !== servedKey) {
        httpsServer.setSecureContext({ key: fs.readFileSync(leafKey), cert: fs.readFileSync(leafCert) });
        servedKey = key;
      }
    } catch (e) {
      state.error = `Certificate problem: ${e.message}`;
    }
  }

  // ---------- Windows trust store (current user: no admin rights, Windows asks the user to confirm) ----------
  const certutil = (args) => new Promise((resolve) => {
    execFile('certutil.exe', args, { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') }));
  });

  async function refreshStatus() {
    state.caExists = fs.existsSync(caCert);
    state.trusted = state.caExists ? (await certutil(['-user', '-store', 'Root', CA_NAME])).ok : false;
    try {
      const have = domainsInHosts(fs.readFileSync(HOSTS_FILE, 'utf8'));
      state.hostsMissing = currentDomains().filter((d) => needsHostsEntry(d) && !have.has(d));
    } catch {
      state.hostsMissing = currentDomains().filter(needsHostsEntry);
    }
    return state;
  }

  async function trust() {
    try { ensureCA(); } catch (e) { return { ok: false, error: e.message }; }
    const r = await certutil(['-user', '-addstore', '-f', 'Root', caCert]);
    await refreshStatus();
    return r.ok ? { ok: true } : { ok: false, error: 'Windows did not add the certificate (the confirmation was declined or blocked).' };
  }

  async function untrust() {
    const r = await certutil(['-user', '-delstore', 'Root', CA_NAME]);
    await refreshStatus();
    return { ok: r.ok || !state.trusted };
  }

  // ---------- hosts file (needs administrator rights, so Windows shows its UAC prompt) ----------
  function writeHostsElevated(newText) {
    const tmp = path.join(os.tmpdir(), `runbay-hosts-${process.pid}.txt`);
    fs.writeFileSync(tmp, newText);
    const q = (s) => s.replace(/'/g, "''");
    const inner = `Copy-Item -LiteralPath '${q(tmp)}' -Destination '${q(HOSTS_FILE)}' -Force; ipconfig /flushdns | Out-Null`;
    const script = `try { Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',"${inner.replace(/"/g, '`"')}" } catch { exit 2 }`;
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 180000 }, (err) => {
        try { fs.unlinkSync(tmp); } catch {}
        resolve(!err);
      });
    });
  }

  async function setHosts(domains) {
    let current = '';
    try { current = fs.readFileSync(HOSTS_FILE, 'utf8'); } catch (e) { return { ok: false, error: `Cannot read the hosts file: ${e.message}` }; }
    const next = withBlock(current, domains);
    if (next === current) { await refreshStatus(); return { ok: true }; }
    const started = await writeHostsElevated(next);
    await refreshStatus();
    const have = (() => { try { return domainsInHosts(fs.readFileSync(HOSTS_FILE, 'utf8')); } catch { return new Set(); } })();
    const ok = domains.filter(needsHostsEntry).every((d) => have.has(d));
    return ok ? { ok: true } : { ok: false, error: started ? 'The hosts file was not changed.' : 'Administrator permission was declined, so the hosts file was not changed.' };
  }

  const applyHosts = () => setHosts(currentDomains());
  const removeHosts = () => setHosts([]);

  // ---------- reverse proxy ----------
  const find = (host) => {
    const h = String(host || '').split(':')[0].toLowerCase();
    return getRoutes().find((r) => h === r.domain || h.endsWith('.' + r.domain)) || null;
  };

  const page = (res, code, title, text) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px Segoe UI,sans-serif;background:#0a0b10;color:#eceef5;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:460px"><h2>${title}</h2><p style="color:#b4b9cc">${text}</p><p style="color:#7a8097">RunBay local domains</p></div>`);
  };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function onRequest(req, res) {
    const route = find(req.headers.host);
    if (!route) return page(res, 404, 'Unknown domain', `${esc(req.headers.host || '')} is not one of your RunBay domains.`);
    if (!route.port) return page(res, 502, `${esc(route.label)} is not running`, `Start it in RunBay, then reload this page.`);
    const headers = { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host, 'x-forwarded-for': req.socket.remoteAddress };
    const up = http.request({ host: 'localhost', port: route.port, method: req.method, path: req.url, headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) page(res, 502, `${esc(route.label)} did not answer`, `Nothing is responding on port ${route.port} yet.`); else res.destroy(); });
    req.pipe(up);
  }

  // WebSockets (hot reload) are piped through as raw sockets
  function onUpgrade(req, socket, head) {
    const route = find(req.headers.host);
    if (!route || !route.port) return socket.destroy();
    const up = net.connect({ host: 'localhost', port: route.port }, () => {
      const headers = { ...req.headers, 'x-forwarded-proto': 'https' };
      const raw = `${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n') + '\r\n\r\n';
      up.write(raw);
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  }

  function listen(server, port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
  }

  async function start(port) {
    await stop();
    state.error = '';
    state.port = Number(port) || 443;
    try {
      ensureCA();
      servedKey = ensureLeaf(currentDomains());
      httpsServer = https.createServer({ key: fs.readFileSync(leafKey), cert: fs.readFileSync(leafCert) }, onRequest);
      httpsServer.on('upgrade', onUpgrade);
      await listen(httpsServer, state.port);
      state.running = true;
    } catch (e) {
      try { httpsServer && httpsServer.close(); } catch {}
      httpsServer = null;
      state.running = false;
      state.error = e.code === 'EADDRINUSE' ? `Port ${state.port} is already used by another program. Choose another port below.`
        : e.code === 'EACCES' ? `Windows does not allow RunBay to use port ${state.port}. Choose another port below.` : e.message;
      return { ok: false, error: state.error };
    }
    // plain http:// typed into the address bar goes to https:// (best effort)
    if (state.port === 443) {
      httpServer = http.createServer((req, res) => {
        res.writeHead(301, { Location: `https://${String(req.headers.host || '').split(':')[0]}${req.url}` });
        res.end();
      });
      httpServer.on('error', () => { httpServer = null; });
      listen(httpServer, 80).catch(() => { httpServer = null; });
    }
    return { ok: true };
  }

  function stop() {
    return new Promise((resolve) => {
      state.running = false;
      const servers = [httpsServer, httpServer].filter(Boolean);
      httpsServer = null;
      httpServer = null;
      if (!servers.length) return resolve();
      let n = servers.length;
      for (const s of servers) {
        try { s.closeAllConnections && s.closeAllConnections(); s.close(() => { if (--n === 0) resolve(); }); } catch { if (--n === 0) resolve(); }
      }
    });
  }

  return {
    cleanDomain,
    caPath: () => (fs.existsSync(caCert) ? caCert : null),
    urlFor: (d) => `https://${d}${state.port === 443 ? '' : ':' + state.port}`,
    status: () => state,
    start, stop, sync, refreshStatus, trust, untrust, applyHosts, removeHosts,
  };
};

module.exports.cleanDomain = cleanDomain;
module.exports.withBlock = withBlock;
module.exports.domainsInHosts = domainsInHosts;
module.exports.stripBlock = stripBlock;

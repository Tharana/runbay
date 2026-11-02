const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let items = [];
let shown = [];
let pick = 0;

// every word typed must appear in the name, group or description
function match(it, q) {
  const hay = `${it.name} ${it.group || ''} ${it.sub}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function filtered() {
  const q = $('#q').value.trim().toLowerCase();
  const list = items.filter((it) => !q || match(it, q));
  const rank = (it) => {
    const n = it.name.toLowerCase();
    return (q && n.startsWith(q) ? 0 : 4) + (it.type === 'workspace' ? 0 : 2) + (it.favorite ? 0 : 1);
  };
  return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function paint() {
  shown = filtered();
  if (pick >= shown.length) pick = Math.max(0, shown.length - 1);
  $('#list').innerHTML = shown.length
    ? shown.map((it, i) => `<div class="it ${i === pick ? 'on' : ''}" data-i="${i}">
        <span class="dot ${it.running ? 'running' : ''}"></span>
        <div class="txt"><div class="nm">${esc(it.name)}${it.type === 'workspace' ? '<span class="ws">Workspace</span>' : ''}</div><div class="sub">${esc(it.sub)}</div></div>
        <span class="act ${it.action}">${it.action === 'stop' ? '↵ Stop' : '↵ Run'}</span></div>`).join('')
    : `<div class="none">${items.length ? 'No match.' : 'No apps yet. Add one in RunBay first.'}</div>`;
  const on = document.querySelector('.it.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

async function open() {
  $('#q').value = '';
  pick = 0;
  items = await launcher.list();
  paint();
  $('#q').focus();
}

function run(showInApp) {
  const it = shown[pick];
  if (!it) return;
  if (showInApp) launcher.showInApp(it.type, it.id);
  else launcher.toggle(it.type, it.id);
}

$('#q').addEventListener('input', () => { pick = 0; paint(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); launcher.hide(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); pick = Math.min(shown.length - 1, pick + 1); paint(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pick = Math.max(0, pick - 1); paint(); }
  else if (e.key === 'Enter') { e.preventDefault(); run(e.shiftKey); }
});
$('#list').addEventListener('click', (e) => {
  const row = e.target.closest('.it');
  if (!row) return;
  pick = Number(row.dataset.i);
  run(false);
});

launcher.onOpen(open);
open();

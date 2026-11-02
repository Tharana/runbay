// "Explain this error": builds a redacted description of an error from the logs and asks Claude about it.
// Nothing is sent unless the user presses the button, and the exact text that would be sent is shown first.
const Anthropic = require('@anthropic-ai/sdk');

const MODELS = {
  'claude-opus-5-5': 'Claude Opus 5.5 - most capable',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 - balanced',
  'claude-haiku-5-5': 'Claude Haiku 5.5 - fastest and cheapest',
};
const DEFAULT_MODEL = 'claude-opus-5-5';

const SYSTEM = `You help a developer debug a problem in a local development server. You receive the error that a dev server printed, a little of the output around it, and the project's main dependencies.

Explain in plain language and be concrete. Stay with the evidence: when the cause is uncertain, say so and name what to check instead of guessing. The developer is on Windows (PowerShell or cmd), so give commands for that.

Answer in Markdown with exactly these headings:
**What happened** - one or two sentences.
**Likely cause** - the most probable reason, and why you think so.
**How to fix** - numbered steps with exact commands or code in fenced blocks.
**If that does not fix it** - one to three things to check next.

Keep it short (about 250 words) unless the error really needs more. Values shown as [hidden] were removed for privacy; never ask the developer to paste secrets.`;

// ---------- privacy: remove secrets before anything leaves the PC ----------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BORING = new Set(['true', 'false', 'null', 'localhost', 'development', 'production', 'test', 'debug', 'info', 'warn', 'error', 'admin', 'postgres', 'password']);

function makeRedactor(secretValues) {
  const values = [...new Set(secretValues.map((v) => String(v)).filter((v) => v.length >= 6 && !/^\d+$/.test(v) && !BORING.has(v.toLowerCase())))]
    .sort((a, b) => b.length - a.length);
  let count = 0;
  const sub = (re, repl) => (text) => text.replace(re, (...a) => { count++; return typeof repl === 'function' ? repl(...a) : repl; });
  const steps = [
    ...values.map((v) => sub(new RegExp(escapeRe(v), 'g'), '[hidden]')),
    sub(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\/\s:@]+):([^\/\s@]+)@/gi, '$1$2:[hidden]@'),
    sub(/\bBearer\s+[A-Za-z0-9._~+\/=-]{10,}/g, 'Bearer [hidden]'),
    sub(/\b(?:sk-ant-[\w-]{10,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[baprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,})/g, '[hidden]'),
    sub(/\b([\w.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|private[_-]?key|credential|authorization)[\w.-]*)(\s*[=:]\s*)(["']?)([^\s"',;]{4,})\3/gi, (m, k, sep, q) => `${k}${sep}${q}[hidden]${q}`),
    sub(/\b[a-f0-9]{32,}\b/gi, '[hidden]'),
    sub(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g, '[hidden]'),
    sub(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s'")]+/gi, '$1<user>'),
  ];
  return {
    apply: (text) => steps.reduce((t, f) => f(t), String(text)),
    count: () => count,
  };
}

// ---------- the text that is shown to the user and sent ----------
function buildPrompt({ project, service, command, folder, runtime, status, exitCode, deps, lines }) {
  const body = lines.map((l) => (l.mark ? `>>> ${l.text}` : `    ${l.text}`)).join('\n');
  return [
    `App: ${project} > ${service}`,
    `Command: ${command || '(none)'}`,
    folder ? `Project folder: ${folder}` : '',
    `Environment: Windows, local development${runtime ? `, ${runtime}` : ''}`,
    status === 'crashed' ? `The process exited${exitCode !== null && exitCode !== undefined ? ` with code ${exitCode}` : ''}.` : '',
    deps && deps.length ? `Main dependencies: ${deps.join(', ')}` : '',
    '',
    'Output around the error (the line marked >>> is the one the developer clicked):',
    '```',
    body,
    '```',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

// ---------- the call ----------
class AiError extends Error {}

function friendly(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key. Check it in Settings.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use that model.';
  if (e instanceof Anthropic.NotFoundError) return 'That model is not available for this key. Pick another one in Settings.';
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited by Anthropic. Wait a moment and try again.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach Anthropic. Check your internet connection.';
  if (e instanceof Anthropic.BadRequestError) return `Anthropic did not accept the request: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `Anthropic error ${e.status || ''}: ${e.message}`;
  return e && e.message ? e.message : String(e);
}

async function ask({ apiKey, model, prompt }) {
  if (!MODELS[model]) model = DEFAULT_MODEL;
  const client = new Anthropic({ ...(apiKey ? { apiKey } : {}), timeout: 120000, maxRetries: 2 });
  const base = {
    model,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort: 'low' }, // an explanation does not need deep reasoning
  };
  // if a safety classifier declines, let the API retry on a fallback model (not offered for Haiku)
  const withFallback = model === 'claude-opus-5-5' || model === 'claude-sonnet-5-5';
  let msg;
  try {
    msg = withFallback
      ? await client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(base);
  } catch (e) {
    if (withFallback && e instanceof Anthropic.BadRequestError) msg = await client.messages.create(base);
    else return { ok: false, error: friendly(e) };
  }
  if (msg.stop_reason === 'refusal') {
    return { ok: false, error: 'Claude declined to answer this one (its safety filter stepped in). Try a different error line.' };
  }
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) return { ok: false, error: 'Claude returned no text. Try again.' };
  return {
    ok: true,
    text: msg.stop_reason === 'max_tokens' ? `${text}\n\n_(The answer was cut off.)_` : text,
    model: msg.model || model,
    usage: msg.usage ? { input: msg.usage.input_tokens, output: msg.usage.output_tokens } : null,
  };
}

module.exports = { MODELS, DEFAULT_MODEL, makeRedactor, buildPrompt, ask, AiError };

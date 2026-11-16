/*
 The one model adapter for jobs. Ollama on localhost, JSON-schema constrained
 output through `format`. Before a real call it looks at what is resident and
 refuses rather than load a second large model on top of one already held.

 The adapter is a plain async function `({ model, system, prompt, schema }) =>
 string`, so the runner takes any stub in its place.
*/
export const DEFAULT_MODEL = 'qwen3.5:27b';
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
const GIB = 1024 ** 3;
export const MAX_RESPONSE_CHARS = 256 * 1024;
/* A 48 GiB machine: the target plus whatever is resident must stay under this. */
export const DEFAULT_BUDGET_BYTES = 36 * GIB;

export class ModelRefusal extends Error {
  constructor(message) { super(message); this.name = 'ModelRefusal'; }
}

async function getJson(fetchImpl, url, what) {
  let response;
  try { response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) }); }
  catch (error) { throw new ModelRefusal(`ollama is not answering at ${url} (${error.message}); start it first`); }
  if (!response.ok) throw new ModelRefusal(`ollama ${what} returned ${response.status}`);
  return response.json();
}

/** Pure decision: may `model` be called given what is resident and installed? */
export function residencyVerdict({ model, resident, installed, budgetBytes = DEFAULT_BUDGET_BYTES }) {
  const target = installed.find(entry => entry.name === model);
  if (!target) return { ok: false, reason: `model "${model}" is not installed (installed: ${installed.map(e => e.name).join(', ') || 'none'})` };
  const others = resident.filter(entry => entry.model !== model);
  const alreadyLoaded = resident.some(entry => entry.model === model);
  const heldByOthers = others.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const needed = alreadyLoaded ? 0 : target.sizeBytes;
  if (heldByOthers + needed > budgetBytes) {
    return { ok: false, reason: `refusing to load "${model}" (${(target.sizeBytes / GIB).toFixed(1)} GiB) while ` +
      `${others.map(e => `${e.model} (${(e.sizeBytes / GIB).toFixed(1)} GiB)`).join(', ') || 'nothing else'} is resident; ` +
      `that is over the ${(budgetBytes / GIB).toFixed(0)} GiB budget. Unload the other model, then resume.` };
  }
  return { ok: true };
}

export async function checkResidency({ endpoint, model, fetchImpl, budgetBytes }) {
  const [ps, tags] = await Promise.all([
    getJson(fetchImpl, `${endpoint}/api/ps`, '/api/ps'),
    getJson(fetchImpl, `${endpoint}/api/tags`, '/api/tags'),
  ]);
  const resident = (ps.models ?? []).map(entry => ({ model: entry.name ?? entry.model, sizeBytes: entry.size ?? 0 }));
  const installed = (tags.models ?? []).map(entry => ({ name: entry.name ?? entry.model, sizeBytes: entry.size ?? 0 }));
  const verdict = residencyVerdict({ model, resident, installed, budgetBytes });
  if (!verdict.ok) throw new ModelRefusal(verdict.reason);
}

export function createOllamaAdapter({ endpoint = DEFAULT_ENDPOINT, fetchImpl = fetch, budgetBytes, timeoutMs = 300_000 } = {}) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(endpoint)) {
    throw new ModelRefusal(`jobs only talk to local Ollama, not "${endpoint}"`);
  }
  return async function callModel({ model = DEFAULT_MODEL, system, prompt, schema }) {
    await checkResidency({ endpoint, model, fetchImpl, budgetBytes });
    const response = await fetchImpl(`${endpoint}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model, stream: false, think: false, format: schema,
        options: { temperature: 0, num_predict: 1024 },
        messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }] }),
    });
    if (!response.ok) throw new ModelRefusal(`ollama /api/chat returned ${response.status}`);
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_CHARS) throw new ModelRefusal(`ollama reply is larger than ${MAX_RESPONSE_CHARS} characters; refused`);
    let body;
    try { body = JSON.parse(raw); } catch { throw new ModelRefusal('ollama returned a reply that is not JSON'); }
    const text = body?.message?.content;
    if (typeof text !== 'string' || text.length > MAX_RESPONSE_CHARS) throw new ModelRefusal('ollama returned no message content');
    return text;
  };
}

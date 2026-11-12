import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSecrets } from './config.mjs';
import { IntegrationError, redact } from './errors.mjs';
import { requestJson } from './http.mjs';
import { assessLicense } from './license.mjs';
import { createGeminiProvider } from './ai/gemini.provider.mjs';
import { createGroqProvider } from './ai/groq.provider.mjs';
import { createLlmService } from './ai/llm.service.mjs';
import { normalizeOutput } from './ai/schema.mjs';
import { createHealthService } from './integration-health.service.mjs';
import { createRegistry } from './integration-registry.mjs';
import { createHuggingFaceService } from './huggingface/huggingface.service.mjs';
import { createKaggleService } from './kaggle/kaggle.service.mjs';
import { KEYS, fakeFetch, geminiReply, goodAnswer, groqReply, json, memDb, noSleep, quiet } from './testkit.mjs';

const secretsWith = (env) => createSecrets(env);
const codeOf = async (p) => (await p.then(() => null, (e) => e)) ?? { code: 'NO_ERROR' };

describe('http client', () => {
  it('retries a 503 and then succeeds', async () => {
    const f = fakeFetch((u, i, n) => (n === 1 ? new Response('down', { status: 503 }) : json({ ok: true })));
    const r = await requestJson({ provider: 'X', url: 'https://x.test/a', fetchImpl: f, sleep: noSleep, log: quiet });
    expect(r.data.ok).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it('does not wait out a long Retry-After on 429 and reports rate_limited', async () => {
    const f = fakeFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '600' } }));
    const e = await codeOf(requestJson({ provider: 'X', url: 'https://x.test/a', fetchImpl: f, sleep: noSleep, log: quiet }));
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfterSec).toBe(600);
    expect(f.calls).toHaveLength(1);
  });

  it('classifies 401, 403, 404 and does not retry them', async () => {
    for (const [status, code] of [[401, 'invalid_credentials'], [403, 'forbidden'], [404, 'not_found'], [400, 'bad_request']]) {
      const f = fakeFetch(() => new Response('no', { status }));
      expect((await codeOf(requestJson({ provider: 'X', url: 'https://x.test', fetchImpl: f, sleep: noSleep, log: quiet }))).code).toBe(code);
      expect(f.calls).toHaveLength(1);
    }
  });

  it('turns a network failure into unavailable and a timeout into timeout, after bounded retries', async () => {
    const down = fakeFetch(() => { throw new TypeError('fetch failed'); });
    expect((await codeOf(requestJson({ provider: 'X', url: 'https://x.test', fetchImpl: down, sleep: noSleep, log: quiet, retries: 1 }))).code).toBe('unavailable');
    expect(down.calls).toHaveLength(2);
    const slow = fakeFetch(() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
    expect((await codeOf(requestJson({ provider: 'X', url: 'https://x.test', fetchImpl: slow, sleep: noSleep, log: quiet, retries: 0 }))).code).toBe('timeout');
  });

  it('reports unreadable success bodies as bad_response', async () => {
    const f = fakeFetch(() => new Response('<html>', { status: 200 }));
    expect((await codeOf(requestJson({ provider: 'X', url: 'https://x.test', fetchImpl: f, sleep: noSleep, log: quiet }))).code).toBe('bad_response');
  });

  it('never leaks the key, the URL query or the provider body into messages or logs', async () => {
    const logs = [];
    const f = fakeFetch(() => new Response(`bad key ${KEYS.GEMINI_API_KEY} and key=${KEYS.GEMINI_API_KEY}`, { status: 401 }));
    const e = await codeOf(requestJson({ provider: 'Gemini', url: `https://x.test/a?key=${KEYS.GEMINI_API_KEY}`, fetchImpl: f, sleep: noSleep, log: (m) => logs.push(m), secretValues: [KEYS.GEMINI_API_KEY] }));
    expect(e.message).not.toContain(KEYS.GEMINI_API_KEY);
    expect(e.message).not.toContain('x.test');
    expect(logs.join(' ')).not.toContain(KEYS.GEMINI_API_KEY);
    expect(redact('https://a/b?api_key=abc123&x=1')).toBe('https://a/b?api_key=[redacted]&x=1');
  });
});

describe('secrets and licences', () => {
  it('treats empty and placeholder values as not configured, and requires both Kaggle values', () => {
    const s = secretsWith({ GEMINI_API_KEY: '  ', GROQ_API_KEY: 'your-key-here', KAGGLE_USERNAME: 'u', WANDB_API_KEY: 'real-key-1234' });
    expect(s.isConfigured('gemini')).toBe(false);
    expect(s.isConfigured('groq')).toBe(false);
    expect(s.isConfigured('kaggle')).toBe(false);
    expect(s.isConfigured('wandb')).toBe(true);
  });
  it('only calls clearly permissive licences permissive', () => {
    expect(assessLicense('apache-2.0').status).toBe('permissive');
    expect(assessLicense('cc-by-nc-4.0').status).toBe('restricted');
    expect(assessLicense('CC BY-SA 4.0').status).toBe('conditions');
    expect(assessLicense(undefined).status).toBe('unknown');
    expect(assessLicense('some-custom-thing').requiresReview).toBe(true);
  });
});

describe('Gemini and Groq providers', () => {
  const mk = (fetchImpl, env = KEYS) => {
    const secrets = secretsWith(env);
    const net = { fetchImpl, sleep: noSleep, log: quiet };
    return { gemini: createGeminiProvider({ secrets, model: 'g-model', ...net }), groq: createGroqProvider({ secrets, model: 'q-model', ...net }) };
  };

  it('Gemini sends the key as a header (not in the URL) and returns the text', async () => {
    const f = fakeFetch(() => geminiReply(goodAnswer()));
    const out = await mk(f).gemini.generate({ system: 's', prompt: 'p' });
    expect(JSON.parse(out.text).summary).toBe('A short summary.');
    expect(f.calls[0].url).not.toContain(KEYS.GEMINI_API_KEY);
    expect(f.calls[0].init.headers['x-goog-api-key']).toBe(KEYS.GEMINI_API_KEY);
  });

  it('Gemini maps its HTTP 400 API_KEY_INVALID to invalid_credentials', async () => {
    const f = fakeFetch(() => json({ error: { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 400));
    expect((await codeOf(mk(f).gemini.health())).code).toBe('invalid_credentials');
  });

  it('Gemini safety blocks and truncated answers are not treated as success', async () => {
    const blocked = fakeFetch(() => json({ promptFeedback: { blockReason: 'SAFETY' } }));
    expect((await codeOf(mk(blocked).gemini.generate({ system: 's', prompt: 'p' }))).code).toBe('blocked');
    const cut = fakeFetch(() => json({ candidates: [{ content: { parts: [{ text: '{"sum' }] }, finishReason: 'MAX_TOKENS' }] }));
    expect((await codeOf(mk(cut).gemini.generate({ system: 's', prompt: 'p' }))).code).toBe('bad_response');
  });

  it('Groq uses bearer auth and JSON mode', async () => {
    const f = fakeFetch(() => groqReply(goodAnswer()));
    await mk(f).groq.generate({ system: 'JSON only', prompt: 'p' });
    expect(f.calls[0].init.headers.Authorization).toBe(`Bearer ${KEYS.GROQ_API_KEY}`);
    expect(JSON.parse(f.calls[0].init.body).response_format.type).toBe('json_object');
  });
});

describe('LLM service: provider selection and fallback', () => {
  const build = ({ gemini, groq, prefs = { provider: 'auto', fallback: true }, env = KEYS, enabled = () => true }) => {
    const secrets = secretsWith(env);
    const calls = { gemini: 0, groq: 0 };
    const gf = fakeFetch((...a) => { calls.gemini++; return gemini(...a); });
    const qf = fakeFetch((...a) => { calls.groq++; return groq(...a); });
    const providers = [
      createGeminiProvider({ secrets, model: 'g', fetchImpl: gf, sleep: noSleep, log: quiet }),
      createGroqProvider({ secrets, model: 'q', fetchImpl: qf, sleep: noSleep, log: quiet }),
    ];
    const llm = createLlmService({ providers, getPrefs: () => prefs, isEnabled: enabled, log: quiet });
    return { llm, calls };
  };
  const req = (extra = {}) => ({ task: 't', system: 's', prompt: 'p1', ...extra });
  const ok = (fn) => () => fn(goodAnswer());

  it('uses Gemini when it works, and says so', async () => {
    const { llm, calls } = build({ gemini: ok(geminiReply), groq: ok(groqReply) });
    const r = await llm.complete(req());
    expect(r.provider).toBe('gemini');
    expect(r.fallbackFrom).toBeUndefined();
    expect(calls.groq).toBe(0);
  });

  it('falls back to Groq on quota exhaustion and reports the fallback', async () => {
    const { llm } = build({ gemini: () => new Response('quota', { status: 429 }), groq: ok(groqReply) });
    const r = await llm.complete(req());
    expect(r.provider).toBe('groq');
    expect(r.fallbackFrom).toEqual([{ provider: 'gemini', reason: 'rate_limited' }]);
  });

  it('falls back on outage (503) and timeout', async () => {
    const down = build({ gemini: () => new Response('x', { status: 503 }), groq: ok(groqReply) });
    expect((await down.llm.complete(req())).provider).toBe('groq');
    const slow = build({ gemini: () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, groq: ok(groqReply) });
    expect((await slow.llm.complete(req())).provider).toBe('groq');
  });

  it('does NOT silently switch providers for invalid credentials, bad requests or blocked content', async () => {
    for (const reply of [() => new Response('no', { status: 401 }), () => new Response('no', { status: 400 }), () => json({ promptFeedback: { blockReason: 'SAFETY' } })]) {
      const { llm, calls } = build({ gemini: reply, groq: ok(groqReply) });
      const e = await codeOf(llm.complete(req()));
      expect(['invalid_credentials', 'bad_request', 'blocked']).toContain(e.code);
      expect(calls.groq).toBe(0);
    }
  });

  it('does not fall back when the answer is unusable (a different provider is not the cure)', async () => {
    const { llm, calls } = build({ gemini: () => json({ candidates: [{ content: { parts: [{ text: 'not json at all' }] }, finishReason: 'STOP' }] }), groq: ok(groqReply) });
    expect((await codeOf(llm.complete(req()))).code).toBe('bad_response');
    expect(calls.groq).toBe(0);
  });

  it('respects fallback=false, a pinned provider, and unconfigured keys', async () => {
    const noFb = build({ gemini: () => new Response('q', { status: 429 }), groq: ok(groqReply), prefs: { provider: 'auto', fallback: false } });
    expect((await codeOf(noFb.llm.complete(req()))).code).toBe('rate_limited');
    expect(noFb.calls.groq).toBe(0);
    const pinned = build({ gemini: ok(geminiReply), groq: ok(groqReply), prefs: { provider: 'groq', fallback: true } });
    expect((await pinned.llm.complete(req())).provider).toBe('groq');
    const pinnedMissing = build({ gemini: ok(geminiReply), groq: ok(groqReply), prefs: { provider: 'groq', fallback: true }, env: { GEMINI_API_KEY: KEYS.GEMINI_API_KEY } });
    expect((await codeOf(pinnedMissing.llm.complete(req()))).code).toBe('not_configured');
    expect(pinnedMissing.calls.gemini).toBe(0); // a pinned-but-missing provider is an error, not a quiet switch
    const none = build({ gemini: ok(geminiReply), groq: ok(groqReply), env: {} });
    expect((await codeOf(none.llm.complete(req()))).code).toBe('not_configured');
    const off = build({ gemini: ok(geminiReply), groq: ok(groqReply), enabled: (id) => id !== 'gemini' });
    expect((await off.llm.complete(req())).provider).toBe('groq');
  });

  it('reports the last error when every provider is down', async () => {
    const { llm } = build({ gemini: () => new Response('x', { status: 503 }), groq: () => new Response('x', { status: 429 }) });
    const e = await codeOf(llm.complete(req()));
    expect(e.code).toBe('rate_limited');
    expect(e.attempts).toHaveLength(2);
  });

  it('caches identical requests and shares one in-flight call', async () => {
    const { llm, calls } = build({ gemini: ok(geminiReply), groq: ok(groqReply) });
    await Promise.all([llm.complete(req()), llm.complete(req())]);
    expect(calls.gemini).toBe(1);
    const again = await llm.complete(req());
    expect(again.cached).toBe(true);
    expect(calls.gemini).toBe(1);
    await llm.complete(req({ refresh: true }));
    expect(calls.gemini).toBe(2);
  });
});

describe('AI answer validation', () => {
  it('removes asset ids the model invented and says so', () => {
    const out = normalizeOutput({ summary: 's', findings: [{ title: 't', detail: 'd', assetIds: ['real', 'ghost'] }], recommendations: [], caveats: [] }, { provider: 'P', knownIds: new Set(['real']) });
    expect(out.findings[0].assetIds).toEqual(['real']);
    expect(out.caveats.join(' ')).toContain('1 asset reference');
  });
  it('rejects answers without a summary and clamps unknown enums', () => {
    expect(() => normalizeOutput({ findings: [] }, { provider: 'P' })).toThrow();
    const out = normalizeOutput({ summary: 's', findings: [{ title: 't', severity: 'apocalyptic' }], recommendations: [{ title: 'r', effort: 'huge' }] }, {});
    expect(out.findings[0].severity).toBe('info');
    expect(out.recommendations[0].effort).toBeNull();
  });
});

describe('integration health', () => {
  let db;
  beforeEach(() => { db = memDb(); });
  afterEach(() => db.close());

  const setup = ({ env = KEYS, handler = () => json({ models: [] }), clock } = {}) => {
    const secrets = secretsWith(env);
    const f = fakeFetch(handler);
    const net = { fetchImpl: f, sleep: noSleep, log: quiet };
    const providers = [createGeminiProvider({ secrets, model: 'g', ...net }), createGroqProvider({ secrets, model: 'q', ...net })];
    const hf = createHuggingFaceService({ secrets, ...net });
    const kaggle = createKaggleService({ secrets, ...net });
    const wandb = { health: async () => ({ detail: 'ok' }) };
    const registry = createRegistry({ providers, huggingface: hf, kaggle, wandb });
    const health = createHealthService({ db, secrets, registry, log: quiet, now: clock });
    return { health, f, get: (id) => health.snapshot().find((i) => i.id === id) };
  };

  it('never shows Connected just because a key exists', () => {
    const { get, f } = setup();
    expect(get('gemini').configured).toBe(true);
    expect(get('gemini').state).toBe('pending');
    expect(f.calls).toHaveLength(0);
  });

  it('shows Connected only after a real successful check, and records last success', async () => {
    const { health, get } = setup();
    await health.check({ ids: ['gemini'] });
    expect(get('gemini').state).toBe('connected');
    expect(get('gemini').lastOkAt).toBeTruthy();
  });

  it('detects invalid credentials and rate limits with useful messages', async () => {
    const bad = setup({ handler: () => new Response('no', { status: 401 }) });
    await bad.health.check({ ids: ['groq'] });
    expect(bad.get('groq').state).toBe('connection_failed');
    expect(bad.get('groq').errorCode).toBe('invalid_credentials');
    expect(bad.get('groq').detail).toContain('credentials');
    const limited = setup({ handler: () => new Response('x', { status: 429, headers: { 'retry-after': '30' } }) });
    await limited.health.check({ ids: ['groq'] });
    expect(limited.get('groq').state).toBe('rate_limited');
  });

  it('caches results so repeated checks do not hit providers again, but a forced refresh is throttled', async () => {
    let t = 1_000_000;
    const { health, f } = setup({ clock: () => t });
    await health.check({ ids: ['gemini'] });
    await health.check({ ids: ['gemini'] });
    expect(f.calls).toHaveLength(1);
    t += 2000;
    await health.check({ ids: ['gemini'], force: true });
    expect(f.calls).toHaveLength(1); // forced, but within the minimum interval
    t += 20_000;
    await health.check({ ids: ['gemini'], force: true });
    expect(f.calls).toHaveLength(2);
  });

  it('makes no calls for unconfigured or disabled integrations; Maps is always disabled', async () => {
    const { health, get, f } = setup({ env: { GROQ_API_KEY: KEYS.GROQ_API_KEY } });
    health.setEnabled('groq', false);
    await health.check();
    expect(get('gemini').state).toBe('not_configured');
    expect(get('groq').state).toBe('disabled');
    expect(get('google-maps').state).toBe('disabled');
    expect(get('google-maps').toggleable).toBe(false);
    expect(f.calls.filter((c) => !c.url.includes('huggingface')).length).toBe(0);
    expect(() => health.setEnabled('google-maps', true)).toThrow();
    health.setEnabled('groq', true);
    expect(get('groq').state).toBe('pending'); // re-enabling does not resurrect an old "connected"
  });

  it('public Hugging Face access without a token is reported as not configured, with the public search noted', async () => {
    const { health, get } = setup({ env: {}, handler: () => json([]) });
    await health.check();
    expect(get('huggingface').state).toBe('not_configured');
    expect(get('huggingface').publicAccess).toBe(true);
  });

  it('never exposes credential values in the snapshot', async () => {
    const { health } = setup();
    await health.check();
    const text = JSON.stringify(health.snapshot());
    for (const v of Object.values(KEYS)) expect(text).not.toContain(v);
  });
});

describe('Hugging Face service', () => {
  const mk = (handler, env = {}) => {
    const f = fakeFetch(handler);
    return { f, hf: createHuggingFaceService({ secrets: secretsWith(env), fetchImpl: f, sleep: noSleep, log: quiet }) };
  };

  it('searches datasets and normalises licence, tags and gating', async () => {
    const { hf, f } = mk(() => json([{ id: 'org/ds', author: 'org', downloads: 5, likes: 1, tags: ['license:cc-by-nc-4.0', 'task_categories:text-classification', 'size_categories:1K<n<10K'], gated: 'auto' }, { id: 'org/open', tags: ['license:mit'] }]));
    const r = await hf.searchDatasets({ q: 'power grid' });
    expect(r.results[0].licenseAssessment.status).toBe('restricted');
    expect(r.results[0].gated).toBe('auto');
    expect(r.results[1].licenseAssessment.status).toBe('permissive');
    expect(r.authenticated).toBe(false);
    expect(f.calls[0].init.headers.Authorization).toBeUndefined();
  });

  it('sends the token only when configured, and only to huggingface.co', async () => {
    const { hf, f } = mk(() => json([]), { HF_TOKEN: KEYS.HF_TOKEN });
    await hf.searchModels({ q: 'bert' });
    expect(f.calls[0].url.startsWith('https://huggingface.co/')).toBe(true);
    expect(f.calls[0].init.headers.Authorization).toBe(`Bearer ${KEYS.HF_TOKEN}`);
    expect(hf.fileRequest('org/ds', 'abc123', 'data/train.csv').allowedHosts).toEqual(['huggingface.co']);
  });

  it('returns size, files and importability; flags repos with nothing importable', async () => {
    const { hf } = mk(() => json({ id: 'org/ds', sha: 'a'.repeat(40), usedStorage: 1234, tags: ['license:apache-2.0'], siblings: [{ rfilename: 'train.jsonl', size: 100 }, { rfilename: 'data.parquet', size: 900 }, { rfilename: 'README.md', size: 5 }] }));
    const d = await hf.getDataset('org/ds');
    expect(d.files.find((x) => x.path === 'train.jsonl').importable).toBe(true);
    expect(d.files.find((x) => x.path === 'data.parquet').importable).toBe(false);
    expect(d.importableBytes).toBe(100);
    expect(d.sizeBytes).toBe(1234);
    const { hf: hf2 } = mk(() => json({ id: 'org/pq', tags: [], siblings: [{ rfilename: 'x.parquet', size: 1 }] }));
    expect((await hf2.getDataset('org/pq')).importNotes.join(' ')).toContain('cannot import');
  });

  it('explains gated and private repositories instead of claiming the key is wrong', async () => {
    const { hf } = mk(() => new Response('gated', { status: 401 }));
    const e = await codeOf(hf.getDataset('org/secret'));
    expect(e.code).toBe('forbidden');
    expect(e.message).toContain('gated');
    const { hf: hf2 } = mk(() => new Response('gated', { status: 403 }), { HF_TOKEN: KEYS.HF_TOKEN });
    expect((await codeOf(hf2.getDataset('org/secret'))).message).toContain('terms');
  });

  it('rejects malformed ids, revisions and path traversal before any request', async () => {
    const { hf, f } = mk(() => json({}));
    for (const id of ['../etc', 'a/b/c', 'x y', '', 'a//b']) expect((await codeOf(hf.getDataset(id))).code).toBe('bad_request');
    expect((await codeOf(hf.getDataset('org/ds', '../main'))).code).toBe('bad_request');
    expect(() => hf.fileRequest('org/ds', 'main', '../../etc/passwd')).toThrow();
    expect(f.calls).toHaveLength(0);
  });
});

describe('Kaggle service', () => {
  it('is not usable without both credentials and makes no request', async () => {
    const f = fakeFetch(() => json([]));
    const k = createKaggleService({ secrets: secretsWith({ KAGGLE_USERNAME: 'u' }), fetchImpl: f, sleep: noSleep, log: quiet });
    expect((await codeOf(k.search({ q: 'grid' }))).code).toBe('not_configured');
    expect(f.calls).toHaveLength(0);
  });

  it('searches with Basic auth, reports size and licence, and never forwards the key in the URL', async () => {
    const f = fakeFetch(() => json([{ ref: 'o/grid', title: 'Grid', totalBytes: 2048, licenseName: 'CC0-1.0', downloadCount: 3 }, { ref: 'o/nc', title: 'NC', licenseName: 'CC BY-NC 4.0' }]));
    const k = createKaggleService({ secrets: secretsWith(KEYS), fetchImpl: f, sleep: noSleep, log: quiet });
    const r = await k.search({ q: 'grid' });
    expect(r.results[0].sizeBytes).toBe(2048);
    expect(r.results[0].licenseAssessment.status).toBe('permissive');
    expect(r.results[1].licenseAssessment.status).toBe('restricted');
    expect(f.calls[0].init.headers.Authorization).toBe(`Basic ${Buffer.from(`${KEYS.KAGGLE_USERNAME}:${KEYS.KAGGLE_KEY}`).toString('base64')}`);
    expect(f.calls[0].url).not.toContain(KEYS.KAGGLE_KEY);
  });

  it('validates references and surfaces bad credentials', async () => {
    const k = createKaggleService({ secrets: secretsWith(KEYS), fetchImpl: fakeFetch(() => new Response('', { status: 401 })), sleep: noSleep, log: quiet });
    expect((await codeOf(k.get('../x'))).code).toBe('bad_request');
    expect((await codeOf(k.health())).code).toBe('invalid_credentials');
  });
});

import crypto from 'node:crypto';
import { FALLBACK_CODES, IntegrationError } from '../errors.mjs';
import { extractJson, normalizeOutput } from './schema.mjs';

/**
 * Provider-agnostic LLM access. Providers expose { id, label, model, isConfigured(), health(), generate() }; this
 * service owns ordering, fallback, caching and response normalisation so no business logic is duplicated per provider.
 *
 * Fallback rule: only failures a different provider could plausibly fix (rate limit / quota, timeout, outage) move
 * on to the next provider. Bad credentials, bad requests, blocked content and unusable output are returned to the
 * caller as they are, and every answer says which provider produced it and whether a fallback happened.
 */
export function createLlmService({ providers, getPrefs, isEnabled = () => true, now = () => Date.now(), cacheTtlMs = 10 * 60 * 1000, log = (m) => console.warn(m) }) {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const cache = new Map();
  const inflight = new Map();

  const usable = () => providers.filter((p) => p.isConfigured() && isEnabled(p.id));

  function order() {
    const prefs = getPrefs();
    const list = usable();
    const first = prefs.provider !== 'auto' ? list.find((p) => p.id === prefs.provider) : undefined;
    // A pinned provider that is unavailable (unset or disabled) is an error, not a quiet switch to another one.
    if (prefs.provider !== 'auto' && !first) {
      throw new IntegrationError(byId.get(prefs.provider)?.isConfigured() ? 'disabled' : 'not_configured', `The selected AI provider (${byId.get(prefs.provider)?.label ?? prefs.provider}) is not available. Configure or enable it, or choose "Automatic".`, { provider: prefs.provider });
    }
    const rest = list.filter((p) => p !== first);
    const ordered = first ? [first, ...rest] : rest;
    return prefs.fallback ? ordered : ordered.slice(0, 1);
  }

  const status = () => ({ preferences: getPrefs(), providers: providers.map((p) => ({ id: p.id, label: p.label, model: p.model, configured: p.isConfigured(), enabled: isEnabled(p.id) })) });

  /**
   * @param {{ task: string, system: string, prompt: string, knownIds?: Set<string>, refresh?: boolean, cacheKey?: string }} req
   */
  async function complete(req) {
    const prefs = getPrefs();
    const key = crypto.createHash('sha256').update(JSON.stringify([req.task, req.cacheKey ?? req.prompt, prefs.provider, prefs.fallback, providers.map((p) => p.model)])).digest('hex');
    const hit = cache.get(key);
    if (!req.refresh && hit && now() - hit.at < cacheTtlMs) return { ...hit.value, cached: true };
    if (inflight.has(key)) return inflight.get(key); // identical request already running: share it instead of paying twice

    const run = (async () => {
      const candidates = order();
      if (!candidates.length) throw new IntegrationError('not_configured', 'No AI provider is configured. Add GEMINI_API_KEY or GROQ_API_KEY to backend/.env.', { provider: 'ai' });
      const attempts = [];
      let lastErr;
      for (const p of candidates) {
        try {
          const out = await p.generate({ system: req.system, prompt: req.prompt });
          const parsed = extractJson(out.text);
          const content = normalizeOutput(parsed, { provider: p.label, knownIds: req.knownIds });
          const failedBefore = attempts.filter((a) => !a.ok);
          attempts.push({ provider: p.id, ok: true });
          const value = {
            provider: p.id,
            providerLabel: p.label,
            model: out.model,
            fallbackFrom: failedBefore.length ? failedBefore.map((a) => ({ provider: a.provider, reason: a.code })) : undefined,
            usage: out.usage,
            generatedAt: new Date(now()).toISOString(),
            content,
            cached: false,
          };
          cache.set(key, { at: now(), value });
          return value;
        } catch (err) {
          const e = err instanceof IntegrationError ? err : new IntegrationError('bad_response', `${p.label} failed unexpectedly.`, { provider: p.label, cause: err });
          attempts.push({ provider: p.id, ok: false, code: e.code });
          lastErr = e;
          if (!FALLBACK_CODES.has(e.code)) throw e; // fallback cannot fix this; say so rather than hiding it
          log(`[ai] ${p.id} unavailable (${e.code}); trying next provider if any`);
        }
      }
      lastErr.attempts = attempts;
      throw lastErr;
    })();
    inflight.set(key, run);
    try {
      return await run;
    } finally {
      inflight.delete(key);
    }
  }

  return { complete, status, providers: () => providers, clearCache: () => cache.clear() };
}

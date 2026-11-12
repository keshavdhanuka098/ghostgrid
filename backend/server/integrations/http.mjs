import { IntegrationError, USER_MESSAGES, redact } from './errors.mjs';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Maps an HTTP status to a stable error code. Providers may refine this with their own `classify` hook. */
export function classifyStatus(status) {
  if (status === 401) return 'invalid_credentials';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  if (status >= 400) return 'bad_request';
  return 'bad_response';
}

const RETRYABLE = new Set(['timeout', 'unavailable', 'rate_limited']);

function parseRetryAfter(res) {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(raw);
  return Number.isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : undefined;
}

/**
 * JSON request with a hard timeout, bounded retries (exponential backoff, honouring a short Retry-After) and
 * error classification. Nothing from the request (URL query, headers, body) is ever copied into an error message.
 *
 * `classify(status, bodyText)` may return a more specific code than the status alone gives.
 */
export async function requestJson({
  provider,
  url,
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 15000,
  retries = 2,
  baseDelayMs = 400,
  maxRetryAfterSec = 5,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  classify,
  secretValues = [],
  log = (m) => console.warn(m),
}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let code;
    let status;
    let retryAfterSec;
    try {
      const res = await fetchImpl(url, {
        method,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      const text = await res.text();
      if (res.ok) {
        try {
          return { status, data: text ? JSON.parse(text) : null, headers: res.headers };
        } catch {
          throw new IntegrationError('bad_response', USER_MESSAGES.bad_response(provider), { provider, status });
        }
      }
      code = classify?.(status, text) ?? classifyStatus(status);
      retryAfterSec = parseRetryAfter(res);
      log(`[integrations] ${provider} HTTP ${status} -> ${code}: ${redact(text.slice(0, 200), secretValues)}`);
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      code = timedOut ? 'timeout' : 'unavailable';
      log(`[integrations] ${provider} request failed -> ${code} (${err?.name ?? 'error'})`);
    }
    lastError = new IntegrationError(code, (USER_MESSAGES[code] ?? USER_MESSAGES.bad_request)(provider), { provider, status, retryAfterSec });
    if (!RETRYABLE.has(code) || attempt === retries) break;
    // A 429 with a long Retry-After will not be fixed by waiting a few seconds; report it instead of stalling the request.
    if (code === 'rate_limited' && (retryAfterSec === undefined || retryAfterSec > maxRetryAfterSec)) break;
    const wait = code === 'rate_limited' ? retryAfterSec * 1000 : baseDelayMs * 2 ** attempt;
    await sleep(wait);
  }
  throw lastError;
}

export const basicAuth = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

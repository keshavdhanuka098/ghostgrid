/**
 * One error type for everything that goes wrong talking to an external service.
 * `code` is a stable machine-readable reason; `message` is safe to show a user (it never carries provider payloads,
 * URLs with query strings, or credentials). Raw detail goes only to the server log, redacted.
 */
export const HTTP_STATUS_FOR_CODE = {
  not_configured: 409,
  disabled: 409,
  invalid_credentials: 502,
  forbidden: 403,
  rate_limited: 429,
  timeout: 504,
  unavailable: 502,
  not_found: 404,
  bad_request: 400,
  bad_response: 502,
  blocked: 422,
  too_large: 413,
  conflict: 409,
  unsupported: 422,
};

/** Failures where trying another provider could plausibly help. Everything else is surfaced, never papered over. */
export const FALLBACK_CODES = new Set(['rate_limited', 'timeout', 'unavailable']);

export class IntegrationError extends Error {
  constructor(code, message, { provider, status, retryAfterSec, cause } = {}) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
    this.provider = provider;
    this.upstreamStatus = status;
    this.retryAfterSec = retryAfterSec;
    if (cause) this.cause = cause;
  }
  get httpStatus() {
    return HTTP_STATUS_FOR_CODE[this.code] ?? 502;
  }
  toJSON() {
    return { error: this.message, code: this.code, provider: this.provider, retryAfterSec: this.retryAfterSec };
  }
}

export const USER_MESSAGES = {
  invalid_credentials: (p) => `${p} rejected the configured credentials. Check the key in your .env file.`,
  forbidden: (p) => `${p} refused this request. The account may lack access, or terms may need to be accepted on the provider's website.`,
  rate_limited: (p) => `${p} is rate limiting requests or the quota is used up. Try again later.`,
  timeout: (p) => `${p} did not answer in time.`,
  unavailable: (p) => `${p} could not be reached or is having problems.`,
  not_found: (p) => `${p} has no such item.`,
  bad_request: (p) => `${p} rejected the request as invalid.`,
  bad_response: (p) => `${p} returned a response GhostGrid could not use.`,
  too_large: (p) => `${p} item is larger than the configured limit.`,
};

/** Replaces every known secret value (and common key= patterns) so nothing sensitive reaches a log or a message. */
export function redact(text, secretValues = []) {
  let out = String(text ?? '');
  for (const s of secretValues) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  return out.replace(/([?&](?:key|api_key|token|access_token)=)[^&\s]+/gi, '$1[redacted]');
}

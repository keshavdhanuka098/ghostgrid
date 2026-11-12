/**
 * Credentials and integration definitions. Secrets are read from the environment only, kept inside this module's
 * closure, and are never serialised: callers get `get(name)` for server-side use and booleans for everything else.
 */
export const INTEGRATION_IDS = ['gemini', 'groq', 'huggingface', 'wandb', 'kaggle', 'google-maps'];

export const ENV_VARS = {
  gemini: ['GEMINI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  huggingface: ['HF_TOKEN'],
  wandb: ['WANDB_API_KEY'],
  kaggle: ['KAGGLE_USERNAME', 'KAGGLE_KEY'],
  'google-maps': ['GOOGLE_MAPS_API_KEY'],
};

/** Integrations that still do something useful with no credentials (public Hugging Face search). */
export const WORKS_ANONYMOUSLY = new Set(['huggingface']);

const PLACEHOLDER = /^(your[-_ ]|<|changeme|replace|xxx|todo|none$|null$)/i;

export function createSecrets(env = process.env) {
  const read = (name) => {
    const v = env[name];
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t && !PLACEHOLDER.test(t) ? t : undefined;
  };
  return {
    /** Server-side use only. Never put the result in a response, a log line or an error message. */
    get: read,
    isConfigured: (id) => (ENV_VARS[id] ?? []).length > 0 && ENV_VARS[id].every((n) => read(n) !== undefined),
    /** Every secret value currently set, for redaction. */
    values: () => Object.values(ENV_VARS).flat().map(read).filter(Boolean),
    env: (name, fallback) => env[name] ?? fallback,
  };
}

export const MODEL_DEFAULTS = { gemini: 'gemini-2.5-flash', groq: 'llama-3.3-70b-versatile' };

export function aiDefaults(secrets) {
  const provider = String(secrets.env('GHOSTGRID_AI_PROVIDER', 'auto')).toLowerCase();
  return {
    provider: ['auto', 'gemini', 'groq'].includes(provider) ? provider : 'auto',
    fallback: !/^(0|false|no|off)$/i.test(String(secrets.env('GHOSTGRID_AI_FALLBACK', 'true'))),
    geminiModel: secrets.env('GEMINI_MODEL', MODEL_DEFAULTS.gemini),
    groqModel: secrets.env('GROQ_MODEL', MODEL_DEFAULTS.groq),
  };
}

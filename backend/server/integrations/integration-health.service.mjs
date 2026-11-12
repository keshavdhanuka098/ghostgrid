import { IntegrationError, redact } from './errors.mjs';

const nowIso = (ms) => new Date(ms).toISOString();

export const STATE_LABELS = {
  connected: 'Connected',
  not_configured: 'Not configured',
  disabled: 'Disabled',
  rate_limited: 'Rate limited',
  connection_failed: 'Connection failed',
  pending: 'Synchronization pending',
};

/**
 * Tracks whether each integration actually works. "Connected" is only ever the result of a successful real request; a key
 * merely being present yields "Synchronization pending" until a check has run. Checks are cached, so opening the page
 * repeatedly does not hammer providers, and a forced refresh is rate limited per integration.
 */
export function createHealthService({ db, secrets, registry, now = () => Date.now(), okTtlMs = 5 * 60_000, failTtlMs = 60_000, minForceMs = 10_000, log = (m) => console.warn(m) }) {
  const results = new Map(); // id -> { state, detail, errorCode, checkedAt, publicAccess }
  const running = new Map();
  const byId = new Map(registry.map((r) => [r.id, r]));

  const setting = (id) => db.prepare('SELECT enabled FROM integration_settings WHERE id = ?').get(id);
  const isEnabled = (id) => {
    const d = byId.get(id);
    if (d?.unsupported) return false;
    return setting(id)?.enabled !== 0;
  };
  function setEnabled(id, enabled) {
    const d = byId.get(id);
    if (!d) throw new IntegrationError('not_found', 'Unknown integration.');
    if (d.unsupported) throw new IntegrationError('unsupported', d.unsupported);
    db.prepare('INSERT INTO integration_settings (id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at').run(id, enabled ? 1 : 0, nowIso(now()));
    results.delete(id); // a toggled integration must be re-verified, not trusted from before
  }

  const persisted = (id) => db.prepare('SELECT * FROM integration_health WHERE id = ?').get(id);
  function persist(id, { ok, errorCode }) {
    const t = nowIso(now());
    db.prepare(`INSERT INTO integration_health (id, last_checked_at, last_ok_at, last_error_code) VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET last_checked_at = excluded.last_checked_at, last_ok_at = COALESCE(excluded.last_ok_at, integration_health.last_ok_at), last_error_code = excluded.last_error_code`)
      .run(id, t, ok ? t : null, ok ? null : errorCode ?? 'unknown');
  }

  function view(d) {
    const configured = secrets.isConfigured(d.id);
    const enabled = isEnabled(d.id);
    const r = results.get(d.id);
    const p = persisted(d.id);
    let state;
    let detail = null;
    let errorCode = null;
    if (d.unsupported) ({ state, detail } = { state: 'disabled', detail: d.unsupported });
    else if (!enabled) state = 'disabled';
    else if (!configured) { state = 'not_configured'; detail = r?.publicAccess ? r.detail : `Set ${d.envVars.join(' and ')} in backend/.env to enable this integration.`; }
    else if (!r) state = 'pending';
    else ({ state, detail, errorCode } = { state: r.state, detail: r.detail, errorCode: r.errorCode ?? null });
    return {
      id: d.id, label: d.label, category: d.category, description: d.description, features: d.features,
      envVars: d.envVars.map((name) => ({ name, set: secrets.get(name) !== undefined })),
      configured, enabled, toggleable: !d.unsupported,
      state, stateLabel: STATE_LABELS[state], detail, errorCode,
      publicAccess: Boolean(r?.publicAccess), worksAnonymously: d.worksAnonymously,
      lastCheckedAt: r ? nowIso(r.checkedAt) : p?.last_checked_at ?? null,
      lastOkAt: p?.last_ok_at ?? null,
      lastErrorCode: p?.last_error_code ?? null,
    };
  }

  const snapshot = () => registry.map(view);

  async function runCheck(d) {
    const checkedAt = now();
    try {
      const out = await d.check();
      const publicAccess = Boolean(out?.anonymous);
      results.set(d.id, { state: publicAccess ? 'not_configured' : 'connected', detail: out?.detail ?? null, checkedAt, publicAccess });
      persist(d.id, { ok: true });
    } catch (err) {
      const e = err instanceof IntegrationError ? err : new IntegrationError('unavailable', `${d.label} check failed unexpectedly.`);
      if (!(err instanceof IntegrationError)) log(`[health] ${d.id}: ${redact(err?.message, secrets.values())}`);
      const state = e.code === 'rate_limited' ? 'rate_limited' : 'connection_failed';
      results.set(d.id, { state, detail: e.code === 'rate_limited' && e.retryAfterSec ? `${e.message} Retry after about ${Math.ceil(e.retryAfterSec)} s.` : e.message, errorCode: e.code, checkedAt });
      persist(d.id, { ok: false, errorCode: e.code });
    }
  }

  /** Runs real checks for integrations that are enabled and (configured or able to run anonymously). Returns the fresh snapshot. */
  async function check({ ids, force = false } = {}) {
    const targets = registry.filter((d) => (!ids || ids.includes(d.id)) && !d.unsupported && isEnabled(d.id) && (secrets.isConfigured(d.id) || d.anonymousCheck));
    await Promise.all(targets.map((d) => {
      const r = results.get(d.id);
      const age = r ? now() - r.checkedAt : Infinity;
      const ttl = r?.state === 'connected' ? okTtlMs : failTtlMs;
      const fresh = r && age < (force ? minForceMs : ttl);
      if (fresh) return undefined; // recent enough: no new request
      if (!running.has(d.id)) running.set(d.id, runCheck(d).finally(() => running.delete(d.id)));
      return running.get(d.id);
    }));
    return snapshot();
  }

  return { snapshot, check, isEnabled, setEnabled, stateOf: (id) => view(byId.get(id)).state };
}

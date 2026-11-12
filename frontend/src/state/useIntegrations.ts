import { useCallback, useEffect, useRef, useState } from 'react';
import { integrationError, integrationsApi, type AiStatus, type IntegrationInfo } from '../lib/integrations';

/**
 * Loads the integration list (no network calls to providers) and then asks the server for a real health check.
 * The server caches checks, so opening this view repeatedly does not hammer any provider.
 */
export function useIntegrations() {
  const [items, setItems] = useState<IntegrationInfo[]>([]);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [importLimit, setImportLimit] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const check = useCallback(async (force = false) => {
    setChecking(true);
    try {
      const r = await integrationsApi.check(force);
      if (alive.current) setItems(r.integrations);
    } catch (err) {
      if (alive.current) setError(integrationError(err));
    } finally {
      if (alive.current) setChecking(false);
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      const r = await integrationsApi.list();
      if (!alive.current) return;
      setItems(r.integrations);
      setAi(r.ai);
      setImportLimit(r.importLimitBytes);
      setError(null);
    } catch (err) {
      if (alive.current) setError(integrationError(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload().then(() => check(false));
    return () => {
      alive.current = false;
    };
  }, [reload, check]);

  const setEnabled = async (id: string, enabled: boolean) => {
    const r = await integrationsApi.setEnabled(id, enabled);
    setItems((prev) => prev.map((i) => (i.id === id ? r.integration : i)));
    await reload();
    if (enabled) await check(false);
  };

  return { items, ai, importLimit, loading, checking, error, reload, check, setEnabled, setAi };
}

import { useState } from 'react';
import { Alert, Checkbox, SelectField } from '../ui';
import { integrationError, integrationsApi, type AiStatus, type IntegrationInfo } from '../../lib/integrations';
import { StateBadge } from './IntegrationHealth';

export function AiProviderPanel({ ai, items, onChange }: { ai: AiStatus | null; items: IntegrationInfo[]; onChange: (s: AiStatus) => void }) {
  const [error, setError] = useState<string | null>(null);
  if (!ai) return null;
  const save = async (p: Partial<AiStatus['preferences']>) => {
    try {
      setError(null);
      onChange(await integrationsApi.setAiPreferences(p));
    } catch (err) {
      setError(integrationError(err));
    }
  };
  const anyConfigured = ai.providers.some((p) => p.configured && p.enabled);
  return (
    <section className="card stack" aria-labelledby="ai-prov">
      <h2 id="ai-prov" className="card-title">AI providers</h2>
      {!anyConfigured && <Alert tone="info">No AI provider is available. Add GEMINI_API_KEY or GROQ_API_KEY to <code>backend/.env</code> and restart. Everything else in GhostGrid works without it.</Alert>}
      <ul className="integ-providers">
        {ai.providers.map((p) => {
          const info = items.find((i) => i.id === p.id);
          return (
            <li key={p.id}>
              <strong>{p.label}</strong> <span className="dim">model {p.model}</span> {info && <StateBadge item={info} />}
            </li>
          );
        })}
      </ul>
      <SelectField label="Provider" value={ai.preferences.provider} hint="Automatic tries Gemini first. A pinned provider that is unavailable is reported as an error, never swapped silently." onChange={(e) => void save({ provider: e.target.value as AiStatus['preferences']['provider'] })}>
        <option value="auto">Automatic (Gemini, then Groq)</option>
        <option value="gemini">Gemini only</option>
        <option value="groq">Groq only</option>
      </SelectField>
      <Checkbox label="Fall back to the other provider on rate limits, timeouts and outages" checked={ai.preferences.fallback} onChange={(e) => void save({ fallback: e.target.checked })} />
      <p className="dim">Fallback never happens for rejected keys or rejected requests, because another provider would not fix those. Every answer shows which provider produced it.</p>
      {error && <Alert tone="error">{error}</Alert>}
    </section>
  );
}

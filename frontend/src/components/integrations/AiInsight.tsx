import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button } from '../ui';
import { integrationError, integrationsApi, type AiResult } from '../../lib/integrations';

const SEVERITY: Record<string, string> = { info: 'Info', notable: 'Notable', important: 'Important' };

/**
 * One reusable "explain this with AI" control. The server gathers the data itself (it recomputes simulations and reads
 * recorded experiments), so what is shown here is an interpretation of real GhostGrid results, clearly labelled as such.
 */
export function AiInsight({ task, params, label = 'Explain with AI', disabled, disabledReason, resetKey }: { task: string; params: Record<string, unknown>; label?: string; disabled?: boolean; disabledReason?: string; resetKey?: string }) {
  const [result, setResult] = useState<AiResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ticket = useRef(0);

  // A different selection means the old explanation no longer applies, so it is cleared instead of left on screen.
  useEffect(() => {
    ticket.current++;
    setResult(null);
    setError(null);
    setBusy(false);
  }, [resetKey]);

  const run = async (refresh: boolean) => {
    const mine = ++ticket.current;
    setBusy(true);
    setError(null);
    try {
      const r = await integrationsApi.analyze(task, params, refresh);
      if (mine === ticket.current) setResult(r);
    } catch (err) {
      if (mine === ticket.current) setError(integrationError(err));
    } finally {
      if (mine === ticket.current) setBusy(false);
    }
  };

  return (
    <div className="ai-insight">
      <div className="row-actions">
        <Button onClick={() => void run(false)} loading={busy} disabled={disabled}>{result ? 'Explain again' : label}</Button>
        {result && <Button variant="ghost" onClick={() => void run(true)} disabled={busy}>Regenerate</Button>}
        {disabled && disabledReason && <span className="dim">{disabledReason}</span>}
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {result && (
        <section className="ai-result" aria-label="AI interpretation">
          <div className="ai-banner">
            <Badge tone="ghost">AI interpretation</Badge>
            <span>{result.notice}</span>
          </div>
          <p className="dim ai-source">
            Produced by {result.providerLabel} ({result.model}){result.cached ? ', reused from a recent identical request' : ''}.
            {result.fallbackFrom && <> Fallback used: {result.fallbackFrom.map((f) => `${f.provider} (${f.reason.replace('_', ' ')})`).join(', ')} did not answer.</>}
          </p>
          <details className="ai-grounding">
            <summary>What the AI was given</summary>
            <p className="dim">{result.grounding.source}</p>
            <ul>{result.grounding.items.map((i) => <li key={i}>{i}</li>)}</ul>
            {result.grounding.notes.map((n) => <p key={n} className="dim">{n}</p>)}
          </details>
          <p className="ai-summary">{result.content.summary}</p>
          {result.content.findings.length > 0 && (
            <>
              <h4>Observations</h4>
              <ul className="ai-list">
                {result.content.findings.map((f, i) => (
                  <li key={`${f.title}-${i}`}>
                    <strong>{f.title}</strong> <Badge tone={f.severity === 'important' ? 'danger' : f.severity === 'notable' ? 'ghost' : undefined}>{SEVERITY[f.severity]}</Badge>
                    <p>{f.detail}</p>
                    {f.evidence.length > 0 && <p className="dim">Based on: {f.evidence.join('; ')}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.content.recommendations.length > 0 && (
            <>
              <h4>Suggestions to evaluate <span className="dim">(not results)</span></h4>
              <ul className="ai-list">
                {result.content.recommendations.map((r, i) => (
                  <li key={`${r.title}-${i}`}>
                    <strong>{r.title}</strong>{r.effort && <> <Badge>{r.effort} effort</Badge></>}
                    <p>{r.rationale}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.content.caveats.length > 0 && (
            <>
              <h4>Limits</h4>
              <ul className="ai-list dim">{result.content.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}

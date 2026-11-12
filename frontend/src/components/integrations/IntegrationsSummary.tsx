import { ButtonLink, LoadingBlock } from '../ui';
import { useIntegrations } from '../../state/useIntegrations';
import { StateBadge } from './IntegrationHealth';

/** Compact status list for the Settings page. It reads verified status only; configuration lives in backend/.env. */
export function IntegrationsSummary() {
  const { items, loading, error } = useIntegrations();
  return (
    <section className="card" aria-labelledby="set-integrations">
      <h2 id="set-integrations" className="card-title">External integrations</h2>
      <div className="stack">
        <p className="dim">Optional AI, dataset and experiment-tracking services. Keys live in <code>backend/.env</code> on the machine running GhostGrid and are never sent to the browser.</p>
        {loading && <LoadingBlock label="Checking…" />}
        {error && <p className="import-error">{error}</p>}
        <ul className="integ-providers">
          {items.map((i) => <li key={i.id}><strong>{i.label}</strong> <StateBadge item={i} /></li>)}
        </ul>
        <div className="row-actions"><ButtonLink to="/app/integrations" variant="primary">Manage integrations</ButtonLink></div>
      </div>
    </section>
  );
}

import { Fragment, useEffect, useRef, useState } from 'react';
import { ScenarioGate } from '../components/ScenarioGate';
import { Alert, Button, EmptyState, PageHeader, StatTile } from '../components/ui';
import { api, type GraphFeatures } from '../lib/api';
import type { Scenario } from '../lib/types';
import { AiInsight } from '../components/integrations/AiInsight';
import { describeError } from '../state/ScenarioContext';

const HEADLINE: Array<[string, string]> = [
  ['hidden_shared_dependency_count', 'Hidden shared dependencies'],
  ['single_point_of_failure_count', 'Single points of failure'],
  ['max_cascade_reach', 'Largest cascade'],
  ['max_dependency_depth', 'Longest chain'],
];

const pretty = (k: string) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const fmt = (v: number | boolean) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : Number.isInteger(v) ? String(v) : v.toFixed(3));

function Inner({ s }: { s: Scenario }) {
  const [data, setData] = useState<GraphFeatures | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Each request gets a ticket; a result is applied only if it is still the latest one for the scenario on screen,
  // so switching scenarios mid-request can never show one scenario's features under another's name.
  const ticket = useRef(0);

  const run = async () => {
    const mine = ++ticket.current;
    setBusy(true);
    setError(null);
    try {
      const result = await api.extractFeatures(s.id);
      if (mine === ticket.current) setData(result);
    } catch (err) {
      if (mine === ticket.current) setError(describeError(err));
    } finally {
      if (mine === ticket.current) setBusy(false);
    }
  };

  useEffect(() => {
    ticket.current++; // invalidate any request still in flight for the previous scenario
    setData(null);
    setError(null);
    setBusy(false);
  }, [s.id]);

  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${s.name.replace(/\W+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'scenario'}-features.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title="Graph features"
        description={
          <>
            Turns <strong>{s.name}</strong> into numbers: how connected, how deep, how far a failure travels. Computed by the Python feature pipeline on the server, and exportable for your own models.
          </>
        }
        actions={
          <>
            <Button variant="primary" onClick={() => void run()} loading={busy}>
              {data ? 'Run again' : 'Extract features'}
            </Button>
            {data && <Button onClick={download}>Download JSON</Button>}
          </>
        }
      />
      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && (
        <EmptyState title="No features extracted yet">
          Choose Extract features to analyse the saved graph of this scenario.
        </EmptyState>
      )}
      {data && (
        <div className="stack">
          <div className="stat-grid">
            {HEADLINE.map(([k, label]) => (
              <StatTile key={k} label={label} value={data.graph[k] ?? 0} tone={k.startsWith('hidden') ? 'ghost' : undefined} />
            ))}
          </div>

          <section className="card stack" aria-labelledby="ai-infra">
            <h2 className="card-title" id="ai-infra">AI reading of this scenario</h2>
            <p className="dim">Optional. The AI is given this scenario’s graph and the metrics above, and its answer is labelled as interpretation, not as a result.</p>
            <AiInsight task="infrastructure_analysis" params={{ scenarioId: s.id }} label="Analyse infrastructure with AI" resetKey={s.id} />
            <AiInsight task="infrastructure_analysis" params={{ scenarioId: s.id, mode: 'recommendations' }} label="Suggest improvements with AI" resetKey={`${s.id}-rec`} />
          </section>

          <section className="card" aria-labelledby="per-asset">
            <div className="card-head">
              <h2 className="card-title" id="per-asset">By asset, ranked by weighted reach</h2>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Dependents</th>
                    <th>Providers</th>
                    <th>Cascade reach</th>
                    <th>Hidden reach</th>
                    <th>Weighted reach</th>
                    <th>Depth up / down</th>
                    <th>Reliance rank</th>
                  </tr>
                </thead>
                <tbody>
                  {data.assets.map((a) => (
                    <tr key={a.id}>
                      <td className="cell-name">{a.name}</td>
                      <td>{fmt(a.features.dependents)}</td>
                      <td>{fmt(a.features.providers)}</td>
                      <td>{fmt(a.features.cascade_reach)}</td>
                      <td>{fmt(a.features.hidden_reach)}</td>
                      <td>{fmt(a.features.weighted_reach)}</td>
                      <td>
                        {fmt(a.features.depth_upstream)} / {fmt(a.features.depth_downstream)}
                      </td>
                      <td>{fmt(a.features.reliance_rank)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card" aria-labelledby="whole-graph">
            <div className="card-head">
              <h2 className="card-title" id="whole-graph">Whole-graph feature vector</h2>
              <span className="card-sub">{Object.keys(data.graph).length} features · {data.schema}</span>
            </div>
            <dl className="gg-facts">
              {Object.entries(data.graph).map(([k, v]) => (
                <Fragment key={k}>
                  <dt>{pretty(k)}</dt>
                  <dd className="mono">{fmt(v)}</dd>
                </Fragment>
              ))}
            </dl>
          </section>
        </div>
      )}
    </>
  );
}

export default function Features() {
  return <ScenarioGate title="Graph features" description="Extract numeric features from a dependency graph.">{(s) => <Inner s={s} />}</ScenarioGate>;
}

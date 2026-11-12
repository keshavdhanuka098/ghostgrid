import { useCallback, useEffect, useState } from 'react';
import { AiInsight } from '../components/integrations/AiInsight';
import { AiProviderPanel } from '../components/integrations/AiProviderPanel';
import { DatasetDiscovery } from '../components/integrations/DatasetDiscovery';
import { ExperimentsPanel } from '../components/integrations/ExperimentsPanel';
import { IntegrationHealth } from '../components/integrations/IntegrationHealth';
import { Alert, Button, LoadingBlock, PageHeader } from '../components/ui';
import { integrationError, integrationsApi, type LocalDataset, type LocalExperiment } from '../lib/integrations';
import { useIntegrations } from '../state/useIntegrations';

type Tab = 'health' | 'ai' | 'datasets' | 'experiments';
const TABS: Array<[Tab, string]> = [['health', 'Connections'], ['ai', 'AI'], ['datasets', 'Datasets'], ['experiments', 'Experiments']];

function RegisteredDatasets() {
  const [rows, setRows] = useState<LocalDataset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    integrationsApi.localDatasets().then((d) => alive && setRows(d)).catch((e) => alive && setError(integrationError(e)));
    return () => {
      alive = false;
    };
  }, []);
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!rows) return <LoadingBlock label="Reading the dataset manifest…" />;
  return (
    <section className="card stack" aria-labelledby="reg-ds">
      <h2 id="reg-ds" className="card-title">Registered datasets</h2>
      {rows.length === 0 ? <p className="dim">No datasets are registered yet. Register one with <code>scripts/register_dataset.py</code>, or import one above and register it.</p> : (
        <ul className="disc-list">
          {rows.map((d) => {
            const key = `${d.name}@${d.version}`;
            return (
              <li key={key} className="import-row">
                <div><strong>{d.name}</strong> <span className="dim">v{d.version} · {d.metadata?.record_count ?? '?'} records · {d.metadata?.license ?? 'licence not recorded'}</span></div>
                <div className="row-actions"><Button size="sm" onClick={() => setOpen(open === key ? null : key)}>{open === key ? 'Hide AI insights' : 'AI insights'}</Button></div>
                {open === key && (
                  <div className="import-ai stack">
                    <AiInsight task="dataset_quality" params={{ datasetName: d.name, datasetVersion: d.version }} label="Explain dataset quality" resetKey={key} />
                    <AiInsight task="training_recommendations" params={{ datasetName: d.name, datasetVersion: d.version }} label="Suggest training configuration" resetKey={`${key}-t`} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default function Integrations() {
  const hub = useIntegrations();
  const [tab, setTab] = useState<Tab>('health');
  const [exps, setExps] = useState<LocalExperiment[]>([]);
  const [expsLoading, setExpsLoading] = useState(true);
  const [project, setProject] = useState('ghostgrid');

  const loadExperiments = useCallback(async () => {
    try {
      const r = await integrationsApi.localExperiments();
      setExps(r.experiments);
      setProject(r.wandbDefaults.project);
    } catch {
      /* shown as an empty list; the connections tab reports server problems */
    } finally {
      setExpsLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadExperiments();
  }, [loadExperiments]);

  const wandb = hub.items.find((i) => i.id === 'wandb');
  const maps = hub.items.find((i) => i.id === 'google-maps');
  return (
    <>
      <PageHeader title="External integrations" description="Optional services that extend GhostGrid. Simulation, datasets and training all work without any of them, and every request goes through your local server." />
      <div className="seg integ-tabs" role="tablist" aria-label="Integration areas">
        {TABS.map(([t, l]) => <Button key={t} variant={tab === t ? 'primary' : 'secondary'} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{l}</Button>)}
      </div>
      {hub.error && <Alert tone="error">{hub.error}</Alert>}
      {hub.loading && <LoadingBlock label="Loading integrations…" />}

      {!hub.loading && tab === 'health' && (
        <div className="stack">
          <IntegrationHealth items={hub.items} checking={hub.checking} onCheck={() => void hub.check(true)} onToggle={hub.setEnabled} />
          {maps && <Alert tone="info"><strong>Maps are off by design.</strong> {maps.detail} GhostGrid will not invent locations.</Alert>}
        </div>
      )}
      {!hub.loading && tab === 'ai' && (
        <div className="stack">
          <AiProviderPanel ai={hub.ai} items={hub.items} onChange={hub.setAi} />
          <Alert tone="info">AI explanations appear where the data is: <strong>Simulation</strong> (explain a cascade and its root cause), <strong>Graph features</strong> (infrastructure analysis and suggestions), the <strong>Datasets</strong> and <strong>Experiments</strong> tabs here. They are always labelled as interpretation, never as simulation or model results.</Alert>
        </div>
      )}
      {!hub.loading && tab === 'datasets' && (
        <div className="stack">
          <DatasetDiscovery importLimit={hub.importLimit} experiments={exps} />
          <RegisteredDatasets />
        </div>
      )}
      {!hub.loading && tab === 'experiments' && (
        <ExperimentsPanel wandbReady={wandb?.state === 'connected'} experiments={exps} defaults={{ project }} loading={expsLoading} reload={loadExperiments} />
      )}
    </>
  );
}

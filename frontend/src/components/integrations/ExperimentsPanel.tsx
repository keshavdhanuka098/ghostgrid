import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Checkbox, EmptyState, LoadingBlock, TextField } from '../ui';
import { integrationError, integrationsApi, type Comparison, type LocalExperiment } from '../../lib/integrations';
import { useToast } from '../../state/ToastContext';
import { AiInsight } from './AiInsight';

const SYNC_TEXT: Record<string, string> = { not_synced: 'Not synced', pending: 'Synchronization pending', synced: 'Synced', failed: 'Sync failed' };
const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(4));

export function ExperimentsPanel({ wandbReady, experiments, defaults, loading, reload }: { wandbReady: boolean; experiments: LocalExperiment[]; defaults: { project: string }; loading: boolean; reload: () => Promise<void> }) {
  const toast = useToast();
  const [picked, setPicked] = useState<string[]>([]);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [opts, setOpts] = useState<{ id: string; project: string; upload: boolean; consent: boolean } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const anyPending = experiments.some((e) => e.wandb.syncStatus === 'pending');
  const refresh = useCallback(() => reload(), [reload]);
  useEffect(() => {
    if (!anyPending) return undefined;
    const t = setInterval(() => void refresh(), 2500);
    return () => clearInterval(t);
  }, [anyPending, refresh]);

  const sync = async () => {
    if (!opts) return;
    setSyncing(opts.id);
    setError(null);
    try {
      await integrationsApi.wandbSync({ experimentId: opts.id, project: opts.project || undefined, uploadCheckpoint: opts.upload, consentToUpload: opts.upload && opts.consent });
      toast.success('Experiment logged to Weights & Biases.');
      setOpts(null);
    } catch (err) {
      setError(integrationError(err));
    } finally {
      setSyncing(null);
      await reload();
    }
  };

  const compare = async () => {
    setError(null);
    try {
      setCmp(await integrationsApi.compare(picked));
    } catch (err) {
      setError(integrationError(err));
    }
  };

  if (loading) return <LoadingBlock label="Reading local experiments…" />;
  if (!experiments.length)
    return (
      <EmptyState title="No experiments yet">
        <p>Experiments appear here after you train a model with <code>python scripts/train_model.py</code>. Training works offline and never needs Weights &amp; Biases.</p>
      </EmptyState>
    );

  const metricKeys = cmp ? [...new Set(cmp.experiments.flatMap((e) => Object.keys(e.metrics)))] : [];
  return (
    <div className="stack">
      {!wandbReady && <Alert tone="info">Weights &amp; Biases is not connected, so syncing is unavailable. Local comparison and AI summaries still work.</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Compare</th><th scope="col">Experiment</th><th scope="col">Model</th><th scope="col">Dataset</th><th scope="col">Weights &amp; Biases</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {experiments.map((e) => (
              <tr key={e.experimentId}>
                <td><input type="checkbox" aria-label={`Compare ${e.experimentId}`} checked={picked.includes(e.experimentId)} onChange={(ev) => setPicked((p) => (ev.target.checked ? [...p, e.experimentId] : p.filter((x) => x !== e.experimentId)))} /></td>
                <td><code>{e.experimentId}</code><br /><span className="dim">{e.status}{e.completedAt ? ` · ${new Date(e.completedAt).toLocaleString()}` : ''}</span></td>
                <td>{e.modelName ?? '—'} {e.modelVersion ?? ''}</td>
                <td>{e.datasetVersion ?? '—'}</td>
                <td>
                  <Badge tone={e.wandb.syncStatus === 'synced' ? 'signal' : e.wandb.syncStatus === 'failed' ? 'danger' : e.wandb.syncStatus === 'pending' ? 'ghost' : undefined}>{SYNC_TEXT[e.wandb.syncStatus]}</Badge>
                  {e.wandb.runUrl && <> <a href={e.wandb.runUrl} target="_blank" rel="noreferrer noopener">Open run</a></>}
                  {e.wandb.error && <p className="import-error">{e.wandb.error}</p>}
                </td>
                <td className="actions">
                  <div className="row-actions">
                    <Button size="sm" disabled={!wandbReady || e.status !== 'completed' || e.wandb.syncStatus === 'synced' || e.wandb.syncStatus === 'pending'} onClick={() => setOpts({ id: e.experimentId, project: defaults.project, upload: false, consent: false })}>Sync</Button>
                    <Button size="sm" variant="ghost" onClick={() => setOpen(open === e.experimentId ? null : e.experimentId)}>{open === e.experimentId ? 'Hide' : 'Explain'}</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && <section className="card"><h3 className="card-title">Evaluation of {open}</h3><AiInsight task="model_evaluation" params={{ experimentId: open }} label="Explain results with AI" disabled={experiments.find((x) => x.experimentId === open)?.status !== 'completed'} disabledReason="Only completed experiments can be explained." resetKey={open} /></section>}

      {opts && (
        <section className="card stack" aria-label="Sync options">
          <h3 className="card-title">Log {opts.id} to Weights &amp; Biases</h3>
          <p className="dim">Sends configuration, metrics, duration and the dataset version and fingerprint. Dataset files are never uploaded.</p>
          <TextField label="Project" value={opts.project} maxLength={100} onChange={(e) => setOpts({ ...opts, project: e.target.value })} />
          <Checkbox label="Also upload the model checkpoint as an artifact" checked={opts.upload} onChange={(e) => setOpts({ ...opts, upload: e.target.checked, consent: false })} />
          {opts.upload && <Checkbox label="I consent to uploading these model files to my W&B account." checked={opts.consent} onChange={(e) => setOpts({ ...opts, consent: e.target.checked })} />}
          <div className="row-actions">
            <Button variant="primary" loading={syncing !== null} disabled={!opts.project || (opts.upload && !opts.consent)} onClick={() => void sync()}>Log experiment</Button>
            <Button variant="ghost" onClick={() => setOpts(null)}>Cancel</Button>
          </div>
        </section>
      )}

      <div className="row-actions">
        <Button onClick={() => void compare()} disabled={picked.length < 2}>Compare {picked.length >= 2 ? picked.length : ''} selected</Button>
        <span className="dim">Comparison uses the metrics recorded locally.</span>
      </div>
      {cmp && (
        <section className="card stack" aria-label="Comparison">
          {cmp.warnings.map((w) => <Alert key={w} tone="warn">{w}</Alert>)}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Metric</th>{cmp.experiments.map((e) => <th key={e.experimentId} scope="col"><code>{e.experimentId.slice(-12)}</code></th>)}</tr></thead>
              <tbody>
                {metricKeys.map((k) => (
                  <tr key={k}>
                    <th scope="row">{k}</th>
                    {cmp.experiments.map((e) => <td key={e.experimentId} className="num">{k in e.metrics ? num(e.metrics[k]) : '—'}{cmp.bestByMetric[k] === e.experimentId ? ' ★' : ''}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="dim">{cmp.comparable ? '★ marks the best recorded value for each metric.' : 'No “best” is marked because these experiments are not directly comparable.'}</p>
          <AiInsight task="experiment_summary" params={{ experimentIds: picked }} label="Summarise these experiments with AI" resetKey={picked.join(',')} />
        </section>
      )}
    </div>
  );
}

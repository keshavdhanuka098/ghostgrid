import { useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GraphView } from '../components/GraphView';
import { ScenarioGate } from '../components/ScenarioGate';
import { WhatIfPanel } from '../components/WhatIfPanel';
import { Alert, Badge, Button, ButtonLink, ConfirmDialog, CritBadge, EmptyState, PageHeader, SelectField, StatTile, TextField } from '../components/ui';
import { uid } from '../lib/id';
import { compareOptions, describeChange, PRIORITIES, rankExplanations, type OptionResult, type Priority } from '../lib/mitigation';
import { ESTIMATE_LEVELS, MITIGATION_KIND_LABEL, MITIGATION_KINDS, type EstimateLevel, type MitigationKind, type Scenario, type Strategy } from '../lib/types';
import { useScenarios } from '../state/ScenarioContext';
import { useToast } from '../state/ToastContext';
import { useWhatIf } from '../state/WhatIfContext';

const ADHOC = '__current';
type Errors = Partial<Record<'dependentId' | 'providerId' | 'backupId' | 'name', string>>;

function Inner({ s }: { s: Scenario }) {
  const { updateScenario } = useScenarios();
  const toast = useToast();
  const wi = useWhatIf(s);
  const [params] = useSearchParams();
  const { assets, deps } = wi;
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const nameOf = (id: string) => byId.get(id)?.name ?? s.assets.find((a) => a.id === id)?.name ?? 'Unknown';

  // A failure handed over from the Simulation page that has not been saved as a run.
  const adhoc = useMemo(() => {
    const nodes = (params.get('fail') ?? '').split(',').filter((id) => assets.some((a) => a.id === id));
    const links = (params.get('failLink') ?? '').split(',').filter((id) => deps.some((d) => d.id === id));
    return nodes.length + links.length ? { nodes, links } : null;
    // Read once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const wanted = params.get('run');
  const [runId, setRunId] = useState(() => (adhoc ? ADHOC : s.runs.some((r) => r.id === wanted) ? wanted! : (s.runs[0]?.id ?? '')));
  const run = s.runs.find((r) => r.id === runId);
  const seed = runId === ADHOC && adhoc ? adhoc : run ? { nodes: run.failedIds, links: run.failedLinkIds } : null;
  const seedLabel = runId === ADHOC ? 'Current simulation (not saved)' : (run?.name ?? '');

  const [priority, setPriority] = useState<Priority>('impact');
  const [kind, setKind] = useState<MitigationKind>('backup');
  const [dependentId, setDependentId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [backupId, setBackupId] = useState('');
  const [label, setLabel] = useState('');
  const [cost, setCost] = useState<EstimateLevel | ''>('');
  const [effort, setEffort] = useState<EstimateLevel | ''>('');
  const [errors, setErrors] = useState<Errors>({});
  const [viewId, setViewId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Strategy | null>(null);

  const comparison = useMemo(() => (seed ? compareOptions(assets, deps, seed, s.strategies, priority) : null), [seed, assets, deps, s.strategies, priority]);
  const explanations = useMemo(() => (comparison ? rankExplanations(comparison.results, priority) : new Map<string, string>()), [comparison, priority]);

  // Options are built from the saved dependencies: a strategy is a real plan, so it cannot hang off a hypothetical link.
  const pool = kind === 'backup' ? s.dependencies.filter((d) => d.mode === 'required') : s.dependencies;
  const dependents = [...new Set(pool.map((d) => d.dependentId))].map((id) => s.assets.find((a) => a.id === id)!).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const providers = pool.filter((d) => d.dependentId === dependentId);
  const existing = new Set(s.dependencies.filter((d) => d.dependentId === dependentId).map((d) => d.providerId));
  const backups = s.assets.filter((a) => a.id !== dependentId && !existing.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
  const failsInBaseline = new Set(comparison?.baseline.failed ?? []);

  const patch = (id: string, change: Partial<Strategy>) => updateScenario(s.id, (cur) => ({ ...cur, strategies: cur.strategies.map((m) => (m.id === id ? { ...m, ...change } : m)) }));

  if (s.runs.length === 0 && !adhoc)
    return (
      <>
        <PageHeader title="Mitigation comparison" />
        <EmptyState title="Save a failure run first" actions={<ButtonLink to="/app/simulation" variant="primary">Go to simulation</ButtonLink>}>
          Mitigations are compared against a specific failure. Run a simulation and save it (or press Compare mitigations there), and it will appear here.
        </EmptyState>
      </>
    );

  const add = (ev: FormEvent) => {
    ev.preventDefault();
    const e: Errors = {};
    if (!dependentId) e.dependentId = 'Choose the asset to protect.';
    if (dependentId && !providerId) e.providerId = 'Choose the dependency to change.';
    if (kind === 'backup' && !backupId) e.backupId = 'Choose the backup provider.';
    const auto = dependentId && providerId ? (kind === 'backup' ? `${nameOf(backupId)} backs up ${nameOf(dependentId)}` : `${nameOf(dependentId)} stops relying on ${nameOf(providerId)}`) : '';
    const name = label.trim() || auto;
    if (name.length > 80) e.name = 'Keep the name under 80 characters.';
    else if (name && s.strategies.some((m) => m.name.toLowerCase() === name.toLowerCase())) e.name = 'A strategy already uses this name.';
    setErrors(e);
    if (Object.keys(e).length) return;
    const strategy: Strategy = { id: uid('mt'), name, kind, dependentId, providerId, backupId: kind === 'backup' ? backupId : '', costLevel: cost || null, effortLevel: effort || null };
    updateScenario(s.id, (cur) => ({ ...cur, strategies: [...cur.strategies, strategy] }));
    toast.success(`Added strategy “${name}”.`);
    setProviderId('');
    setBackupId('');
    setLabel('');
  };

  const results = comparison?.results ?? [];
  const baseline = comparison!.baseline;
  const top = results.find((r) => r.valid);
  const viewing: OptionResult | undefined = viewId === 'baseline' ? undefined : (results.find((r) => r.option.id === viewId && r.valid) ?? top);
  const levelSelect = (r: OptionResult, field: 'costLevel' | 'effortLevel', what: string) => (
    <select className="select select-sm" value={r.option[field] ?? ''} aria-label={`${what} estimate for ${r.option.name}`} onChange={(e) => patch(r.option.id, { [field]: e.target.value || null })}>
      <option value="">Not estimated</option>
      {ESTIMATE_LEVELS.map((l) => (
        <option key={l} value={l}>{l[0].toUpperCase() + l.slice(1)}</option>
      ))}
    </select>
  );

  // Services affected before and after the viewed option.
  const rows = viewing
    ? [...new Set([...baseline.failed, ...viewing.outcome.failed])]
        .map((id) => ({ id, a: byId.get(id), before: baseline.sim.failed.has(id), after: viewing.outcome.sim.failed.has(id) }))
        .filter((r) => r.a)
        .sort((x, y) => Number(y.before && y.after) - Number(x.before && x.after) || x.a!.name.localeCompare(y.a!.name))
    : [];

  return (
    <>
      <PageHeader title="Mitigation comparison" description="Compare options that give an asset a backup provider or remove a dependency. Each option is tested against the failure you choose, then ranked by the priority you pick." />
      <WhatIfPanel s={s} focus={{ seed: seed ?? undefined }} />

      <div className="toolbar">
        <SelectField label="Failure to test against" value={runId} onChange={(e) => { setRunId(e.target.value); setViewId(null); }}>
          {adhoc && <option value={ADHOC}>Current simulation (not saved)</option>}
          {s.runs.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </SelectField>
        <p className="dim toolbar-note">
          {seedLabel}: <strong>{baseline.total}</strong> assets down, <strong>{baseline.critical}</strong> critical.
        </p>
      </div>

      <section className="card" aria-labelledby="build-title">
        <h2 id="build-title" className="card-title">Add a mitigation option</h2>
        <p className="card-sub build-sub">Cost and effort are your own rough estimates. GhostGrid never converts them to money or time.</p>
        <form onSubmit={add} noValidate>
          <div className="build-grid">
            <SelectField label="Type" value={kind} onChange={(e) => { setKind(e.target.value as MitigationKind); setDependentId(''); setProviderId(''); setBackupId(''); }}>
              {MITIGATION_KINDS.map((k) => (
                <option key={k} value={k}>{MITIGATION_KIND_LABEL[k]}</option>
              ))}
            </SelectField>
            <SelectField label="Protect this asset" value={dependentId} error={errors.dependentId} onChange={(e) => { setDependentId(e.target.value); setProviderId(''); setBackupId(''); }}>
              <option value="">Choose asset</option>
              {dependents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </SelectField>
            <SelectField label={kind === 'backup' ? 'Against failure of' : 'Stop relying on'} value={providerId} error={errors.providerId} disabled={!dependentId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">{dependentId ? 'Choose dependency' : 'Choose an asset first'}</option>
              {providers.map((d) => (
                <option key={d.id} value={d.providerId}>{nameOf(d.providerId)}</option>
              ))}
            </SelectField>
            {kind === 'backup' && (
              <SelectField label="Using backup" value={backupId} error={errors.backupId} disabled={!dependentId} hint={backupId && failsInBaseline.has(backupId) ? 'This asset also fails in the selected run, so it may not help.' : undefined} onChange={(e) => setBackupId(e.target.value)}>
                <option value="">{dependentId ? 'Choose backup' : 'Choose an asset first'}</option>
                {backups.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}{failsInBaseline.has(a.id) ? ' (fails in this run)' : ''}</option>
                ))}
              </SelectField>
            )}
            <SelectField label="Cost (your estimate)" value={cost} onChange={(e) => setCost(e.target.value as EstimateLevel | '')}>
              <option value="">Not estimated</option>
              {ESTIMATE_LEVELS.map((l) => <option key={l} value={l}>{l[0].toUpperCase() + l.slice(1)}</option>)}
            </SelectField>
            <SelectField label="Effort (your estimate)" value={effort} onChange={(e) => setEffort(e.target.value as EstimateLevel | '')}>
              <option value="">Not estimated</option>
              {ESTIMATE_LEVELS.map((l) => <option key={l} value={l}>{l[0].toUpperCase() + l.slice(1)}</option>)}
            </SelectField>
            <TextField label="Name (optional)" value={label} maxLength={90} error={errors.name} placeholder="Auto-named if left empty" onChange={(e) => setLabel(e.target.value)} />
          </div>
          <Button type="submit" variant="primary" className="build-submit">Add option</Button>
        </form>
      </section>

      <section aria-labelledby="cmp-title">
        <h2 id="cmp-title" className="section-title">Ranking</h2>
        <div className="seg" role="radiogroup" aria-label="Mitigation priority">
          {(Object.keys(PRIORITIES) as Priority[]).map((p) => (
            <button key={p} role="radio" aria-checked={priority === p} className="seg-btn" onClick={() => setPriority(p)}>{PRIORITIES[p].label}</button>
          ))}
        </div>
        <p className="dim panel-note">{PRIORITIES[priority].description}</p>
        {s.strategies.length === 0 ? (
          <EmptyState title="No options yet">Add an option above to see how it changes the outcome of “{seedLabel}”.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table cmp">
              <caption className="sr-only">Mitigation options ranked by {PRIORITIES[priority].label} for {seedLabel}</caption>
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Option and why it ranks here</th>
                  <th scope="col">Assets down</th>
                  <th scope="col" className="num">Critical</th>
                  <th scope="col" className="num">Avoided</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Effort</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="mono">–</td>
                  <td><div className="cell-name">Baseline (no change)</div></td>
                  <td><div className="bar" aria-hidden="true"><i style={{ width: '100%' }} /></div><span className="bar-n mono">{baseline.total}</span></td>
                  <td className="num">{baseline.critical}</td>
                  <td className="num">–</td>
                  <td>–</td>
                  <td>–</td>
                  <td className="actions"><Button size="sm" variant="ghost" onClick={() => setViewId('baseline')} aria-pressed={viewId === 'baseline'}>View</Button></td>
                </tr>
                {results.map((r) => (
                  <tr key={r.option.id} data-active={viewing?.option.id === r.option.id ? 'true' : undefined}>
                    <td className="mono">{r.rank ?? '–'}</td>
                    <td>
                      <div className="cell-name">
                        {r.option.name} <Badge>{MITIGATION_KIND_LABEL[r.option.kind]}</Badge> {!r.valid && <Badge tone="danger">Cannot apply</Badge>}
                      </div>
                      <div className="cell-note">{explanations.get(r.option.id)}</div>
                    </td>
                    <td><div className="bar" aria-hidden="true"><i style={{ width: `${(r.outcome.total / Math.max(1, baseline.total)) * 100}%` }} /></div><span className="bar-n mono">{r.outcome.total}</span></td>
                    <td className="num">{r.outcome.critical}</td>
                    <td className="num">{baseline.total - r.outcome.total}</td>
                    <td>{levelSelect(r, 'costLevel', 'Cost')}</td>
                    <td>{levelSelect(r, 'effortLevel', 'Effort')}</td>
                    <td className="actions">
                      <div className="row-actions">
                        <Button size="sm" variant="ghost" onClick={() => setViewId(r.option.id)} aria-pressed={viewing?.option.id === r.option.id} disabled={!r.valid}>Compare</Button>
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(r.option)} aria-label={`Remove option ${r.option.name}`}>Remove</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="view-title" className="view-block">
        <h2 id="view-title" className="section-title">Before and after{viewing ? `: ${viewing.option.name}` : ''}</h2>
        {!viewing ? (
          <Alert>Choose an option and press Compare to see the dependency graph and affected services before and after it. The baseline graph is shown below.</Alert>
        ) : (
          <>
            <div className="stat-grid">
              <StatTile label="Assets down: before → after" value={`${baseline.total} → ${viewing.outcome.total}`} tone={viewing.outcome.total < baseline.total ? 'signal' : undefined} />
              <StatTile label="Critical down: before → after" value={`${baseline.critical} → ${viewing.outcome.critical}`} tone={viewing.outcome.critical < baseline.critical ? 'signal' : undefined} />
              <StatTile label="Weighted impact: before → after" value={`${comparison!.baselineMetrics.weighted} → ${viewing.residual.weighted}`} />
              <StatTile label="Assets protected" value={viewing.protectedIds.length} tone={viewing.protectedIds.length ? 'signal' : undefined} />
            </div>
            <p className="dim">
              {viewing.protectedIds.length === 0 ? 'This option does not protect any asset in this run. The failure still reaches the same assets by another path.' : `${viewing.protectedIds.length} asset${viewing.protectedIds.length === 1 ? ' is' : 's are'} protected (amber, after).`}
              {viewing.worsenedIds.length > 0 && ` Warning: ${viewing.worsenedIds.map(nameOf).join(', ')} fail only with this option.`}
            </p>
          </>
        )}
        <div className="ba-grid">
          <div>
            <h3 className="panel-h">Before (current dependencies)</h3>
            <GraphView assets={assets} dependencies={deps} label="Dependency graph before the option" failedIds={baseline.sim.failed} failedLinkIds={new Set(baseline.sim.seedLinks)} whatIfLinkIds={wi.changedLinks} linkMarkers height={380} />
          </div>
          {viewing && (
            <div>
              <h3 className="panel-h">After ({viewing.option.name})</h3>
              <GraphView assets={assets} dependencies={viewing.deps} label={`Dependency graph after ${viewing.option.name}`} failedIds={viewing.outcome.sim.failed} failedLinkIds={new Set(viewing.outcome.sim.seedLinks)} highlightIds={new Set(viewing.protectedIds)} highlightLabel="Protected by this option" linkMarkers height={380} />
            </div>
          )}
        </div>
        {viewing && (
          <>
            <h3 className="panel-h">Dependency changes</h3>
            <ul className="plain-list">{viewing.changes.map((c, i) => <li key={i}>{describeChange(c, nameOf)}</li>)}</ul>
            <h3 className="panel-h">Affected services, before and after</h3>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th scope="col">Service</th><th scope="col">Criticality</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Change</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.a!.name}</td>
                      <td><CritBadge level={r.a!.criticality} /></td>
                      <td>{r.before ? 'Down' : 'Up'}</td>
                      <td>{r.after ? 'Down' : 'Up'}</td>
                      <td>{r.before && !r.after ? <Badge tone="signal">Protected</Badge> : r.before && r.after ? <Badge tone="danger">Still down</Badge> : <Badge tone="danger">Newly down</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 className="panel-h">Assumptions and limits</h3>
            <ul className="plain-list">{viewing.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </>
        )}
      </section>

      <ConfirmDialog
        open={!!removing}
        danger
        title={`Remove “${removing?.name ?? ''}”?`}
        confirmLabel="Remove option"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          updateScenario(s.id, (cur) => ({ ...cur, strategies: cur.strategies.filter((m) => m.id !== removing.id) }));
          if (viewId === removing.id) setViewId(null);
          toast.success(`Removed “${removing.name}”.`);
          setRemoving(null);
        }}
      >
        <p>The option is deleted from this scenario. Your mapped dependencies are not changed.</p>
      </ConfirmDialog>
    </>
  );
}

export default function Mitigation() {
  return (
    <ScenarioGate title="Mitigation comparison" description="Compare mitigations against a failure.">
      {(s) => <Inner key={s.id} s={s} />}
    </ScenarioGate>
  );
}

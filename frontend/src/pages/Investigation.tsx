import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GraphView } from '../components/GraphView';
import { ScenarioGate } from '../components/ScenarioGate';
import { DependencyTrace } from '../components/DependencyTrace';
import { WhatIfPanel } from '../components/WhatIfPanel';
import { Alert, Badge, ButtonLink, Checkbox, CritBadge, EmptyState, PageHeader, TextField } from '../components/ui';
import { upstreamPaths } from '../lib/trace';
import { useWhatIf } from '../state/WhatIfContext';
import { findSharedDependencies, simulate, traceChain, type SharedDependency } from '../lib/graph';
import { KIND_LABEL, type Scenario } from '../lib/types';

function Detail({ s, item }: { s: Scenario; item: SharedDependency }) {
  const sim = useMemo(() => simulate(s.assets, s.dependencies, [item.asset.id]), [s.assets, s.dependencies, item.asset.id]);
  const byId = useMemo(() => new Map(s.assets.map((a) => [a.id, a])), [s.assets]);
  const hidden = useMemo(() => new Set(item.hidden), [item.hidden]);
  const rows = item.reached
    .map((id) => ({ asset: byId.get(id)!, round: sim.roundOf.get(id) ?? 0, chain: traceChain(sim, id) }))
    .sort((a, b) => a.round - b.round || a.asset.name.localeCompare(b.asset.name));

  return (
    <section className="card detail" aria-labelledby="detail-title">
      <div className="card-head">
        <div>
          <h2 id="detail-title" className="card-title">
            {item.asset.name}
          </h2>
          <p className="card-sub">
            {KIND_LABEL[item.asset.kind]} · {item.asset.criticality} criticality
          </p>
        </div>
        <div className="row-actions">
          <ButtonLink size="sm" variant="primary" to={`/app/simulation?fail=${encodeURIComponent(item.asset.id)}`}>
            Simulate this failure
          </ButtonLink>
          <ButtonLink size="sm" to={`/app/investigation?view=trace&asset=${encodeURIComponent(item.asset.id)}`}>
            Trace dependencies
          </ButtonLink>
          <ButtonLink size="sm" to={`/app/graph?focus=${encodeURIComponent(item.asset.id)}`}>
            Open in graph
          </ButtonLink>
        </div>
      </div>

      <p>
        If <strong>{item.asset.name}</strong> fails, <strong>{item.reached.length}</strong> other asset{item.reached.length === 1 ? '' : 's'} fail. Only{' '}
        <strong>{item.direct.length}</strong> of them list it as a direct dependency; <strong className="ghost-text">{item.hidden.length}</strong> reach it through other assets.
        {item.criticalReached.length > 0 && (
          <>
            {' '}
            Critical assets affected: {item.criticalReached.map((id) => byId.get(id)?.name).join(', ')}.
          </>
        )}
      </p>

      <GraphView
        assets={s.assets}
        dependencies={s.dependencies}
        label={`Failure reach of ${item.asset.name}`}
        failedIds={new Set([item.asset.id, ...item.reached])}
        highlightIds={hidden}
        highlightLabel="Reached only indirectly"
        height={380}
      />

      <h3 className="panel-h">How the failure travels</h3>
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Assets affected if {item.asset.name} fails</caption>
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col">Criticality</th>
              <th scope="col">Exposure</th>
              <th scope="col">Round</th>
              <th scope="col">Path</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.asset.id}>
                <td>{r.asset.name}</td>
                <td>
                  <CritBadge level={r.asset.criticality} />
                </td>
                <td>{hidden.has(r.asset.id) ? <Badge tone="ghost">Hidden</Badge> : <Badge tone="signal">Direct</Badge>}</td>
                <td className="num">{r.round}</td>
                <td className="path">{r.chain.map((id) => byId.get(id)?.name).join(' → ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Inner({ s: saved }: { s: Scenario }) {
  const [params] = useSearchParams();
  const wi = useWhatIf(saved);
  // Every analysis below runs on the effective model: the saved one, or the hypothetical one when a what-if is applied.
  const s = useMemo<Scenario>(() => ({ ...saved, assets: wi.assets, dependencies: wi.deps }), [saved, wi.assets, wi.deps]);
  const [view, setView] = useState<'trace' | 'shared'>(params.get('view') === 'trace' ? 'trace' : 'shared');
  const [traceId, setTraceId] = useState<string>(() => {
    const w = params.get('asset');
    if (w && saved.assets.some((a) => a.id === w)) return w;
    return [...saved.assets].sort((a, b) => upstreamPaths(saved.assets, saved.dependencies, b.id).length - upstreamPaths(saved.assets, saved.dependencies, a.id).length || a.name.localeCompare(b.name))[0]?.id ?? '';
  });
  const traceTarget = s.assets.some((a) => a.id === traceId) ? traceId : (s.assets[0]?.id ?? '');
  const shared = useMemo(() => findSharedDependencies(s.assets, s.dependencies), [s.assets, s.dependencies]);
  const wanted = params.get('asset');
  const [onlyShared, setOnlyShared] = useState(() => !shared.some((x) => x.asset.id === wanted && !x.isHiddenShared));
  const [query, setQuery] = useState('');
  const [selId, setSelId] = useState<string | null>(wanted);

  const visible = shared.filter((x) => (!onlyShared || x.isHiddenShared) && x.asset.name.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = visible.find((x) => x.asset.id === selId) ?? visible[0] ?? null;

  const header = (
    <PageHeader
      title="Investigation"
      description="Trace what an asset relies on, find shared dependencies and single points of failure, and see which relationships are confirmed, inferred or unknown."
    />
  );

  if (s.dependencies.length === 0 && view === 'shared')
    return (
      <>
        {header}
        <WhatIfPanel s={saved} />
        <EmptyState title="No dependencies to investigate" actions={<ButtonLink to="/app/scenarios" variant="primary">Map dependencies</ButtonLink>}>
          Hidden shared dependencies are found by following mapped dependencies through the system. Add some in the workspace first.
        </EmptyState>
      </>
    );

  const tabs = (
    <div className="seg" role="radiogroup" aria-label="Investigation view">
      <button role="radio" aria-checked={view === 'trace'} className="seg-btn" onClick={() => setView('trace')}>Dependency trace</button>
      <button role="radio" aria-checked={view === 'shared'} className="seg-btn" onClick={() => setView('shared')}>Hidden shared dependencies</button>
    </div>
  );

  if (view === 'trace')
    return (
      <>
        {header}
        <WhatIfPanel s={saved} focus={{ targetId: traceTarget }} />
        {tabs}
        <DependencyTrace assets={s.assets} deps={s.dependencies} targetId={traceTarget} onTarget={setTraceId} changedLinks={wi.changedLinks} />
      </>
    );

  return (
    <>
      {header}
      <WhatIfPanel s={saved} />
      {tabs}
      <Alert>
        <strong>How this works.</strong> For each asset, GhostGrid simulates its failure and separates the assets that fail into <em>direct</em> (they list it as a provider) and <em>hidden</em> (they only fail through other assets). An asset with two or more hidden exposures is flagged as a hidden shared dependency. Results reflect only what you have mapped.
      </Alert>

      <div className="toolbar">
        <TextField label="Search assets" type="search" value={query} placeholder="Filter by name" onChange={(e) => setQuery(e.target.value)} />
        <Checkbox checked={onlyShared} onChange={(e) => setOnlyShared(e.target.checked)} label="Only hidden shared (2+ hidden exposures)" />
      </div>

      {shared.length === 0 ? (
        <EmptyState title="No hidden exposure found">
          Every failure in “{s.name}” reaches only assets that list the failed asset as a direct dependency. If that seems too tidy, check that indirect dependencies are mapped.
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState
          title="No assets match"
          actions={
            <>
              {query && (
                <button className="btn" onClick={() => setQuery('')}>
                  Clear search
                </button>
              )}
              {onlyShared && (
                <button className="btn" onClick={() => setOnlyShared(false)}>
                  Show all indirect exposure
                </button>
              )}
            </>
          }
        >
          Nothing matches the current filters.
        </EmptyState>
      ) : (
        <div className="invest-layout">
          <nav aria-label="Ranked assets" className="rank">
            <ol>
              {visible.map((x, i) => (
                <li key={x.asset.id}>
                  <button className="rank-item" aria-current={selected?.asset.id === x.asset.id ? 'true' : undefined} onClick={() => setSelId(x.asset.id)}>
                    <span className="rank-n mono">{i + 1}</span>
                    <span className="rank-body">
                      <span className="rank-name">{x.asset.name}</span>
                      <span className="rank-meta">
                        {x.hidden.length} hidden · {x.direct.length} direct
                      </span>
                    </span>
                    {x.isHiddenShared && <Badge tone="ghost">Shared</Badge>}
                    {x.criticalReached.length > 0 && <Badge tone="danger">{x.criticalReached.length} crit</Badge>}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          {selected && <Detail key={selected.asset.id} s={s} item={selected} />}
        </div>
      )}
    </>
  );
}

export default function Investigation() {
  return (
    <ScenarioGate title="Investigation" description="Find assets whose failure reaches others indirectly.">
      {(s) => <Inner key={s.id} s={s} />}
    </ScenarioGate>
  );
}

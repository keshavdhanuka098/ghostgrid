import { useMemo, useState } from 'react';
import { evidenceNeeded, FINDING_LABEL, investigate, type Finding } from '../lib/analysis';
import { simulateFailure, traceAsset, type TraceMode } from '../lib/graph';
import { chainIds, downstreamPaths, sharedBetween, upstreamPaths, type PathEntry } from '../lib/trace';
import { STATUS_HELP, type Asset, type Dependency, type LinkStatus } from '../lib/types';
import { GraphView } from './GraphView';
import { StatusBadge } from './editors';
import { Alert, Badge, ButtonLink, CritBadge, EmptyState, SelectField, StatTile } from './ui';

const STATUSES: LinkStatus[] = ['confirmed', 'inferred', 'unknown'];
const DIRS: { id: Exclude<TraceMode, 'off'>; label: string }[] = [
  { id: 'both', label: 'Both' },
  { id: 'up', label: 'Upstream' },
  { id: 'down', label: 'Downstream' },
];

interface Props {
  assets: Asset[];
  deps: Dependency[];
  targetId: string;
  onTarget: (id: string) => void;
  /** Links under a what-if assumption (amber halo). */
  changedLinks: Set<string>;
}

/** Target-centred dependency trace: paths up and down, shared dependencies, and findings with their evidence. */
export function DependencyTrace({ assets, deps, targetId, onTarget, changedLinks }: Props) {
  const [dir, setDir] = useState<Exclude<TraceMode, 'off'>>('both');
  const [otherId, setOtherId] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const nameOf = (id: string) => byId.get(id)?.name ?? 'Unknown';
  const target = byId.get(targetId);

  const inv = useMemo(() => investigate(assets, deps, targetId), [assets, deps, targetId]);
  const up = useMemo(() => upstreamPaths(assets, deps, targetId), [assets, deps, targetId]);
  const down = useMemo(() => downstreamPaths(assets, deps, targetId), [assets, deps, targetId]);
  const trace = useMemo(() => traceAsset(assets, deps, targetId, dir), [assets, deps, targetId, dir]);
  const shared = useMemo(() => (otherId ? sharedBetween(assets, deps, targetId, otherId) : []), [assets, deps, targetId, otherId]);
  const findingAssets = useMemo(() => new Set((inv?.findings ?? []).map((f) => f.asset.id)), [inv]);
  const sorted = [...assets].sort((a, b) => a.name.localeCompare(b.name));

  if (!target || !inv) return <EmptyState title="Choose an asset to trace">Pick an asset to see what it relies on and what relies on it.</EmptyState>;

  const unconfirmedPaths = up.filter((e) => e.status !== 'confirmed').length;
  const counts = STATUSES.map((st) => [st, deps.filter((d) => trace.links.has(d.id) && d.status === st).length] as const);

  const pathRow = (e: PathEntry) => (
    <li key={e.asset.id} className="trace-row" data-status={e.status}>
      <div className="trace-row-head">
        <strong>{e.asset.name}</strong> <CritBadge level={e.asset.criticality} /> <StatusBadge status={e.status} />
        <span className="dim"> {e.hops} hop{e.hops === 1 ? '' : 's'}</span>
        {findingAssets.has(e.asset.id) && <Badge tone="ghost">Finding</Badge>}
      </div>
      <ol className="path-chain" aria-label={`Path: ${chainIds(e.links).map(nameOf).join(' relies on ')}`}>
        {chainIds(e.links).map((id, i) => (
          <li key={i}>
            {i > 0 && <span className={`path-link st-${e.links[i - 1].status}`} title={`${e.links[i - 1].status}${e.links[i - 1].mode === 'alternate' ? ', alternate' : ''}`}><StatusBadge status={e.links[i - 1].status} />{e.links[i - 1].mode === 'alternate' ? ' alt' : ''}</span>}
            <span className="path-node">{nameOf(id)}</span>
          </li>
        ))}
      </ol>
    </li>
  );

  const FindingCard = ({ f }: { f: Finding }) => {
    const hit = simulateFailure(assets, deps, { nodes: [f.asset.id] });
    const affected = [...hit.failed].filter((id) => id !== f.asset.id).map((id) => byId.get(id)!).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    const tier: LinkStatus | null = f.evidence;
    return (
      <article className="finding" data-kind={f.kind} data-focus={focusId === f.id ? 'true' : undefined}>
        <header className="finding-head">
          <h4 className="finding-title">{FINDING_LABEL[f.kind]}: {f.asset.name}</h4>
          {tier ? <StatusBadge status={tier} /> : <Badge>Does not fail {target.name} on its own</Badge>}
          <Badge>{f.direct ? 'Direct provider' : `${f.hops} hops upstream`}</Badge>
        </header>
        <p className="finding-evidence">
          {tier === 'confirmed' && <>Confirmed: every link that carries this failure is verified.</>}
          {tier === 'inferred' && <>Inferred: the failure reaches {target.name} only through links nobody has verified.</>}
          {tier === 'unknown' && <>Unknown: the failure path includes links that might not exist. They are treated as live to be cautious.</>}
          {!tier && <>Possible: it would take {target.name} down only if the unconfirmed links below exist.</>}
        </p>
        <ul className="plain-list">{f.why.map((w, i) => <li key={i}>{w}</li>)}</ul>
        {f.convergesVia.length > 1 && <p className="dim">Reached through {f.convergesVia.map((a) => a.name).join(' and ')}.</p>}
        <p><strong>Affected services if {f.asset.name} fails ({affected.length}):</strong>{' '}
          {affected.length === 0 ? 'none besides itself.' : affected.map((a) => <span key={a.id} className="aff">{a.name} <CritBadge level={a.criticality} /></span>)}
        </p>
        {f.support.length > 0 && (
          <details>
            <summary>Evidence ({f.support.length} link{f.support.length === 1 ? '' : 's'})</summary>
            <ul className="link-list">{f.support.map((d) => <li key={d.id}><StatusBadge status={d.status} /> {nameOf(d.dependentId)} → {nameOf(d.providerId)}{d.mode === 'alternate' ? ' (alternate)' : ''}</li>)}</ul>
            {f.unconfirmed.length > 0 && (
              <div className="alert alert-warn">
                Rests on {f.unconfirmed.length} unverified link{f.unconfirmed.length === 1 ? '' : 's'}. To verify:
                <ul className="plain-list">{f.unconfirmed.map((d) => <li key={d.id}>{nameOf(d.dependentId)} → {nameOf(d.providerId)}: {evidenceNeeded(d, null, nameOf).evidence[0] ?? 'Check it against documentation or by testing.'}</li>)}</ul>
              </div>
            )}
          </details>
        )}
        <div className="row-actions">
          <ButtonLink size="sm" variant="primary" to={`/app/simulation?fail=${encodeURIComponent(f.asset.id)}`}>Simulate this failure</ButtonLink>
          <button className="btn btn-sm" onClick={() => setFocusId(focusId === f.id ? null : f.id)}>{focusId === f.id ? 'Clear highlight' : 'Show on graph'}</button>
        </div>
      </article>
    );
  };

  const focusAsset = inv.findings.find((f) => f.id === focusId)?.asset.id;
  return (
    <div className="trace-view">
      <div className="toolbar">
        <SelectField label="Trace asset" value={targetId} onChange={(e) => { onTarget(e.target.value); setFocusId(null); setOtherId(''); }}>
          {sorted.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </SelectField>
        <div className="seg" role="radiogroup" aria-label="Trace direction">
          {DIRS.map((d) => <button key={d.id} role="radio" aria-checked={dir === d.id} className="seg-btn" onClick={() => setDir(d.id)}>{d.label}</button>)}
        </div>
        <SelectField label="Shared dependencies with" value={otherId} onChange={(e) => setOtherId(e.target.value)}>
          <option value="">No comparison</option>
          {sorted.filter((a) => a.id !== targetId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </SelectField>
      </div>

      <div className="stat-grid">
        <StatTile label="Relies on (upstream)" value={up.length} />
        <StatTile label="Relied on by (downstream)" value={down.length} />
        <StatTile label="Findings" value={inv.findings.length} tone={inv.findings.length ? 'ghost' : undefined} />
        <StatTile label="Upstream paths not fully confirmed" value={unconfirmedPaths} tone={unconfirmedPaths ? 'danger' : undefined} />
      </div>

      <GraphView assets={assets} dependencies={deps} label={`Dependency trace of ${target.name}`} trace={trace} selectedId={targetId} onSelect={onTarget} highlightIds={focusAsset ? new Set([focusAsset]) : findingAssets} highlightLabel={focusAsset ? 'Selected finding' : 'Has a finding'} whatIfLinkIds={changedLinks} linkMarkers height={420} />

      <section aria-label="Relationship evidence key" className="evidence-key">
        <h3 className="panel-h">How sure are we? Relationships on this trace</h3>
        <ul className="evidence-list">
          {counts.map(([st, n]) => (
            <li key={st}><StatusBadge status={st} /> <strong>{n}</strong> link{n === 1 ? '' : 's'}. <span className="dim">{STATUS_HELP[st]}</span></li>
          ))}
        </ul>
      </section>

      <div className="trace-cols">
        {(dir === 'both' || dir === 'up') && (
          <section aria-labelledby="up-title">
            <h3 id="up-title" className="panel-h">Upstream: {target.name} relies on ({up.length})</h3>
            {up.length === 0 ? <p className="dim">Nothing is mapped upstream of {target.name}.</p> : <ul className="trace-rows">{up.map(pathRow)}</ul>}
          </section>
        )}
        {(dir === 'both' || dir === 'down') && (
          <section aria-labelledby="down-title">
            <h3 id="down-title" className="panel-h">Downstream: relies on {target.name} ({down.length})</h3>
            {down.length === 0 ? <p className="dim">Nothing is mapped as relying on {target.name}.</p> : <ul className="trace-rows">{down.map(pathRow)}</ul>}
          </section>
        )}
      </div>

      {otherId && (
        <section aria-labelledby="shared-title">
          <h3 id="shared-title" className="panel-h">Shared dependencies: {target.name} and {nameOf(otherId)}</h3>
          {shared.length === 0 ? <p className="dim">No mapped dependency is shared by both. That only means none has been mapped.</p> : (
            <ul className="link-list">{shared.map((x) => <li key={x.asset.id}><strong>{x.asset.name}</strong> <CritBadge level={x.asset.criticality} /> <StatusBadge status={x.status} /> <span className="dim">{x.hopsA} hop{x.hopsA === 1 ? '' : 's'} from {target.name}, {x.hopsB} from {nameOf(otherId)}</span></li>)}</ul>
          )}
        </section>
      )}

      <section aria-labelledby="find-title">
        <h3 id="find-title" className="panel-h">Findings for {target.name} ({inv.findings.length})</h3>
        {inv.findings.length === 0 ? <Alert>No single point of failure or shared dependency was found upstream of {target.name} in what is mapped.</Alert> : <div className="findings">{inv.findings.map((f) => <FindingCard key={f.id} f={f} />)}</div>}
      </section>

      {inv.gaps.length > 0 && (
        <section aria-labelledby="gaps-title">
          <h3 id="gaps-title" className="panel-h">Unknowns and gaps ({inv.gaps.length})</h3>
          <ul className="plain-list">{inv.gaps.map((g, i) => <li key={i}>{g.link && <StatusBadge status={g.link.status} />} {g.text}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

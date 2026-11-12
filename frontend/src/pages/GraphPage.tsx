import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AssetDialog, AssumptionDialog, DependencyDialog, StatusBadge } from '../components/editors';
import { GraphView, type GraphHandle } from '../components/GraphView';
import { ScenarioGate } from '../components/ScenarioGate';
import { Alert, Badge, Button, ButtonLink, Checkbox, ConfirmDialog, CritBadge, EmptyState, PageHeader, SelectField, TextField } from '../components/ui';
import { findSharedDependencies, traceAsset, type Trace, type TraceMode } from '../lib/graph';
import { assumptionsFor, clearPositions, removalImpact, removeAsset, removeDependency, setAssetPosition, updateDependency } from '../lib/scenarioOps';
import {
  ASSET_KINDS,
  CONFIDENCE_LABEL,
  KIND_LABEL,
  LINK_STATUSES,
  RELATION_LABEL,
  STATUS_GLYPH,
  STATUS_HELP,
  STATUS_LABEL,
  type Asset,
  type AssetKind,
  type Dependency,
  type LinkStatus,
  type Scenario,
} from '../lib/types';
import { useScenarios } from '../state/ScenarioContext';
import { useSettings } from '../state/SettingsContext';
import { useToast } from '../state/ToastContext';

/* ------------------------------------------------------------ small parts */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h3 className="panel-h">{title}</h3>
      {children}
    </>
  );
}

const TRACE_LABEL: Record<TraceMode, string> = { off: 'Off', up: 'Upstream', down: 'Downstream', both: 'Both' };

/* ----------------------------------------------------------------- panel */

interface PanelProps {
  s: Scenario;
  asset: Asset | undefined;
  link: Dependency | undefined;
  trace: Trace | null;
  traceMode: TraceMode;
  setTraceMode: (m: TraceMode) => void;
  selectNode: (id: string, center?: boolean) => void;
  selectLink: (id: string) => void;
  onAddAsset: () => void;
  onAddDependency: (preset?: { dependentId?: string; providerId?: string }) => void;
  onEditAsset: (a: Asset) => void;
  onDeleteAsset: (a: Asset) => void;
  onEditLink: (d: Dependency) => void;
  onDeleteLink: (d: Dependency) => void;
  onAddAssumption: (type: 'node' | 'link', id: string) => void;
}

function Assumptions({ s, type, id, onAdd }: { s: Scenario; type: 'node' | 'link'; id: string; onAdd: () => void }) {
  const list = assumptionsFor(s, type, id);
  return (
    <Section title={`Assumptions (${list.length})`}>
      {list.length === 0 ? (
        <p className="dim panel-note">None recorded.</p>
      ) : (
        <ul className="assumption-list">
          {list.map((a) => (
            <li key={a.id}>
              <p>{a.text}</p>
              <Badge>{CONFIDENCE_LABEL[a.confidence]}</Badge>
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" onClick={onAdd}>
        Add assumption
      </Button>
    </Section>
  );
}

function Panel(p: PanelProps) {
  const { s, asset, link, trace } = p;
  const name = (id: string) => s.assets.find((a) => a.id === id)?.name ?? 'Unknown';
  const { updateScenario } = useScenarios();
  const toast = useToast();

  if (!asset && !link) {
    const count = (st: LinkStatus) => s.dependencies.filter((d) => d.status === st).length;
    return (
      <aside className="card panel" aria-label="Details">
        <h2 className="card-title">Scenario overview</h2>
        <p className="dim panel-note">
          {s.assets.length} assets · {s.dependencies.length} dependencies
        </p>
        <ul className="status-count">
          {LINK_STATUSES.map((st) => (
            <li key={st}>
              <StatusBadge status={st} /> <strong>{count(st)}</strong>
            </li>
          ))}
        </ul>
        <Section title="Working with the graph">
          <ul className="tips">
            <li>Click an asset to see what it relies on and what relies on it.</li>
            <li>Click a link to inspect or change how well it is known.</li>
            <li>Drag assets to rearrange them. Drag the background to pan.</li>
            <li>
              Use <strong>Connect</strong> to draw a new dependency between two assets.
            </li>
          </ul>
        </Section>
        <div className="panel-actions">
          <Button variant="primary" onClick={p.onAddAsset}>
            Add asset
          </Button>
          <Button onClick={() => p.onAddDependency()} disabled={s.assets.length < 2}>
            Add dependency
          </Button>
        </div>
      </aside>
    );
  }

  if (link) {
    return (
      <aside className="card panel" aria-label="Dependency details">
        <p className="eyebrow">Dependency</p>
        <h2 className="card-title link-title">
          <button className="link-btn" onClick={() => p.selectNode(link.dependentId, true)}>
            {name(link.dependentId)}
          </button>{' '}
          relies on{' '}
          <button className="link-btn" onClick={() => p.selectNode(link.providerId, true)}>
            {name(link.providerId)}
          </button>
        </h2>
        <div className="editor-meta">
          <StatusBadge status={link.status} />
          <Badge>{link.mode === 'required' ? 'Required' : 'Alternate'}</Badge>
          <Badge>{RELATION_LABEL[link.relation]}</Badge>
        </div>
        <p className="dim panel-note">{STATUS_HELP[link.status]}</p>
        {link.notes ? <p className="panel-notes">{link.notes}</p> : <p className="dim panel-note">No notes or evidence recorded.</p>}

        <SelectField
          label="Status"
          value={link.status}
          onChange={(e) => {
            const status = e.target.value as LinkStatus;
            const { id: _id, ...rest } = link;
            updateScenario(s.id, (cur) => updateDependency(cur, link.id, { ...rest, status }));
            toast.success(`Status set to ${STATUS_LABEL[status].toLowerCase()}.`);
          }}
        >
          {LINK_STATUSES.map((st) => (
            <option key={st} value={st}>
              {STATUS_GLYPH[st]} {STATUS_LABEL[st]}
            </option>
          ))}
        </SelectField>

        <Assumptions s={s} type="link" id={link.id} onAdd={() => p.onAddAssumption('link', link.id)} />
        <div className="panel-actions">
          <Button variant="primary" onClick={() => p.onEditLink(link)}>
            Edit
          </Button>
          <Button variant="danger" onClick={() => p.onDeleteLink(link)}>
            Delete
          </Button>
        </div>
      </aside>
    );
  }

  const a = asset!;
  const providers = s.dependencies.filter((d) => d.dependentId === a.id);
  const dependents = s.dependencies.filter((d) => d.providerId === a.id);
  const ups = trace ? [...trace.upstream].sort((x, y) => x[1] - y[1] || name(x[0]).localeCompare(name(y[0]))) : [];
  const downs = trace ? [...trace.downstream].sort((x, y) => x[1] - y[1] || name(x[0]).localeCompare(name(y[0]))) : [];
  const pinned = typeof a.x === 'number' && typeof a.y === 'number';

  const linkRow = (d: Dependency, otherId: string) => (
    <li key={d.id}>
      <button className="link-btn" onClick={() => p.selectNode(otherId, true)}>
        {name(otherId)}
      </button>
      <span className="row-actions">
        <StatusBadge status={d.status} />
        <Button size="sm" variant="ghost" onClick={() => p.selectLink(d.id)} aria-label={`Inspect link with ${name(otherId)}`}>
          Inspect
        </Button>
      </span>
    </li>
  );

  const traceList = (title: string, color: string, items: [string, number][], empty: string) => (
    <div className="trace-col" data-dir={color}>
      <h4>
        {title} <span className="mono">({items.length})</span>
      </h4>
      {items.length === 0 ? (
        <p className="dim panel-note">{empty}</p>
      ) : (
        <ul className="trace-list">
          {items.map(([id, hops]) => (
            <li key={id}>
              <button className="link-btn" onClick={() => p.selectNode(id, true)}>
                {name(id)}
              </button>
              <span className="mono hops">{hops}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <aside className="card panel" aria-label="Asset details">
      <p className="eyebrow">Asset</p>
      <h2 className="card-title">{a.name}</h2>
      <div className="editor-meta">
        <Badge>{KIND_LABEL[a.kind]}</Badge>
        <CritBadge level={a.criticality} />
        {pinned && <Badge>Position pinned</Badge>}
      </div>
      {a.notes && <p className="panel-notes">{a.notes}</p>}
      <div className="panel-actions panel-actions-top">
        <Button size="sm" onClick={() => p.onEditAsset(a)}>
          Edit
        </Button>
        <Button size="sm" variant="danger" onClick={() => p.onDeleteAsset(a)}>
          Delete
        </Button>
        {pinned && (
          <Button size="sm" variant="ghost" onClick={() => updateScenario(s.id, (cur) => ({ ...cur, assets: cur.assets.map((x) => (x.id === a.id ? { ...x, x: null, y: null } : x)) }))}>
            Unpin
          </Button>
        )}
      </div>

      <Section title="Trace">
        <div className="seg" role="radiogroup" aria-label="Trace direction">
          {(['off', 'up', 'down', 'both'] as TraceMode[]).map((m) => (
            <button key={m} role="radio" aria-checked={p.traceMode === m} className="seg-btn" onClick={() => p.setTraceMode(m)}>
              {TRACE_LABEL[m]}
            </button>
          ))}
        </div>
        {p.traceMode === 'off' ? (
          <p className="dim panel-note">Choose a direction to follow dependencies through the whole system.</p>
        ) : (
          <>
            <p className="dim panel-note">
              Follows the links currently shown. Numbers are the steps from {a.name}.
            </p>
            <div className="trace-grid">
              {p.traceMode !== 'down' && traceList('Upstream', 'up', ups, 'Relies on nothing mapped.')}
              {p.traceMode !== 'up' && traceList('Downstream', 'down', downs, 'Nothing relies on it.')}
            </div>
          </>
        )}
      </Section>

      <Section title={`Relies on directly (${providers.length})`}>
        {providers.length ? <ul className="link-rows">{providers.map((d) => linkRow(d, d.providerId))}</ul> : <p className="dim panel-note">Nothing mapped. This is a foundation asset.</p>}
        <Button size="sm" onClick={() => p.onAddDependency({ dependentId: a.id })} disabled={s.assets.length < 2}>
          Add what it relies on
        </Button>
      </Section>
      <Section title={`Relied on by directly (${dependents.length})`}>
        {dependents.length ? <ul className="link-rows">{dependents.map((d) => linkRow(d, d.dependentId))}</ul> : <p className="dim panel-note">Nothing depends on it directly.</p>}
        <Button size="sm" onClick={() => p.onAddDependency({ providerId: a.id })} disabled={s.assets.length < 2}>
          Add what relies on it
        </Button>
      </Section>

      <Assumptions s={s} type="node" id={a.id} onAdd={() => p.onAddAssumption('node', a.id)} />

      <div className="panel-actions">
        <ButtonLink size="sm" variant="primary" to={`/app/simulation?fail=${encodeURIComponent(a.id)}`}>
          Simulate failure
        </ButtonLink>
        <ButtonLink size="sm" to={`/app/investigation?asset=${encodeURIComponent(a.id)}`}>
          Investigate
        </ButtonLink>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------- page */

type DepDialog = { editing?: Dependency; preset?: { dependentId?: string; providerId?: string } } | null;

function Inner({ s }: { s: Scenario }) {
  const [params] = useSearchParams();
  const { updateScenario } = useScenarios();
  const { reducedMotion } = useSettings();
  const toast = useToast();
  const graph = useRef<GraphHandle>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [traceMode, setTraceMode] = useState<TraceMode>('both');
  const [statuses, setStatuses] = useState<Set<LinkStatus>>(new Set(LINK_STATUSES));
  const [kind, setKind] = useState<AssetKind | 'all'>('all');
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState('');
  const [connectMode, setConnectMode] = useState(false);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);

  const [assetDialog, setAssetDialog] = useState<{ editing?: Asset } | null>(null);
  const [depDialog, setDepDialog] = useState<DepDialog>(null);
  const [assumeDialog, setAssumeDialog] = useState<{ type: 'node' | 'link'; id: string } | null>(null);
  const [delAsset, setDelAsset] = useState<Asset | null>(null);
  const [delLink, setDelLink] = useState<Dependency | null>(null);

  const byId = useMemo(() => new Map(s.assets.map((a) => [a.id, a])), [s.assets]);
  const asset = selectedId ? byId.get(selectedId) : undefined;
  const link = selectedLinkId ? s.dependencies.find((d) => d.id === selectedLinkId) : undefined;
  const nameOf = (id: string) => byId.get(id)?.name ?? 'Unknown';

  const shown = useMemo(() => s.dependencies.filter((d) => statuses.has(d.status)), [s.dependencies, statuses]);
  const hiddenIds = useMemo(() => new Set(findSharedDependencies(s.assets, s.dependencies).filter((x) => x.isHiddenShared).map((x) => x.asset.id)), [s.assets, s.dependencies]);
  const trace = useMemo(() => (asset && traceMode !== 'off' ? traceAsset(s.assets, shown, asset.id, traceMode) : null), [asset, traceMode, s.assets, shown]);

  const counts = useMemo(() => Object.fromEntries(LINK_STATUSES.map((st) => [st, s.dependencies.filter((d) => d.status === st).length])) as Record<LinkStatus, number>, [s.dependencies]);

  /* selection */
  const selectNode = (id: string, center = false) => {
    setSelectedId(id);
    setSelectedLinkId(null);
    // Deferred so an asset that was only just added is in the layout before we centre on it.
    if (center) window.setTimeout(() => graph.current?.centerOn(id), 40);
  };
  const selectLink = (id: string) => {
    setSelectedLinkId(id);
    setSelectedId(null);
  };
  const clearSelection = () => {
    setSelectedId(null);
    setSelectedLinkId(null);
  };

  // Deep link from other pages: /app/graph?focus=<asset id>
  useEffect(() => {
    const f = params.get('focus');
    if (f && byId.has(f)) {
      setSelectedId(f);
      window.setTimeout(() => graph.current?.centerOn(f), 60);
    }
    // Read once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On narrow screens the panel sits below the graph; bring it into view when something is selected.
  useEffect(() => {
    if ((!selectedId && !selectedLinkId) || !window.matchMedia('(max-width: 1100px)').matches) return;
    panelRef.current?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [selectedId, selectedLinkId, reducedMotion]);

  // Esc leaves connect mode, then clears the selection. Dialogs handle their own Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      if (connectMode) {
        setConnectMode(false);
        setConnectFrom(null);
      } else clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [connectMode]);

  /* connect mode */
  const onNodeClick = (id: string) => {
    if (!connectMode) return selectNode(id);
    if (!connectFrom) return setConnectFrom(id);
    if (connectFrom === id) return setConnectFrom(null);
    const existing = s.dependencies.find((d) => d.providerId === connectFrom && d.dependentId === id);
    setConnectFrom(null);
    if (existing) {
      toast.info(`${nameOf(id)} already relies on ${nameOf(connectFrom)}. Showing that link.`);
      return selectLink(existing.id);
    }
    setDepDialog({ preset: { providerId: connectFrom, dependentId: id } });
  };

  const toggleConnect = () => {
    setConnectMode((m) => !m);
    setConnectFrom(null);
  };

  const toggleStatus = (st: LinkStatus) =>
    setStatuses((cur) => {
      const next = new Set(cur);
      if (next.has(st)) next.delete(st);
      else next.add(st);
      return next;
    });

  const matches = query.trim() ? s.assets.filter((a) => a.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 6) : [];
  const anyPinned = s.assets.some((a) => typeof a.x === 'number');

  const confirmDeleteAsset = () => {
    if (!delAsset) return;
    updateScenario(s.id, (cur) => removeAsset(cur, delAsset.id));
    toast.success(`Deleted “${delAsset.name}”.`);
    if (selectedId === delAsset.id) clearSelection();
    setDelAsset(null);
  };
  const confirmDeleteLink = () => {
    if (!delLink) return;
    updateScenario(s.id, (cur) => removeDependency(cur, delLink.id));
    toast.success('Dependency removed.');
    if (selectedLinkId === delLink.id) clearSelection();
    setDelLink(null);
  };

  const impact = delAsset ? removalImpact(s, delAsset.id) : null;

  return (
    <>
      <PageHeader
        title="Dependency graph"
        description="Every asset in the scenario and what it relies on. Select an asset to trace its dependencies, or edit the graph directly."
        actions={
          <>
            <Button variant="primary" onClick={() => setAssetDialog({})}>
              Add asset
            </Button>
            <Button onClick={() => setDepDialog({})} disabled={s.assets.length < 2}>
              Add dependency
            </Button>
          </>
        }
      />

      {s.isSample && <Alert>This is a <strong>simulated sample</strong>. The data is invented. You can edit it freely, or duplicate it from the workspace first.</Alert>}

      {s.assets.length === 0 ? (
        <EmptyState title="Nothing to draw yet" actions={<Button variant="primary" onClick={() => setAssetDialog({})}>Add the first asset</Button>}>
          The graph is drawn from the assets and dependencies in “{s.name}”. Add an asset to begin, then link assets together.
        </EmptyState>
      ) : (
        <>
          <div className="toolbar graph-filters">
            <fieldset className="status-filter">
              <legend className="field-label">Show relationships</legend>
              <div className="status-filter-row">
                {LINK_STATUSES.map((st) => (
                  <Checkbox key={st} checked={statuses.has(st)} onChange={() => toggleStatus(st)} label={<>{STATUS_GLYPH[st]} {STATUS_LABEL[st]} <span className="dim">({counts[st]})</span></>} />
                ))}
              </div>
            </fieldset>
            <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as AssetKind | 'all')}>
              <option value="all">All kinds</option>
              {ASSET_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </SelectField>
            <div className="find">
              <TextField label="Find asset" type="search" value={query} placeholder="Type a name" onChange={(e) => setQuery(e.target.value)} />
              {matches.length > 0 && (
                <ul className="find-results" aria-label="Matching assets">
                  {matches.map((a) => (
                    <li key={a.id}>
                      <button
                        onClick={() => {
                          selectNode(a.id, true);
                          setQuery('');
                        }}
                      >
                        {a.name} <span className="dim">{KIND_LABEL[a.kind]}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {query.trim() && matches.length === 0 && <p className="field-hint">No asset matches “{query}”.</p>}
            </div>
            <Checkbox checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} label={<>Highlight hidden shared dependencies <span className="dim">({hiddenIds.size})</span></>} />
          </div>

          {connectMode && (
            <Alert tone="warn">
              <strong>Connect mode.</strong>{' '}
              {connectFrom ? (
                <>
                  Relied-on asset: <strong>{nameOf(connectFrom)}</strong>. Now click the asset that relies on it.
                </>
              ) : (
                <>Click the asset that is <em>relied on</em> (the provider), then the asset that <em>relies on it</em>.</>
              )}{' '}
              <button className="link-btn" onClick={toggleConnect}>
                Exit connect mode (Esc)
              </button>
            </Alert>
          )}

          <div className="graph-layout">
            <GraphView
              ref={graph}
              assets={s.assets}
              dependencies={s.dependencies}
              label={`Dependency graph for ${s.name}`}
              height="clamp(320px, 46dvh, 560px)"
              selectedId={selectedId}
              selectedLinkId={selectedLinkId}
              onSelect={onNodeClick}
              onSelectLink={selectLink}
              onBackgroundClick={clearSelection}
              onDeleteRequest={() => (link ? setDelLink(link) : asset ? setDelAsset(asset) : undefined)}
              onMoveNode={connectMode ? undefined : (id, x, y) => updateScenario(s.id, (cur) => setAssetPosition(cur, id, x, y))}
              pendingId={connectFrom}
              trace={trace}
              highlightIds={showHidden ? hiddenIds : undefined}
              highlightLabel="Hidden shared dependency"
              kindFilter={kind}
              visibleStatuses={statuses}
              linkMarkers
              wheelZoom
              toolbar={
                <>
                  <span className="graph-sep" aria-hidden="true" />
                  <Button size="sm" variant={connectMode ? 'primary' : 'ghost'} onClick={toggleConnect} aria-pressed={connectMode} disabled={s.assets.length < 2}>
                    Connect
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!anyPinned}
                    onClick={() => {
                      updateScenario(s.id, clearPositions);
                      toast.success('Layout reset to automatic.');
                      window.setTimeout(() => graph.current?.fit(), 50);
                    }}
                  >
                    Auto-arrange
                  </Button>
                </>
              }
            />
            <div ref={panelRef} className="panel-slot">
              <Panel
                s={s}
                asset={asset}
                link={link}
                trace={trace}
                traceMode={traceMode}
                setTraceMode={setTraceMode}
                selectNode={selectNode}
                selectLink={selectLink}
                onAddAsset={() => setAssetDialog({})}
                onAddDependency={(preset) => setDepDialog({ preset })}
                onEditAsset={(a) => setAssetDialog({ editing: a })}
                onDeleteAsset={setDelAsset}
                onEditLink={(d) => setDepDialog({ editing: d })}
                onDeleteLink={setDelLink}
                onAddAssumption={(type, id) => setAssumeDialog({ type, id })}
              />
            </div>
          </div>
          <p className="graph-foot">
            Failure analysis treats confirmed, inferred and unknown links as live. Hiding a status only changes what is drawn and traced here.{' '}
            <Link to="/app/scenarios">Manage everything in the workspace</Link>.
          </p>
        </>
      )}

      <AssetDialog open={!!assetDialog} onClose={() => setAssetDialog(null)} scenario={s} editing={assetDialog?.editing} onSaved={(a) => selectNode(a.id, true)} />
      <DependencyDialog open={!!depDialog} onClose={() => setDepDialog(null)} scenario={s} editing={depDialog?.editing} preset={depDialog?.preset} onSaved={(d) => selectLink(d.id)} />
      <AssumptionDialog open={!!assumeDialog} onClose={() => setAssumeDialog(null)} scenario={s} preset={assumeDialog ? { targetType: assumeDialog.type, targetId: assumeDialog.id } : undefined} />
      <ConfirmDialog open={!!delAsset} danger title={`Delete “${delAsset?.name ?? ''}”?`} confirmLabel="Delete asset" onCancel={() => setDelAsset(null)} onConfirm={confirmDeleteAsset}>
        {impact && (
          <p>
            This also removes {impact.dependencies} dependenc{impact.dependencies === 1 ? 'y' : 'ies'}
            {impact.strategies > 0 && `, ${impact.strategies} mitigation strateg${impact.strategies === 1 ? 'y' : 'ies'}`}
            {impact.assumptions > 0 && `, ${impact.assumptions} assumption${impact.assumptions === 1 ? '' : 's'}`}
            {impact.runs > 0 && `, and the asset from ${impact.runs} saved run${impact.runs === 1 ? '' : 's'}`}. This cannot be undone.
          </p>
        )}
      </ConfirmDialog>
      <ConfirmDialog open={!!delLink} danger title="Remove this dependency?" confirmLabel="Remove dependency" onCancel={() => setDelLink(null)} onConfirm={confirmDeleteLink}>
        {delLink && (
          <p>
            {nameOf(delLink.dependentId)} will no longer rely on {nameOf(delLink.providerId)}. Assumptions about this link and mitigations built on it are removed too.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

export default function GraphPage() {
  return (
    <ScenarioGate title="Dependency graph" description="Every asset in the scenario and what it relies on.">
      {(s) => <Inner key={s.id} s={s} />}
    </ScenarioGate>
  );
}

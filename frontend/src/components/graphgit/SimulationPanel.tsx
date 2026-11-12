import { useEffect, useMemo, useState } from 'react';
import { describeStep, explainCascade } from '../../lib/analysis';
import { outcomeFor, type Simulation } from '../../lib/graph';
import { commitLabel, hydrateSimulation, type BranchSimulation, type BranchSimulationDetail, type GraphDoc } from '../../lib/graphGit';
import { StatusBadge } from '../editors';
import { GraphView } from '../GraphView';
import { Alert, Badge, Button, CritBadge, EmptyState, StatTile, TextField } from '../ui';
import { errorText } from './dialogs';

interface Seed {
  nodes: string[];
  links: string[];
}
const PLAY_MS = 1400;

export interface SimulationPanelProps {
  graph: GraphDoc;
  /** What the graph on screen is, in words. */
  graphLabel: string;
  /** The commit a saved simulation would be recorded against, or null when the graph has uncommitted changes. */
  saveTarget: { commitId: string; seq: number } | null;
  onRequestCommit: () => void;
  sims: BranchSimulation[];
  stored: BranchSimulationDetail | null;
  busy: boolean;
  onSave: (body: { failedIds: string[]; failedLinkIds: string[]; commitId: string; name?: string }) => Promise<BranchSimulationDetail>;
  onOpenSaved: (s: BranchSimulation) => void;
  onClearStored: () => void;
  onSaved: (message: string) => void;
}

export function SimulationPanel(p: SimulationPanelProps) {
  const { graph, stored } = p;
  const byId = useMemo(() => new Map(graph.assets.map((a) => [a.id, a])), [graph.assets]);
  const nameOf = (id: string) => byId.get(id)?.name ?? 'Unknown';
  const linkLabel = (id: string) => {
    const d = graph.dependencies.find((x) => x.id === id);
    return d ? `${nameOf(d.dependentId)} → ${nameOf(d.providerId)}` : 'Unknown dependency';
  };

  const [tab, setTab] = useState<'assets' | 'links'>('assets');
  const [selected, setSelected] = useState<Seed>({ nodes: [], links: [] });
  const [ran, setRan] = useState<Seed | null>(null);
  const [round, setRound] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [selectError, setSelectError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Opening a saved simulation loads its failure and shows its stored result.
  useEffect(() => {
    if (!stored) return;
    const seed = { nodes: stored.failedIds, links: stored.failedLinkIds };
    setSelected(seed);
    setRan(seed);
    setRound(0);
    setPlaying(false);
    setName('');
  }, [stored]);

  // Seeds that no longer exist in the graph on screen (after switching branch or version) are dropped.
  const validRan = useMemo<Seed | null>(() => {
    if (!ran) return null;
    const v = { nodes: ran.nodes.filter((id) => byId.has(id)), links: ran.links.filter((id) => graph.dependencies.some((d) => d.id === id)) };
    return v.nodes.length + v.links.length ? v : null;
  }, [ran, byId, graph.dependencies]);

  // Always computed from the graph on screen, so a result can never describe a different graph.
  const out = useMemo<{ sim: Simulation; totals: { failed: number; cascaded: number; critical: number; rounds: number } } | null>(() => {
    if (!validRan) return null;
    if (stored) return { sim: hydrateSimulation(stored.result, stored.graph), totals: stored.result.totals };
    const o = outcomeFor(graph.assets, graph.dependencies, validRan);
    return { sim: o.sim, totals: { failed: o.total, cascaded: o.cascaded, critical: o.critical, rounds: o.sim.rounds.length - 1 } };
  }, [validRan, stored, graph]);
  const steps = useMemo(() => (out ? explainCascade(out.sim) : []), [out]);
  const maxRound = out ? Math.max(0, out.sim.rounds.length - 1) : 0;
  const shown = Math.min(round, maxRound);

  useEffect(() => {
    if (!playing) return;
    if (shown >= maxRound) return setPlaying(false);
    const t = window.setTimeout(() => setRound(shown + 1), PLAY_MS);
    return () => window.clearTimeout(t);
  }, [playing, shown, maxRound]);

  const q = query.trim().toLowerCase();
  const matches = graph.assets.filter((a) => a.name.toLowerCase().includes(q));
  const linkMatches = graph.dependencies.filter((d) => linkLabel(d.id).toLowerCase().includes(q));
  const toggle = (kind: 'nodes' | 'links', id: string) => {
    setSelectError(false);
    setSelected((cur) => ({ ...cur, [kind]: cur[kind].includes(id) ? cur[kind].filter((x) => x !== id) : [...cur[kind], id] }));
  };

  const run = () => {
    if (!selected.nodes.length && !selected.links.length) return setSelectError(true);
    p.onClearStored();
    setRan({ nodes: [...selected.nodes], links: [...selected.links] });
    setRound(0);
    setPlaying(false);
    setSaveError(null);
  };
  const stale = !!validRan && !stored && (validRan.nodes.slice().sort().join() !== selected.nodes.slice().sort().join() || validRan.links.slice().sort().join() !== selected.links.slice().sort().join());

  const save = async () => {
    if (!validRan || !p.saveTarget) return;
    setSaving(true);
    setSaveError(null);
    try {
      const sim = await p.onSave({ failedIds: validRan.nodes, failedLinkIds: validRan.links, commitId: p.saveTarget.commitId, name: name.trim() || undefined });
      p.onSaved(`Saved “${sim.name}” against commit ${commitLabel({ seq: sim.commit.seq })}.`);
      setName('');
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  if (graph.assets.length === 0) return <EmptyState title="No assets to simulate">This version of the graph is empty. Add assets and dependencies on the Graph tab first.</EmptyState>;

  const failedAtRound = new Set(out ? [...out.sim.failed].filter((id) => (out.sim.roundOf.get(id) ?? 0) <= shown) : []);
  const deadLinks = new Set(out ? [...out.sim.linkDownRound].filter(([, r]) => r <= shown).map(([id]) => id) : []);
  const byRound = (r: number) => steps.filter((st) => st.round === r);

  return (
    <div className="gg-sim">
      <div className="sim-layout">
        <section className="card" aria-labelledby="gg-pick-title">
          <h2 id="gg-pick-title" className="card-title">1. Choose what fails</h2>
          <p className="dim panel-note">Runs on: <strong>{p.graphLabel}</strong></p>
          <div className="seg" role="radiogroup" aria-label="Kind of failure">
            <button role="radio" aria-checked={tab === 'assets'} className="seg-btn" onClick={() => setTab('assets')}>Assets ({selected.nodes.length})</button>
            <button role="radio" aria-checked={tab === 'links'} className="seg-btn" onClick={() => setTab('links')}>Dependency links ({selected.links.length})</button>
          </div>
          <TextField label={tab === 'assets' ? 'Search assets' : 'Search dependency links'} type="search" value={query} placeholder="Filter by name" onChange={(e) => setQuery(e.target.value)} />
          {tab === 'assets' ? (
            <ul className="pick-list" aria-label="Assets">
              {matches.length === 0 && <li className="dim pick-empty">No assets match “{query}”.</li>}
              {matches.map((a) => (
                <li key={a.id}>
                  <label className="check pick-item">
                    <input type="checkbox" checked={selected.nodes.includes(a.id)} onChange={() => toggle('nodes', a.id)} />
                    <span className="pick-name">{a.name}</span>
                    <CritBadge level={a.criticality} />
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="pick-list" aria-label="Dependency links">
              {linkMatches.length === 0 && <li className="dim pick-empty">{graph.dependencies.length ? `No links match “${query}”.` : 'No dependencies are mapped.'}</li>}
              {linkMatches.map((d) => (
                <li key={d.id}>
                  <label className="check pick-item">
                    <input type="checkbox" checked={selected.links.includes(d.id)} onChange={() => toggle('links', d.id)} />
                    <span className="pick-name">{linkLabel(d.id)}{d.mode === 'alternate' ? ' (alt)' : ''}</span>
                    <StatusBadge status={d.status} />
                  </label>
                </li>
              ))}
            </ul>
          )}
          {selectError && <p className="field-error">Select at least one asset or dependency link to fail.</p>}
          <div className="row-actions pick-actions">
            <Button variant="primary" onClick={run}>Run simulation</Button>
            <Button variant="ghost" disabled={!selected.nodes.length && !selected.links.length && !ran} onClick={() => { setSelected({ nodes: [], links: [] }); setRan(null); setPlaying(false); p.onClearStored(); }}>Clear</Button>
          </div>
        </section>

        <section className="sim-results" aria-labelledby="gg-res-title">
          <h2 id="gg-res-title" className="card-title">2. Watch the cascade</h2>
          {!out || !validRan ? (
            <EmptyState title="No simulation yet">Pick assets or links to fail and run the simulation on this branch.</EmptyState>
          ) : (
            <>
              {stored ? (
                <Alert tone="info">
                  Stored result from <strong>{stored.name}</strong>, recorded against commit <span className="mono">{commitLabel({ seq: stored.commit.seq })}</span> “{stored.commit.message}” on {new Date(stored.createdAt).toLocaleString()}. It describes that commit’s graph, shown here.{' '}
                  {stored.reproducible ? <Badge tone="signal">✓ Recomputes identically</Badge> : <Badge tone="danger">Does not recompute identically</Badge>}
                </Alert>
              ) : (
                <p className="dim panel-note">Live result on <strong>{p.graphLabel}</strong>.</p>
              )}
              {stale && <Alert tone="warn">The selection changed since this run. <button className="link-btn" onClick={run}>Run again</button></Alert>}
              <div className="stat-grid">
                <StatTile label="Failed at the start" value={validRan.nodes.length + validRan.links.length} hint={validRan.links.length ? `${validRan.nodes.length} assets, ${validRan.links.length} links` : undefined} />
                <StatTile label="Failed by cascade" value={out.totals.cascaded} tone={out.totals.cascaded ? 'danger' : undefined} />
                <StatTile label="Critical assets down" value={out.totals.critical} tone={out.totals.critical ? 'danger' : undefined} />
                <StatTile label="Rounds to settle" value={maxRound} />
              </div>
              <div className="stepper" role="group" aria-label="Cascade playback">
                {playing ? <Button size="sm" variant="primary" onClick={() => setPlaying(false)}>Pause</Button> : <Button size="sm" variant="primary" disabled={maxRound === 0} onClick={() => { if (shown >= maxRound) setRound(0); setPlaying(true); }}>Play</Button>}
                <Button size="sm" onClick={() => { setPlaying(false); setRound(0); }} disabled={shown === 0 && !playing}>Reset</Button>
                <Button size="sm" onClick={() => { setPlaying(false); setRound(Math.max(0, shown - 1)); }} disabled={shown === 0}>Previous</Button>
                <label className="stepper-range">
                  <span className="sr-only">Round</span>
                  <input type="range" min={0} max={maxRound} value={shown} onChange={(e) => { setPlaying(false); setRound(Number(e.target.value)); }} aria-valuetext={`Round ${shown} of ${maxRound}`} />
                </label>
                <Button size="sm" onClick={() => { setPlaying(false); setRound(Math.min(maxRound, shown + 1)); }} disabled={shown >= maxRound}>Next</Button>
                <span className="mono stepper-label" aria-live="polite">Round {shown} / {maxRound}</span>
              </div>
              <GraphView
                assets={graph.assets}
                dependencies={graph.dependencies}
                label={`Cascade at round ${shown}`}
                failedIds={failedAtRound}
                roundOf={out.sim.roundOf}
                failedLinkIds={new Set(out.sim.seedLinks)}
                deadLinkIds={deadLinks}
                linkMarkers
                height={380}
              />
              <h3 className="panel-h">Why each asset fails</h3>
              <ol className="rounds explain" aria-label="Step-by-step failure propagation">
                {out.sim.rounds.map((ids, r) => {
                  const future = r > shown;
                  return (
                    <li key={r} data-active={r === shown ? 'true' : undefined} data-future={future ? 'true' : undefined}>
                      <button className="round-btn" onClick={() => { setPlaying(false); setRound(r); }} aria-current={r === shown ? 'step' : undefined}>
                        <span className="mono round-n">{r === 0 ? 'START' : `R${r}`}</span>
                        <span className="explain-body">
                          {future ? (
                            <span className="dim">{ids.length} more asset{ids.length === 1 ? '' : 's'} fail in this round (not reached yet)</span>
                          ) : (
                            <>
                              {r === 0 && validRan.links.length > 0 && <span className="explain-item"><strong>Links failed directly:</strong> {validRan.links.map(linkLabel).join('; ')}.</span>}
                              {byRound(r).map((st) => (
                                <span key={st.assetId} className="explain-item">
                                  <strong>{nameOf(st.assetId)}</strong> <CritBadge level={byId.get(st.assetId)?.criticality ?? 'low'} />{' '}
                                  {st.kind !== 'seed' && <StatusBadge status={st.evidence} />}
                                  <span className="explain-why">{describeStep(st, nameOf)}</span>
                                </span>
                              ))}
                              {r === 0 && ids.length === 0 && <span className="dim">No asset is down yet; only the links above.</span>}
                            </>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>

              {!stored && (
                <div className="save-run card">
                  {p.saveTarget ? (
                    <>
                      <TextField label={`Save against commit ${commitLabel({ seq: p.saveTarget.seq })}`} value={name} maxLength={80} hint="The server recomputes the result from that commit’s snapshot and stores it with the commit, branch and failure." onChange={(e) => setName(e.target.value)} />
                      <Button variant="primary" onClick={() => void save()} loading={saving} disabled={stale || p.busy}>Save simulation</Button>
                    </>
                  ) : (
                    <div>
                      <p>This graph has uncommitted changes, so the result cannot be tied to an exact commit.</p>
                      <Button variant="primary" size="sm" onClick={p.onRequestCommit}>Commit changes to save</Button>
                    </div>
                  )}
                  {saveError && <Alert tone="error">{saveError}</Alert>}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <section aria-labelledby="gg-saved-title" className="saved">
        <h2 id="gg-saved-title" className="section-title">Saved simulations on this branch</h2>
        {p.sims.length === 0 ? (
          <EmptyState title="No saved simulations">Run a simulation and save it. It stays attached to the commit it ran on.</EmptyState>
        ) : (
          <ul className="saved-list">
            {p.sims.map((s) => (
              <li key={s.id} className="saved-item">
                <div>
                  <div className="cell-name">{s.name}</div>
                  <div className="cell-note">
                    Commit <span className="mono">{commitLabel(s.commit)}</span> “{s.commit.message}” · {s.totals.failed} failed ({s.totals.cascaded} by cascade, {s.totals.critical} critical) · {s.totals.rounds} round{s.totals.rounds === 1 ? '' : 's'} · {new Date(s.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="row-actions">
                  {s.isCurrent ? <Badge tone="signal">Current head</Badge> : <Badge tone="ghost">Older commit</Badge>}
                  <Button size="sm" onClick={() => p.onOpenSaved(s)} disabled={p.busy}>Open stored result</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

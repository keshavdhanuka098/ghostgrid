import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { StatusBadge } from '../components/editors';
import { GraphView } from '../components/GraphView';
import { ScenarioGate } from '../components/ScenarioGate';
import { WhatIfPanel } from '../components/WhatIfPanel';
import { Alert, Badge, Button, ButtonLink, ConfirmDialog, CritBadge, EmptyState, PageHeader, StatTile, TextField } from '../components/ui';
import { describeStep, explainCascade } from '../lib/analysis';
import { outcomeFor } from '../lib/graph';
import { uid } from '../lib/id';
import { isHypothetical } from '../lib/whatif';
import type { SavedRun, Scenario } from '../lib/types';
import { useScenarios } from '../state/ScenarioContext';
import { useToast } from '../state/ToastContext';
import { AiInsight } from '../components/integrations/AiInsight';
import { useWhatIf } from '../state/WhatIfContext';

interface Seed {
  nodes: string[];
  links: string[];
}
const keyOf = (s: Seed) => `${[...s.nodes].sort().join('|')}#${[...s.links].sort().join('|')}`;
const PLAY_MS = 1400;

function Inner({ s }: { s: Scenario }) {
  const { updateScenario } = useScenarios();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const wi = useWhatIf(s);
  const { assets, deps } = wi;
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const nameOf = (id: string) => byId.get(id)?.name ?? 'Unknown';
  const linkLabel = (id: string) => {
    const d = deps.find((x) => x.id === id);
    return d ? `${nameOf(d.dependentId)} → ${nameOf(d.providerId)}` : 'Unknown dependency';
  };

  const initial = useMemo<Seed>(
    () => ({
      nodes: (params.get('fail') ?? '').split(',').filter((id) => assets.some((a) => a.id === id)),
      links: (params.get('failLink') ?? '').split(',').filter((id) => deps.some((d) => d.id === id)),
    }),
    // Read once on mount: the URL only pre-fills the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const hasInitial = initial.nodes.length + initial.links.length > 0;
  const [tab, setTab] = useState<'assets' | 'links'>(initial.links.length && !initial.nodes.length ? 'links' : 'assets');
  const [selected, setSelected] = useState<Seed>(initial);
  const [ran, setRan] = useState<Seed | null>(hasInitial ? initial : null);
  const [round, setRound] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [query, setQuery] = useState('');
  const [runName, setRunName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [deleting, setDeleting] = useState<SavedRun | null>(null);
  const [selectError, setSelectError] = useState(false);

  // The outcome is derived, so it recalculates whenever the what-if changes.
  const out = useMemo(() => (ran ? outcomeFor(assets, deps, ran) : null), [ran, assets, deps]);
  const steps = useMemo(() => (out ? explainCascade(out.sim) : []), [out]);
  const maxRound = out ? out.sim.rounds.length - 1 : 0;
  const shown = Math.min(round, maxRound);
  const stale = !!ran && keyOf(ran) !== keyOf(selected);
  const q = query.trim().toLowerCase();
  const matches = assets.filter((a) => a.name.toLowerCase().includes(q));
  const linkMatches = deps.filter((d) => linkLabel(d.id).toLowerCase().includes(q));

  useEffect(() => {
    if (!playing) return;
    if (shown >= maxRound) return setPlaying(false);
    const t = window.setTimeout(() => setRound(shown + 1), PLAY_MS);
    return () => window.clearTimeout(t);
  }, [playing, shown, maxRound]);

  const toggle = (kind: 'nodes' | 'links', id: string) => {
    setSelectError(false);
    setSelected((cur) => ({ ...cur, [kind]: cur[kind].includes(id) ? cur[kind].filter((x) => x !== id) : [...cur[kind], id] }));
  };
  const suggest = (x: Seed) => (x.nodes.length === 1 && !x.links.length ? `${nameOf(x.nodes[0])} outage` : x.links.length === 1 && !x.nodes.length ? `${linkLabel(x.links[0])} link failure` : `${x.nodes.length + x.links.length} failures together`);

  const execute = (x: Seed) => {
    if (!x.nodes.length && !x.links.length) return setSelectError(true);
    setRan({ nodes: [...x.nodes], links: [...x.links] });
    setRound(0);
    setPlaying(false);
    setRunName((n) => (n.trim() ? n : suggest(x)));
    setNameError(undefined);
  };
  const play = () => {
    if (shown >= maxRound) setRound(0);
    setPlaying(true);
  };
  const reset = () => {
    setPlaying(false);
    setRound(0);
  };

  const hypotheticalSeed = !!ran && [...ran.nodes, ...ran.links].some(isHypothetical);
  const save = (ev: FormEvent) => {
    ev.preventDefault();
    if (!ran) return;
    const name = runName.trim();
    if (!name) return setNameError('Name this run so you can find it later.');
    if (name.length > 80) return setNameError('Keep the name under 80 characters.');
    if (s.runs.some((r) => r.name.toLowerCase() === name.toLowerCase())) return setNameError('A saved run already uses this name.');
    const saved: SavedRun = { id: uid('rn'), name, failedIds: ran.nodes, failedLinkIds: ran.links, createdAt: new Date().toISOString() };
    updateScenario(s.id, (cur) => ({ ...cur, runs: [...cur.runs, saved] }));
    toast.success(`Saved run “${name}”. It is now available for mitigation comparison.`);
    setRunName('');
  };

  const compareMitigations = () => {
    if (!ran) return;
    const match = s.runs.find((r) => keyOf({ nodes: r.failedIds, links: r.failedLinkIds }) === keyOf(ran));
    navigate(
      match
        ? `/app/mitigation?run=${encodeURIComponent(match.id)}`
        : `/app/mitigation?fail=${encodeURIComponent(ran.nodes.join(','))}&failLink=${encodeURIComponent(ran.links.join(','))}`,
    );
  };

  const focus = useMemo(() => ({ seed: ran ?? undefined }), [ran]);
  if (s.assets.length === 0)
    return (
      <>
        <PageHeader title="Simulation" />
        <EmptyState title="No assets to simulate" actions={<ButtonLink to="/app/scenarios" variant="primary">Add assets</ButtonLink>}>
          Add assets and dependencies in the workspace, then come back to fail them and watch the cascade.
        </EmptyState>
      </>
    );

  const failedAtRound = new Set(out ? [...out.sim.failed].filter((id) => (out.sim.roundOf.get(id) ?? 0) <= shown) : []);
  const deadLinks = new Set(out ? [...out.sim.linkDownRound].filter(([, r]) => r <= shown).map(([id]) => id) : []);
  const seedLinks = new Set(out?.sim.seedLinks ?? []);
  const byRound = (r: number) => steps.filter((st) => st.round === r);

  return (
    <>
      <PageHeader
        title="Simulation"
        description="Fail assets, or cut individual dependency links, then see what else goes down round by round and why. Required dependencies fail immediately; alternates fail only when every backup is gone."
      />
      <WhatIfPanel s={s} focus={focus} />
      {s.dependencies.length === 0 && <Alert tone="warn">No dependencies are mapped, so failures will not cascade. Map some in the workspace to see propagation.</Alert>}

      <div className="sim-layout">
        <section className="card" aria-labelledby="pick-title">
          <h2 id="pick-title" className="card-title">1. Choose what fails</h2>
          <div className="seg" role="radiogroup" aria-label="Kind of failure">
            <button role="radio" aria-checked={tab === 'assets'} className="seg-btn" onClick={() => setTab('assets')}>Assets ({selected.nodes.length})</button>
            <button role="radio" aria-checked={tab === 'links'} className="seg-btn" onClick={() => setTab('links')}>Dependency links ({selected.links.length})</button>
          </div>
          {tab === 'links' && <p className="dim panel-note">A failed link means the provider stops serving that one dependent. The provider itself stays up.</p>}
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
              {linkMatches.length === 0 && <li className="dim pick-empty">{deps.length ? `No links match “${query}”.` : 'No dependencies are mapped.'}</li>}
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
          {selected.nodes.length + selected.links.length > 0 && (
            <div className="chips" aria-label="Selected failures">
              {selected.nodes.map((id) => (
                <span key={id} className="chip">{nameOf(id)}<button onClick={() => toggle('nodes', id)} aria-label={`Remove ${nameOf(id)} from selection`}>✕</button></span>
              ))}
              {selected.links.map((id) => (
                <span key={id} className="chip">✕ {linkLabel(id)}<button onClick={() => toggle('links', id)} aria-label={`Remove link ${linkLabel(id)} from selection`}>✕</button></span>
              ))}
            </div>
          )}
          {selectError && <p className="field-error">Select at least one asset or dependency link to fail.</p>}
          <div className="row-actions pick-actions">
            <Button variant="primary" onClick={() => execute(selected)}>Run simulation</Button>
            <Button variant="ghost" onClick={() => { setSelected({ nodes: [], links: [] }); setRan(null); setSelectError(false); setPlaying(false); }} disabled={!selected.nodes.length && !selected.links.length && !ran}>Clear</Button>
          </div>
        </section>

        <section aria-labelledby="res-title" className="sim-results">
          <h2 id="res-title" className="card-title">2. Watch the cascade</h2>
          {!out || !ran ? (
            <EmptyState title="No simulation yet">Pick assets or dependency links to fail and run the simulation. Results appear here.</EmptyState>
          ) : (
            <>
              {stale && (
                <Alert tone="warn">The selection has changed since this run. <button className="link-btn" onClick={() => execute(selected)}>Run again</button></Alert>
              )}
              <div className="stat-grid">
                <StatTile label="Failed at the start" value={ran.nodes.length + ran.links.length} hint={ran.links.length ? `${ran.nodes.length} assets, ${ran.links.length} links` : undefined} />
                <StatTile label="Failed by cascade" value={out.cascaded} tone={out.cascaded ? 'danger' : undefined} />
                <StatTile label="Critical assets down" value={out.critical} tone={out.critical ? 'danger' : undefined} />
                <StatTile label="Rounds to settle" value={maxRound} />
              </div>

              <div className="stepper" role="group" aria-label="Cascade playback">
                {playing ? <Button size="sm" variant="primary" onClick={() => setPlaying(false)}>Pause</Button> : <Button size="sm" variant="primary" onClick={play} disabled={maxRound === 0}>Play</Button>}
                <Button size="sm" onClick={reset} disabled={shown === 0 && !playing}>Reset</Button>
                <Button size="sm" onClick={() => { setPlaying(false); setRound(Math.max(0, shown - 1)); }} disabled={shown === 0}>Previous</Button>
                <label className="stepper-range">
                  <span className="sr-only">Round</span>
                  <input type="range" min={0} max={maxRound} value={shown} onChange={(e) => { setPlaying(false); setRound(Number(e.target.value)); }} aria-valuetext={`Round ${shown} of ${maxRound}`} />
                </label>
                <Button size="sm" onClick={() => { setPlaying(false); setRound(Math.min(maxRound, shown + 1)); }} disabled={shown >= maxRound}>Next</Button>
                <span className="mono stepper-label" aria-live="polite">Round {shown} / {maxRound}</span>
              </div>

              <GraphView
                assets={assets}
                dependencies={deps}
                label={`Cascade at round ${shown}`}
                failedIds={failedAtRound}
                roundOf={out.sim.roundOf}
                failedLinkIds={seedLinks}
                deadLinkIds={deadLinks}
                whatIfLinkIds={wi.changedLinks}
                linkMarkers
                height={420}
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
                              {r === 0 && ran.links.length > 0 && (
                                <span className="explain-item">
                                  <strong>Links failed directly:</strong> {ran.links.map(linkLabel).join('; ')}. Each provider stops serving that dependent only.
                                </span>
                              )}
                              {r === 0 && ids.length === 0 && ran.links.length === 0 && <span className="dim">Nothing failed.</span>}
                              {byRound(r).map((st) => (
                                <span key={st.assetId} className="explain-item">
                                  <strong>{nameOf(st.assetId)}</strong> <CritBadge level={byId.get(st.assetId)?.criticality ?? 'low'} />{' '}
                                  {st.kind !== 'seed' && <StatusBadge status={st.evidence} />}
                                  <span className="explain-why">{describeStep(st, nameOf)}</span>
                                  {st.kind !== 'seed' && st.evidence !== 'confirmed' && (
                                    <span className="explain-why dim">This failure rests on {st.evidence} link{st.reasons.filter((x) => x.dep.status !== 'confirmed').length === 1 ? '' : 's'}. Verify before relying on it.</span>
                                  )}
                                </span>
                              ))}
                              {r === 0 && ids.length === 0 && ran.links.length > 0 && <span className="dim">No asset is down yet; only the links above.</span>}
                            </>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>

              <div className="row-actions">
                <Button variant="primary" onClick={compareMitigations} disabled={stale}>Compare mitigations</Button>
                <span className="dim panel-note">{stale ? 'Run the simulation again first.' : 'Opens the Mitigation page with this failure.'}</span>
              </div>

              <form className="save-run card" onSubmit={save} noValidate>
                <TextField label="Save this run" value={runName} maxLength={90} error={nameError} hint={hypotheticalSeed ? 'This failure uses hypothetical assets or links, so it cannot be saved. Discard or reset the what-if first.' : 'Saved runs can be compared against mitigations and included in reports.'} onChange={(e) => { setRunName(e.target.value); setNameError(undefined); }} />
                <Button type="submit" disabled={stale || hypotheticalSeed}>Save run</Button>
              </form>

              <section className="card stack" aria-labelledby="ai-sim">
                <h3 id="ai-sim" className="card-title">AI explanation</h3>
                <p className="dim">The server recomputes this cascade from the saved scenario and the AI explains that result. It is an interpretation, not a second simulation.</p>
                {(() => {
                  const off = stale || hypotheticalSeed || wi.applied;
                  const why = wi.applied || hypotheticalSeed ? 'Only the saved scenario can be explained. Discard or pause the what-if changes first.' : 'Run the simulation again first.';
                  const p = { scenarioId: s.id, failedAssetIds: ran.nodes, failedLinkIds: ran.links };
                  const key = keyOf(ran);
                  return (
                    <>
                      <AiInsight task="simulation_explanation" params={p} label="Explain this result" disabled={off} disabledReason={why} resetKey={key} />
                      <AiInsight task="simulation_explanation" params={{ ...p, mode: 'root_cause' }} label="Find the root cause" disabled={off} disabledReason={why} resetKey={`${key}-rc`} />
                    </>
                  );
                })()}
              </section>
            </>
          )}
        </section>
      </div>

      <section aria-labelledby="saved-title" className="saved">
        <h2 id="saved-title" className="section-title">Saved runs</h2>
        {s.runs.length === 0 ? (
          <EmptyState title="No saved runs">Run a simulation and save it to keep it for mitigation comparison and reports.</EmptyState>
        ) : (
          <ul className="saved-list">
            {s.runs.map((r) => (
              <li key={r.id} className="saved-item">
                <div>
                  <div className="cell-name">{r.name}</div>
                  <div className="cell-note">
                    {r.failedIds.length > 0 && <>Assets: {r.failedIds.map(nameOf).join(', ')}. </>}
                    {r.failedLinkIds.length > 0 && <>Links: {r.failedLinkIds.map(linkLabel).join('; ')}.</>}
                  </div>
                </div>
                <div className="row-actions">
                  <Badge>{new Date(r.createdAt).toLocaleDateString()}</Badge>
                  <Button size="sm" onClick={() => { const x = { nodes: r.failedIds, links: r.failedLinkIds }; setSelected(x); execute(x); setRunName(''); }}>Load</Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(r)} aria-label={`Delete run ${r.name}`}>Delete</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={!!deleting}
        danger
        title={`Delete “${deleting?.name ?? ''}”?`}
        confirmLabel="Delete run"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          updateScenario(s.id, (cur) => ({ ...cur, runs: cur.runs.filter((r) => r.id !== deleting.id) }));
          toast.success(`Deleted run “${deleting.name}”.`);
          setDeleting(null);
        }}
      >
        <p>The run will no longer be available for mitigation comparison or reports.</p>
      </ConfirmDialog>
    </>
  );
}

export default function Simulation() {
  return (
    <ScenarioGate title="Simulation" description="Fail assets or links and watch the cascade.">
      {(s) => <Inner key={s.id} s={s} />}
    </ScenarioGate>
  );
}

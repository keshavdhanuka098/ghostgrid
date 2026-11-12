import { useMemo, useState } from 'react';
import type { FailureSeed } from '../lib/graph';
import { simulateFailure } from '../lib/graph';
import { attribute, compareFindings, compareShared, compareSimulation, describeChanges } from '../lib/whatif';
import { FINDING_LABEL } from '../lib/analysis';
import { ASSET_KINDS, CRIT_LABEL, CRITICALITIES, KIND_LABEL, type AssetKind, type Criticality, type Scenario } from '../lib/types';
import { useWhatIf } from '../state/WhatIfContext';
import { Badge, Button, Checkbox, ConfirmDialog, SelectField, TextField } from './ui';

type Kind = 'asset-remove' | 'asset-criticality' | 'asset-add' | 'link-remove' | 'link-mode' | 'link-add';
const KIND_TEXT: Record<Kind, string> = {
  'asset-remove': 'Remove an asset',
  'asset-criticality': 'Change an asset’s criticality',
  'asset-add': 'Add a new asset',
  'link-remove': 'Remove a dependency',
  'link-mode': 'Switch a dependency between required and alternate',
  'link-add': 'Add a new dependency',
};

export interface WhatIfFocus {
  /** Asset being investigated; enables the findings comparison. */
  targetId?: string | null;
  /** Failure being simulated; enables the simulation comparison. */
  seed?: FailureSeed;
}

/** Shared what-if panel. Edits only the browser-side what-if state; the saved scenario is never changed from here. */
export function WhatIfPanel({ s, focus }: { s: Scenario; focus?: WhatIfFocus }) {
  const wi = useWhatIf(s);
  const [open, setOpen] = useState(wi.count > 0);
  const [kind, setKind] = useState<Kind>('link-remove');
  const [assetId, setAssetId] = useState('');
  const [linkId, setLinkId] = useState('');
  const [crit, setCrit] = useState<Criticality>('high');
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<AssetKind>('service');
  const [dependentId, setDependentId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [mode, setMode] = useState<'required' | 'alternate'>('alternate');
  const [error, setError] = useState<string | undefined>();
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const allAssets = useMemo(() => [...s.assets, ...wi.changes.addedAssets], [s.assets, wi.changes.addedAssets]);
  const name = (id: string) => allAssets.find((a) => a.id === id)?.name ?? 'Unknown';
  const items = useMemo(() => describeChanges(s, wi.changes), [s, wi.changes]);
  const byName = [...allAssets].sort((a, b) => a.name.localeCompare(b.name));
  const links = [...s.dependencies].sort((a, b) => `${name(a.dependentId)}${name(a.providerId)}`.localeCompare(`${name(b.dependentId)}${name(b.providerId)}`));

  const add = () => {
    setError(undefined);
    if (kind === 'asset-remove' || kind === 'asset-criticality') {
      const a = s.assets.find((x) => x.id === assetId);
      if (!a) return setError('Choose an asset.');
      if (kind === 'asset-criticality' && crit === a.criticality) return setError(`${a.name} is already ${CRIT_LABEL[crit]}. Choose a different level.`);
      wi.setAsset(a.id, kind === 'asset-remove' ? { exists: false } : { criticality: crit });
    } else if (kind === 'asset-add') {
      const n = newName.trim();
      if (!n) return setError('Name the new asset.');
      if (allAssets.some((a) => a.name.toLowerCase() === n.toLowerCase())) return setError('An asset with this name already exists.');
      wi.addAsset({ name: n, kind: newKind, criticality: crit, notes: 'Hypothetical (what-if).' });
      setNewName('');
    } else if (kind === 'link-remove' || kind === 'link-mode') {
      const d = s.dependencies.find((x) => x.id === linkId);
      if (!d) return setError('Choose a dependency.');
      wi.setLink(d.id, kind === 'link-remove' ? { exists: false } : { mode: d.mode === 'required' ? 'alternate' : 'required' });
    } else {
      if (!dependentId || !providerId) return setError('Choose both assets.');
      if (dependentId === providerId) return setError('An asset cannot depend on itself.');
      if (wi.deps.some((d) => d.dependentId === dependentId && d.providerId === providerId) || wi.changes.addedLinks.some((d) => d.dependentId === dependentId && d.providerId === providerId))
        return setError('This dependency already exists.');
      wi.addLink({ dependentId, providerId, mode, relation: 'other', notes: 'Hypothetical (what-if).' });
    }
  };

  const base = { assets: s.assets, dependencies: s.dependencies };
  const seedKey = focus?.seed ? `${(focus.seed.nodes ? [...focus.seed.nodes] : []).join()}|${(focus.seed.links ? [...focus.seed.links] : []).join()}` : '';
  const results = useMemo(() => {
    if (!wi.count) return null;
    const seed = focus?.seed ? { nodes: [...(focus.seed.nodes ?? [])], links: [...(focus.seed.links ?? [])] } : null;
    const hasSeed = !!seed && seed.nodes.length + seed.links.length > 0;
    const sim = hasSeed ? compareSimulation(base, wi.changes, seed) : null;
    const simAttr = sim ? attribute(base, wi.changes, items, (a, d) => new Set(simulateFailure(a, d, seed!).failed)) : null;
    const target = focus?.targetId && s.assets.some((a) => a.id === focus.targetId) ? focus.targetId : null;
    return { shared: compareShared(base, wi.changes), sim, simAttr, findings: target ? compareFindings(base, wi.changes, target) : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wi.count, wi.changes, s.assets, s.dependencies, focus?.targetId, seedKey, items]);

  const nm = (id: string) => name(id);
  const causes = (list?: string[]) => (list && list.length ? `Caused by: ${list.join('; ')}.` : 'Caused by these changes acting together.');

  return (
    <section className="card whatif" aria-labelledby="whatif-title" data-active={wi.applied ? 'true' : undefined}>
      <div className="card-head">
        <div>
          <h2 id="whatif-title" className="card-title">
            What-if <Badge tone={wi.applied ? 'ghost' : undefined}>{wi.applied ? `${wi.count} hypothetical change${wi.count === 1 ? '' : 's'} applied` : wi.count ? 'Paused: showing saved model' : 'Off'}</Badge>
          </h2>
          <p className="card-sub">Try changes to assets and dependencies without touching the saved scenario. Kept in this browser only.</p>
        </div>
        <Button size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide panel' : 'Open what-if panel'}
        </Button>
      </div>
      {wi.applied && (
        <p className="whatif-banner" role="status">
          Results on this page are <strong>hypothetical</strong>. Your saved scenario, reports and graph page are unchanged.
        </p>
      )}

      {open && (
        <div className="whatif-body">
          <div className="whatif-form">
            <SelectField label="Change" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setError(undefined); }}>
              {(Object.keys(KIND_TEXT) as Kind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_TEXT[k]}
                </option>
              ))}
            </SelectField>
            {(kind === 'asset-remove' || kind === 'asset-criticality') && (
              <SelectField label="Asset" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                <option value="">Choose asset</option>
                {[...s.assets].sort((a, b) => a.name.localeCompare(b.name)).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </SelectField>
            )}
            {kind === 'asset-add' && <TextField label="New asset name" value={newName} maxLength={60} onChange={(e) => setNewName(e.target.value)} />}
            {kind === 'asset-add' && (
              <SelectField label="Kind" value={newKind} onChange={(e) => setNewKind(e.target.value as AssetKind)}>
                {ASSET_KINDS.map((k) => (
                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                ))}
              </SelectField>
            )}
            {(kind === 'asset-criticality' || kind === 'asset-add') && (
              <SelectField label="Criticality" value={crit} onChange={(e) => setCrit(e.target.value as Criticality)}>
                {CRITICALITIES.map((c) => (
                  <option key={c} value={c}>{CRIT_LABEL[c]}</option>
                ))}
              </SelectField>
            )}
            {(kind === 'link-remove' || kind === 'link-mode') && (
              <SelectField label="Dependency" value={linkId} onChange={(e) => setLinkId(e.target.value)}>
                <option value="">Choose dependency</option>
                {links.map((d) => (
                  <option key={d.id} value={d.id}>
                    {nm(d.dependentId)} → {nm(d.providerId)} ({d.status}, {d.mode})
                  </option>
                ))}
              </SelectField>
            )}
            {kind === 'link-add' && (
              <>
                <SelectField label="Relies on it (dependent)" value={dependentId} onChange={(e) => setDependentId(e.target.value)}>
                  <option value="">Choose asset</option>
                  {byName.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </SelectField>
                <SelectField label="Relied on (provider)" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                  <option value="">Choose asset</option>
                  {byName.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </SelectField>
                <SelectField label="Type" value={mode} onChange={(e) => setMode(e.target.value as 'required' | 'alternate')}>
                  <option value="alternate">Alternate (backup)</option>
                  <option value="required">Required</option>
                </SelectField>
              </>
            )}
            <Button variant="primary" onClick={add}>Add change</Button>
          </div>
          {error && <p className="field-error">{error}</p>}

          <h3 className="panel-h">Hypothetical changes ({items.length})</h3>
          {items.length === 0 ? (
            <p className="dim panel-note">No changes yet. The model is exactly as saved.</p>
          ) : (
            <ul className="whatif-list">
              {items.map((it) => (
                <li key={it.key}>
                  <span>
                    {it.text} {it.contradictsConfirmed && <Badge tone="danger">contradicts a confirmed link</Badge>}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => wi.undo(it.key)} aria-label={`Undo: ${it.text}`}>Undo</Button>
                </li>
              ))}
            </ul>
          )}

          <div className="whatif-controls">
            <Checkbox checked={wi.on} disabled={!wi.count} onChange={(e) => wi.setOn(e.target.checked)} label="Apply hypothetical changes to results" />
            <Button size="sm" onClick={wi.reset} disabled={!wi.count}>Reset</Button>
            <Button size="sm" variant="danger" onClick={() => (wi.count ? setConfirmDiscard(true) : wi.discard())} disabled={!wi.count && !wi.on}>Discard</Button>
          </div>
          <p className="dim panel-note">Reset reverts every change to the saved model and stays in what-if mode. Discard ends the what-if. Neither alters your saved scenario.</p>

          {results && (
            <div className="whatif-results" aria-label="Original versus hypothetical results">
              <h3 className="panel-h">Original vs hypothetical</h3>
              <table className="table">
                <thead>
                  <tr><th scope="col">Result</th><th scope="col" className="num">Original</th><th scope="col" className="num">Hypothetical</th></tr>
                </thead>
                <tbody>
                  <tr><td>Hidden shared dependencies</td><td className="num">{results.shared.before.length}</td><td className="num">{results.shared.after.length}</td></tr>
                  {results.findings && (
                    <tr><td>Findings for {nm(focus!.targetId!)}</td><td className="num">{results.findings.before?.findings.length ?? 0}</td><td className="num">{results.findings.after?.findings.length ?? 0}</td></tr>
                  )}
                  {results.sim && (
                    <>
                      <tr><td>Assets down in the current simulation</td><td className="num">{results.sim.before.total}</td><td className="num">{results.sim.after.total}</td></tr>
                      <tr><td>Critical assets down</td><td className="num">{results.sim.before.critical}</td><td className="num">{results.sim.after.critical}</td></tr>
                    </>
                  )}
                </tbody>
              </table>

              {results.shared.added.length + results.shared.removed.length > 0 && (
                <p>
                  Hidden shared dependencies: {results.shared.added.length > 0 && <>new — <strong>{results.shared.added.map((x) => x.asset.name).join(', ')}</strong>. </>}
                  {results.shared.removed.length > 0 && <>no longer hidden — <strong>{results.shared.removed.map((x) => x.asset.name).join(', ')}</strong>.</>}
                </p>
              )}
              {results.findings && (
                <>
                  {results.findings.added.map((f) => <p key={f.id}><Badge tone="danger">New</Badge> {FINDING_LABEL[f.kind]}: {f.asset.name}</p>)}
                  {results.findings.removed.map((f) => <p key={f.id}><Badge tone="signal">Gone</Badge> {FINDING_LABEL[f.kind]}: {f.asset.name}</p>)}
                  {results.findings.changed.map((c) => <p key={c.after.id}><Badge>Changed</Badge> {c.after.asset.name}: evidence {c.before.evidence ?? 'none'} → {c.after.evidence ?? 'none'}</p>)}
                </>
              )}
              {results.sim && (
                <>
                  {results.sim.newlyDown.length > 0 && <p><Badge tone="danger">Newly down</Badge> {results.sim.newlyDown.map(nm).join(', ')}</p>}
                  {results.sim.noLongerDown.length > 0 && <p><Badge tone="signal">No longer down</Badge> {results.sim.noLongerDown.map(nm).join(', ')}</p>}
                  {results.sim.roundChanged.length > 0 && <p><Badge>Different round</Badge> {results.sim.roundChanged.map(nm).join(', ')}</p>}
                  {[...(results.simAttr?.entries() ?? [])].map(([id, v]) => (
                    <p key={id} className="dim panel-note">{nm(id)} is {v.direction === 'added' ? 'newly down' : 'no longer down'}. {causes(v.causes)}</p>
                  ))}
                  {results.sim.newlyDown.length + results.sim.noLongerDown.length + results.sim.roundChanged.length === 0 && <p className="dim">The simulation result is the same under these changes.</p>}
                </>
              )}
              {!results.sim && <p className="dim panel-note">Run a simulation to see how these changes alter it.</p>}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDiscard}
        danger
        title="Discard the what-if?"
        confirmLabel="Discard changes"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          wi.discard();
          setConfirmDiscard(false);
        }}
      >
        <p>{wi.count} hypothetical change{wi.count === 1 ? '' : 's'} will be thrown away. Your saved scenario is not affected.</p>
      </ConfirmDialog>
    </section>
  );
}

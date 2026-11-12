import { useEffect, useMemo, useState } from 'react';
import { AssetPatchDialog, CommitDialog, CompareDialog, CreateBranchDialog, DependencyPatchDialog, errorText, RenameBranchDialog } from '../components/graphgit/dialogs';
import { BranchExplorer, CommitHistory, PendingChanges } from '../components/graphgit/panels';
import { SimulationPanel } from '../components/graphgit/SimulationPanel';
import { api } from '../lib/api';
import { StatusBadge } from '../components/editors';
import { GraphView } from '../components/GraphView';
import { ScenarioGate } from '../components/ScenarioGate';
import { Alert, Badge, Button, ConfirmDialog, CritBadge, ErrorState, LoadingBlock, PageHeader } from '../components/ui';
import { commitLabel, shortId, type BranchInfo, type BranchSimulation, type BranchSimulationDetail, type Commit, type CommitComparison, type GraphDoc } from '../lib/graphGit';
import { KIND_LABEL, RELATION_LABEL, type Asset, type Dependency, type Scenario } from '../lib/types';
import { readAuthor, useGraphGit, writeAuthor } from '../state/useGraphGit';
import { useToast } from '../state/ToastContext';

type Tab = 'graph' | 'simulate' | 'history';
/** A historical version shown read-only instead of the branch's working graph. */
interface Viewing {
  commit: Commit;
  graph: GraphDoc;
}

function Inner({ s }: { s: Scenario }) {
  const gg = useGraphGit(s.id);
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('graph');
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [stored, setStored] = useState<BranchSimulationDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);

  const [createFrom, setCreateFrom] = useState<Commit | null | 'head'>(null);
  const [editBranch, setEditBranch] = useState<BranchInfo | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [assetDlg, setAssetDlg] = useState<{ editing?: Asset } | null>(null);
  const [depDlg, setDepDlg] = useState<{ editing?: Dependency; preset?: { dependentId?: string; providerId?: string } } | null>(null);
  const [delAsset, setDelAsset] = useState<Asset | null>(null);
  const [delLink, setDelLink] = useState<Dependency | null>(null);
  const [delBranch, setDelBranch] = useState<BranchInfo | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<Commit | null>(null);
  const [revertTarget, setRevertTarget] = useState<Commit | null>(null);
  const [compare, setCompare] = useState<CommitComparison | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const st = gg.state;
  const branchId = st?.branch.id;

  // A different branch means a different graph: leave any historical view and clear selections.
  useEffect(() => {
    setViewing(null);
    setStored(null);
    setSelectedId(null);
    setSelectedLinkId(null);
  }, [branchId]);

  const graph: GraphDoc = viewing?.graph ?? st?.working ?? { assets: [], dependencies: [] };
  const readOnly = !!viewing;
  const byId = useMemo(() => new Map(graph.assets.map((a) => [a.id, a])), [graph.assets]);
  const nameOf = (id: string) => byId.get(id)?.name ?? 'Unknown';
  const asset = selectedId ? byId.get(selectedId) : undefined;
  const link = selectedLinkId ? graph.dependencies.find((d) => d.id === selectedLinkId) : undefined;

  if (gg.status === 'loading') return <><PageHeader title="Graph Git" /><LoadingBlock label="Loading branches…" /></>;
  if (gg.status === 'error' || !st) return <><PageHeader title="Graph Git" /><ErrorState title="Could not load Graph Git" message={gg.error ?? 'Unknown error.'} onRetry={() => void gg.reload()} /></>;

  const busy = gg.pending > 0 || working;
  const fail = (err: unknown) => toast.error(errorText(err));
  const attempt = async (fn: () => Promise<unknown>, ok?: string) => {
    setWorking(true);
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (err) {
      fail(err);
    } finally {
      setWorking(false);
    }
  };

  const leaveHistory = () => {
    setViewing(null);
    setStored(null);
  };
  const viewCommit = (c: Commit) =>
    void attempt(async () => {
      const detail = await gg.loadCommit(c.id);
      setViewing({ commit: detail.commit, graph: detail.graph });
      setStored(null);
      setSelectedId(null);
      setSelectedLinkId(null);
      setTab('graph');
    });

  const edit = (ops: Parameters<typeof gg.applyOps>[0]) => gg.applyOps(ops);
  const move = (id: string, x: number, y: number) => {
    gg.applyOps([{ type: 'move_node', nodeId: id, x, y }]).catch((err) => {
      if (!/already there/.test(errorText(err))) fail(err);
    });
  };

  const openSaved = (sim: BranchSimulation) =>
    void attempt(async () => {
      const detail = await gg.openSimulation(sim.id);
      if (detail.commitId === st.head.id && !st.dirty) setViewing(null);
      else {
        const known = gg.commits.find((c) => c.id === detail.commitId);
        setViewing({ commit: known ?? (await gg.loadCommit(detail.commitId)).commit, graph: detail.graph });
      }
      setStored(detail);
    });

  const storedValid = stored && (viewing ? viewing.commit.id === stored.commitId : !st.dirty && st.head.id === stored.commitId) ? stored : null;
  const saveTarget = viewing ? { commitId: viewing.commit.id, seq: viewing.commit.seq } : !st.dirty ? { commitId: st.head.id, seq: st.head.seq } : null;
  const graphLabel = viewing ? `commit ${commitLabel(viewing.commit)} “${viewing.commit.message}” (read-only)` : st.dirty ? `${st.branch.name} working graph (uncommitted changes)` : `${st.branch.name} at commit ${commitLabel(st.head)}`;

  const dirtyCount = st.patches.length;
  const createSource = createFrom === 'head' ? { branchName: st.branch.name, commit: st.head, historical: false } : createFrom ? { branchName: createFrom.branchName ?? st.branch.name, commit: createFrom, historical: true } : null;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'graph', label: 'Graph' },
    { id: 'simulate', label: 'Simulation' },
    { id: 'history', label: `History (${gg.commitTotal})` },
  ];

  return (
    <>
      <PageHeader
        title="Graph Git"
        description={
          <>
            Version control for <strong>{s.name}</strong>. Each branch keeps its own copy of the dependency graph. Edit it, commit the change, and run the cascade simulation on exactly that version, without touching main.
          </>
        }
      />

      <section className="card gg-bar" aria-label="Workspace">
        <div className="gg-bar-grid">
          <div className="field gg-bar-field">
            <label htmlFor="gg-branch">Branch</label>
            <select id="gg-branch" className="select" value={st.branch.id} disabled={busy} onChange={(e) => void attempt(() => gg.selectBranch(e.target.value))}>
              {gg.branches.map((b) => <option key={b.id} value={b.id}>{b.name}{b.isDefault ? ' (default)' : ''}</option>)}
            </select>
          </div>
          <div className="gg-bar-state">
            <span className="eyebrow">Current commit</span>
            <span><span className="mono gg-commit-n">{commitLabel(st.head)}</span> <span className="mono dim">{shortId(st.head.id)}</span> {st.head.message}</span>
          </div>
          <div className="gg-bar-state">
            <span className="eyebrow">Status</span>
            <span>{st.dirty ? <Badge tone="ghost">{dirtyCount} uncommitted change{dirtyCount === 1 ? '' : 's'}</Badge> : <Badge tone="signal">Clean</Badge>} {busy && <span className="dim">Saving…</span>}</span>
          </div>
          <div className="row-actions gg-bar-actions">
            <Button size="sm" onClick={() => setCreateFrom('head')} disabled={busy}>Create branch</Button>
            <Button size="sm" variant="primary" onClick={() => setCommitOpen(true)} disabled={busy || !st.dirty || readOnly}>Commit changes</Button>
            <Button size="sm" onClick={() => setTab('simulate')}>Run simulation</Button>
            <Button size="sm" onClick={() => setTab('history')}>View history</Button>
          </div>
        </div>
      </section>

      {st.scenarioDrift && (
        <Alert tone="warn">
          The scenario’s assets or dependencies were edited elsewhere in GhostGrid after main’s latest commit. Main has not changed.{' '}
          {st.dirty ? 'Commit or discard the uncommitted changes on main before syncing.' : <button className="link-btn" onClick={() => void attempt(() => gg.syncMain({ author: readAuthor() }), 'Committed the scenario’s edits to main.')} disabled={busy}>Commit those edits to main</button>}
        </Alert>
      )}

      <div className="gg-layout">
        <BranchExplorer
          branches={gg.branches}
          activeId={st.branch.id}
          busy={busy}
          onSelect={(id) => void attempt(() => gg.selectBranch(id))}
          onCreate={() => setCreateFrom('head')}
          onEdit={setEditBranch}
          onDelete={(b) => { setDialogError(null); setDelBranch(b); }}
        />

        <div className="gg-main">
          {viewing && (
            <Alert tone="info">
              <strong>Viewing {commitLabel(viewing.commit)} “{viewing.commit.message}” (read-only).</strong> This is a past version; nothing here changes the branch.{' '}
              <button className="link-btn" onClick={leaveHistory}>Back to {st.branch.name}</button> · <button className="link-btn" onClick={() => setCreateFrom(viewing.commit)}>Branch from here</button> · <button className="link-btn" onClick={() => setRestoreTarget(viewing.commit)} disabled={viewing.commit.id === st.head.id}>Restore this version</button>
            </Alert>
          )}

          <div className="seg gg-tabs" role="radiogroup" aria-label="Workspace view">
            {tabs.map((t) => (
              <button key={t.id} role="radio" aria-checked={tab === t.id} className="seg-btn" onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>

          {tab === 'graph' && (
            <div className="graph-layout gg-graph">
              <GraphView
                assets={graph.assets}
                dependencies={graph.dependencies}
                label={`${st.branch.name} dependency graph`}
                height={560}
                selectedId={selectedId}
                selectedLinkId={selectedLinkId}
                onSelect={(id) => { setSelectedId(id); setSelectedLinkId(null); }}
                onSelectLink={(id) => { setSelectedLinkId(id); setSelectedId(null); }}
                onBackgroundClick={() => { setSelectedId(null); setSelectedLinkId(null); }}
                onMoveNode={readOnly ? undefined : move}
                linkMarkers
                toolbar={
                  readOnly ? undefined : (
                    <>
                      <Button size="sm" onClick={() => setAssetDlg({})} disabled={busy}>Add asset</Button>
                      <Button size="sm" onClick={() => setDepDlg({})} disabled={busy || graph.assets.length < 2}>Add dependency</Button>
                    </>
                  )
                }
              />
              <div className="gg-side">
                <section className="card panel-slot" aria-label="Details">
                  {asset ? (
                    <>
                      <h2 className="card-title">{asset.name}</h2>
                      <p><Badge>{KIND_LABEL[asset.kind]}</Badge> <CritBadge level={asset.criticality} /></p>
                      {asset.notes && <p className="dim panel-notes">{asset.notes}</p>}
                      <p className="dim panel-note">
                        Relies on {graph.dependencies.filter((d) => d.dependentId === asset.id).length} · relied on by {graph.dependencies.filter((d) => d.providerId === asset.id).length}
                      </p>
                      {!readOnly && (
                        <div className="panel-actions">
                          <Button size="sm" onClick={() => setAssetDlg({ editing: asset })} disabled={busy}>Edit</Button>
                          <Button size="sm" onClick={() => setDepDlg({ preset: { dependentId: asset.id } })} disabled={busy || graph.assets.length < 2}>Add dependency</Button>
                          <Button size="sm" variant="danger" onClick={() => setDelAsset(asset)} disabled={busy}>Delete</Button>
                        </div>
                      )}
                    </>
                  ) : link ? (
                    <>
                      <h2 className="card-title link-title">{nameOf(link.dependentId)} relies on {nameOf(link.providerId)}</h2>
                      <p><Badge tone={link.mode === 'alternate' ? 'ghost' : undefined}>{link.mode === 'alternate' ? 'Alternate (backup)' : 'Required'}</Badge> <StatusBadge status={link.status} /> <Badge>{RELATION_LABEL[link.relation]}</Badge></p>
                      {link.notes && <p className="dim panel-notes">{link.notes}</p>}
                      {!readOnly && (
                        <div className="panel-actions">
                          <Button size="sm" onClick={() => setDepDlg({ editing: link })} disabled={busy}>Edit</Button>
                          <Button size="sm" onClick={() => void attempt(() => edit([{ type: 'set_dependency_mode', dependencyId: link.id, mode: link.mode === 'required' ? 'alternate' : 'required' }]))} disabled={busy}>
                            Make {link.mode === 'required' ? 'alternate' : 'required'}
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => setDelLink(link)} disabled={busy}>Remove</Button>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <h2 className="card-title">{viewing ? `Version ${commitLabel(viewing.commit)}` : st.branch.name}</h2>
                      <p className="dim panel-note">{graph.assets.length} assets · {graph.dependencies.length} dependencies</p>
                      <ul className="tips">
                        <li>Click an asset or link to inspect it.</li>
                        {!readOnly && <li>Drag assets to rearrange. Every change applies to <strong>{st.branch.name}</strong> only.</li>}
                        {!readOnly && <li>Commit to save a permanent version you can restore or simulate.</li>}
                      </ul>
                    </>
                  )}
                </section>
                {!readOnly && (
                  <PendingChanges patches={st.patches} busy={busy} onUndo={(p) => void attempt(() => gg.undoPatch(p.id))} onDiscard={() => setDiscardOpen(true)} onCommit={() => setCommitOpen(true)} />
                )}
              </div>
            </div>
          )}

          {tab === 'simulate' && (
            <SimulationPanel
              graph={graph}
              graphLabel={graphLabel}
              saveTarget={saveTarget}
              onRequestCommit={() => setCommitOpen(true)}
              sims={gg.sims}
              stored={storedValid}
              busy={busy}
              onSave={(b) => gg.saveSimulation(b)}
              onOpenSaved={openSaved}
              onClearStored={() => setStored(null)}
              onSaved={(m) => toast.success(m)}
            />
          )}

          {tab === 'history' && (
            <CommitHistory
              commits={gg.commits}
              total={gg.commitTotal}
              headId={st.head.id}
              viewingId={viewing?.commit.id ?? null}
              busy={busy}
              activeBranchName={st.branch.name}
              onView={viewCommit}
              onBranch={(c) => setCreateFrom(c)}
              onRestore={setRestoreTarget}
              onRevert={setRevertTarget}
              onCompare={(c) => void attempt(async () => setCompare(await api.compareCommits(c.id, st.head.id)))}
            />
          )}
        </div>
      </div>

      {createSource && (
        <CreateBranchDialog
          open
          onClose={() => setCreateFrom(null)}
          branchNames={gg.branches.map((b) => b.name)}
          from={createSource}
          uncommitted={dirtyCount}
          onCreate={async (v) => {
            await gg.createBranch(v);
            toast.success(`Created branch ${v.name} and switched to it.`);
          }}
        />
      )}
      <RenameBranchDialog
        open={!!editBranch}
        onClose={() => setEditBranch(null)}
        branch={editBranch}
        branchNames={gg.branches.map((b) => b.name)}
        onSave={async (v) => {
          if (editBranch) await gg.renameBranch(editBranch.id, v);
        }}
      />
      <CommitDialog
        open={commitOpen}
        onClose={() => setCommitOpen(false)}
        branchName={st.branch.name}
        patches={st.patches}
        author={readAuthor()}
        onCommit={async (v) => {
          const c = await gg.commit({ message: v.message, body: v.body || undefined, author: v.author || undefined });
          writeAuthor(v.author);
          toast.success(`Committed ${commitLabel(c)} to ${st.branch.name}.`);
        }}
      />
      <AssetPatchDialog open={!!assetDlg} onClose={() => setAssetDlg(null)} graph={graph} editing={assetDlg?.editing} onSubmit={edit} />
      <DependencyPatchDialog open={!!depDlg} onClose={() => setDepDlg(null)} graph={graph} editing={depDlg?.editing} preset={depDlg?.preset} onSubmit={edit} />
      <CompareDialog open={!!compare} onClose={() => setCompare(null)} data={compare} />

      <ConfirmDialog
        open={!!delAsset}
        danger
        title={`Delete “${delAsset?.name ?? ''}” from ${st.branch.name}?`}
        confirmLabel="Delete asset"
        busy={busy}
        onCancel={() => setDelAsset(null)}
        onConfirm={() => {
          const a = delAsset;
          setDelAsset(null);
          if (a) void attempt(() => edit([{ type: 'delete_node', nodeId: a.id }]).then(() => setSelectedId(null)));
        }}
      >
        <p>
          The asset and its {delAsset ? graph.dependencies.filter((d) => d.dependentId === delAsset.id || d.providerId === delAsset.id).length : 0} dependencies are removed from this branch’s working graph. Other branches are not affected, and you can undo this before committing.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!delLink}
        danger
        title="Remove this dependency?"
        confirmLabel="Remove dependency"
        busy={busy}
        onCancel={() => setDelLink(null)}
        onConfirm={() => {
          const d = delLink;
          setDelLink(null);
          if (d) void attempt(() => edit([{ type: 'remove_dependency', dependencyId: d.id }]).then(() => setSelectedLinkId(null)));
        }}
      >
        <p>{delLink ? `${nameOf(delLink.dependentId)} will no longer rely on ${nameOf(delLink.providerId)} on this branch.` : ''}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={discardOpen}
        danger
        title="Discard uncommitted changes?"
        confirmLabel="Discard changes"
        busy={busy}
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => {
          setDiscardOpen(false);
          void attempt(() => gg.discard(), 'Discarded uncommitted changes.');
        }}
      >
        <p>{dirtyCount} change{dirtyCount === 1 ? '' : 's'} on {st.branch.name} will be thrown away and the working graph returns to commit {commitLabel(st.head)}. Commits are not affected.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!delBranch}
        danger
        title={`Delete branch ${delBranch?.name ?? ''}?`}
        confirmLabel="Delete branch"
        busy={busy}
        onCancel={() => setDelBranch(null)}
        onConfirm={() => {
          const b = delBranch;
          if (!b) return;
          setWorking(true);
          gg.deleteBranch(b.id)
            .then(() => {
              setDelBranch(null);
              toast.success(`Deleted branch ${b.name}.`);
            })
            .catch((err) => setDialogError(errorText(err)))
            .finally(() => setWorking(false));
        }}
      >
        <p>
          This permanently deletes the branch’s {delBranch?.commitCount ?? 0} commit{delBranch?.commitCount === 1 ? '' : 's'}, {delBranch?.simulationCount ?? 0} saved simulation{delBranch?.simulationCount === 1 ? '' : 's'} and {delBranch?.pendingPatchCount ?? 0} uncommitted change{delBranch?.pendingPatchCount === 1 ? '' : 's'}. Main and other branches are not changed. Branches that others were built from cannot be deleted.
        </p>
        {dialogError && <Alert tone="error">{dialogError}</Alert>}
      </ConfirmDialog>
      <ConfirmDialog
        open={!!restoreTarget}
        title={`Restore ${restoreTarget ? commitLabel(restoreTarget) : ''} onto ${st.branch.name}?`}
        confirmLabel="Restore as new commit"
        busy={busy}
        onCancel={() => { setRestoreTarget(null); setDialogError(null); }}
        onConfirm={() => {
          const c = restoreTarget;
          if (!c) return;
          setWorking(true);
          gg.restore(c.id, { discardPending: st.dirty, author: readAuthor() || undefined })
            .then((n) => {
              setRestoreTarget(null);
              setDialogError(null);
              leaveHistory();
              toast.success(`Restored ${commitLabel(c)} as new commit ${commitLabel(n)}.`);
            })
            .catch((err) => setDialogError(errorText(err)))
            .finally(() => setWorking(false));
        }}
      >
        <p>“{restoreTarget?.message}” becomes the graph on {st.branch.name} through a <strong>new commit</strong>. History is not rewritten; later commits stay in the log.</p>
        {st.dirty && <Alert tone="warn">The {dirtyCount} uncommitted change{dirtyCount === 1 ? '' : 's'} on this branch will be discarded.</Alert>}
        {dialogError && <Alert tone="error">{dialogError}</Alert>}
      </ConfirmDialog>
      <ConfirmDialog
        open={!!revertTarget}
        title={`Revert ${revertTarget ? commitLabel(revertTarget) : ''} on ${st.branch.name}?`}
        confirmLabel="Revert as new commit"
        busy={busy}
        onCancel={() => { setRevertTarget(null); setDialogError(null); }}
        onConfirm={() => {
          const c = revertTarget;
          if (!c) return;
          setWorking(true);
          gg.revert(c.id, { discardPending: st.dirty, author: readAuthor() || undefined })
            .then((n) => {
              setRevertTarget(null);
              setDialogError(null);
              toast.success(`Reverted ${commitLabel(c)} with new commit ${commitLabel(n)}.`);
            })
            .catch((err) => setDialogError(errorText(err)))
            .finally(() => setWorking(false));
        }}
      >
        <p>Adds a commit that undoes only what “{revertTarget?.message}” changed, keeping later work. If later changes conflict, nothing is saved and you will be told why.</p>
        {st.dirty && <Alert tone="warn">The {dirtyCount} uncommitted change{dirtyCount === 1 ? '' : 's'} on this branch will be discarded.</Alert>}
        {dialogError && <Alert tone="error">{dialogError}</Alert>}
      </ConfirmDialog>
    </>
  );
}

export default function GraphGit() {
  return (
    <ScenarioGate title="Graph Git" description="Branches, commits and branch-specific simulations.">
      {(s) => <Inner key={s.id} s={s} />}
    </ScenarioGate>
  );
}

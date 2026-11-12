import { useState } from 'react';
import { branchTree, COMMIT_KIND_LABEL, commitLabel, PATCH_CATEGORY_LABEL, shortId, summaryText, type BranchInfo, type Commit, type Patch } from '../../lib/graphGit';
import { Badge, Button, EmptyState } from '../ui';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/* --------------------------------------------------------- branch explorer */

export function BranchExplorer({
  branches,
  activeId,
  busy,
  onSelect,
  onCreate,
  onEdit,
  onDelete,
}: {
  branches: BranchInfo[];
  activeId: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onEdit: (b: BranchInfo) => void;
  onDelete: (b: BranchInfo) => void;
}) {
  const tree = branchTree(branches);
  const active = branches.find((b) => b.id === activeId);
  return (
    <aside className="gg-explorer" aria-label="Branch explorer">
      <section className="card">
        <div className="gg-card-head">
          <h2 className="card-title">Branches</h2>
          <Button size="sm" onClick={onCreate} disabled={busy}>New branch</Button>
        </div>
        <ul className="gg-branch-list">
          {tree.map(({ branch: b, depth }) => (
            <li key={b.id} style={{ paddingLeft: depth * 14 }} className="gg-branch-item" data-depth={depth > 0 ? 'child' : undefined}>
              <button className="gg-branch" aria-current={b.id === activeId ? 'true' : undefined} onClick={() => onSelect(b.id)} disabled={busy && b.id !== activeId}>
                <span className="gg-branch-top">
                  <span className="mono gg-branch-name">{b.name}</span>
                  {b.isDefault && <Badge tone="signal">default</Badge>}
                  {b.pendingPatchCount > 0 && <Badge tone="ghost">{b.pendingPatchCount} uncommitted</Badge>}
                </span>
                <span className="gg-branch-meta">
                  {b.commitCount} commit{b.commitCount === 1 ? '' : 's'} · latest <span className="mono">{commitLabel(b.headCommit)}</span> {clip(b.headCommit.message, 36)}
                </span>
                <span className="gg-branch-meta">Created {date(b.createdAt)}{b.parentBranchName ? ` from ${b.parentBranchName}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {active && (
        <section className="card" aria-label={`About ${active.name}`}>
          <h2 className="card-title">Active branch</h2>
          <p className="mono gg-branch-name">{active.name}</p>
          {active.description ? <p className="dim panel-note">{active.description}</p> : <p className="dim panel-note">No description.</p>}
          <dl className="gg-facts">
            <dt>Ancestry</dt>
            <dd className="mono">{active.ancestry.map((a) => a.name).join(' → ')}</dd>
            <dt>Base commit</dt>
            <dd><span className="mono">{commitLabel({ seq: active.baseCommitSeq })}</span> <span className="mono dim">{shortId(active.baseCommitId)}</span></dd>
            <dt>Latest commit</dt>
            <dd><span className="mono">{commitLabel(active.headCommit)}</span> <span className="mono dim">{shortId(active.headCommitId)}</span></dd>
            <dt>Commits</dt>
            <dd>{active.commitCount}</dd>
            <dt>Saved simulations</dt>
            <dd>{active.simulationCount}</dd>
            <dt>Created</dt>
            <dd>{when(active.createdAt)}</dd>
            <dt>Modified</dt>
            <dd>{when(active.updatedAt)}</dd>
          </dl>
          <div className="row-actions">
            <Button size="sm" onClick={() => onEdit(active)} disabled={busy}>Rename / describe</Button>
            <Button size="sm" variant="danger" onClick={() => onDelete(active)} disabled={busy || active.isDefault} title={active.isDefault ? 'The default branch cannot be deleted.' : undefined}>Delete</Button>
          </div>
        </section>
      )}
    </aside>
  );
}

/* ---------------------------------------------------------- pending changes */

export function PendingChanges({
  patches,
  busy,
  onUndo,
  onDiscard,
  onCommit,
}: {
  patches: Patch[];
  busy: boolean;
  onUndo: (p: Patch) => void;
  onDiscard: () => void;
  onCommit: () => void;
}) {
  return (
    <section className="card" aria-labelledby="gg-pending-title">
      <h2 id="gg-pending-title" className="card-title">Uncommitted changes ({patches.length})</h2>
      {patches.length === 0 ? (
        <p className="dim panel-note">Nothing yet. Edits you make here apply to this branch only, and are saved on the server as you go.</p>
      ) : (
        <>
          <ol className="gg-patches">
            {patches.map((p) => (
              <li key={p.id} data-reverted={p.reverted ? 'true' : undefined}>
                <span className="gg-patch-body">
                  <Badge tone={p.category === 'behavioural' ? 'ghost' : undefined}>{PATCH_CATEGORY_LABEL[p.category]}</Badge>
                  <span className="gg-patch-text">{p.description}</span>
                  {p.revertsPatchId && <span className="dim"> (undo)</span>}
                  {p.reverted && <span className="dim"> (undone)</span>}
                </span>
                <Button size="sm" variant="ghost" disabled={busy || p.reverted} onClick={() => onUndo(p)} aria-label={`Undo: ${p.description}`}>Undo</Button>
              </li>
            ))}
          </ol>
          <div className="row-actions">
            <Button variant="primary" size="sm" onClick={onCommit} disabled={busy}>Commit changes</Button>
            <Button variant="ghost" size="sm" onClick={onDiscard} disabled={busy}>Discard all</Button>
          </div>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ history */

export function CommitHistory({
  commits,
  total,
  headId,
  viewingId,
  busy,
  activeBranchName,
  onView,
  onBranch,
  onRestore,
  onRevert,
  onCompare,
}: {
  commits: Commit[];
  total: number;
  headId: string;
  viewingId: string | null;
  busy: boolean;
  activeBranchName: string;
  onView: (c: Commit) => void;
  onBranch: (c: Commit) => void;
  onRestore: (c: Commit) => void;
  onRevert: (c: Commit) => void;
  onCompare: (c: Commit) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!commits.length) return <EmptyState title="No commits">This branch has no history yet.</EmptyState>;
  return (
    <section aria-label="Commit history">
      <p className="dim panel-note">
        {total} commit{total === 1 ? '' : 's'} in the history of <span className="mono">{activeBranchName}</span>, newest first. Commits are permanent: restoring or reverting adds a new commit.
      </p>
      <ol className="gg-timeline">
        {commits.map((c) => {
          const expanded = open === c.id;
          return (
            <li key={c.id} className="gg-commit" data-head={c.id === headId ? 'true' : undefined} data-viewing={c.id === viewingId ? 'true' : undefined}>
              <div className="gg-commit-main">
                <div className="gg-commit-top">
                  <span className="mono gg-commit-n">{commitLabel(c)}</span>
                  <strong className="gg-commit-msg">{c.message}</strong>
                </div>
                <div className="gg-commit-meta">
                  <span className="mono">{shortId(c.id)}</span>
                  <Badge>{c.branchName ?? 'branch'}</Badge>
                  <Badge tone={c.kind === 'commit' ? undefined : 'ghost'}>{COMMIT_KIND_LABEL[c.kind]}</Badge>
                  {c.id === headId && <Badge tone="signal">head</Badge>}
                  {c.id === viewingId && <Badge tone="signal">viewing</Badge>}
                  <span className="dim">{when(c.createdAt)}</span>
                  {c.author && <span className="dim">· {c.author}</span>}
                </div>
                <p className="gg-commit-sum">{summaryText(c.summary)}</p>
                {expanded && (
                  <div className="gg-commit-detail">
                    {c.body && <p>{c.body}</p>}
                    <ul className="gg-change-list">{c.summary.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
                    <p className="dim">{c.nodeCount} assets, {c.linkCount} dependencies in this version.</p>
                  </div>
                )}
              </div>
              <div className="gg-commit-actions">
                <Button size="sm" variant="ghost" onClick={() => setOpen(expanded ? null : c.id)} aria-expanded={expanded}>{expanded ? 'Less' : 'Details'}</Button>
                <Button size="sm" onClick={() => onView(c)} disabled={busy || c.id === viewingId}>View</Button>
                <Button size="sm" onClick={() => onBranch(c)} disabled={busy}>Branch from here</Button>
                <Button size="sm" onClick={() => onCompare(c)} disabled={busy || c.id === headId}>Compare with head</Button>
                <Button size="sm" onClick={() => onRestore(c)} disabled={busy || c.id === headId} title={`Adds a new commit on ${activeBranchName} with this version`}>Restore</Button>
                <Button size="sm" onClick={() => onRevert(c)} disabled={busy || !c.parentCommitId} title={c.parentCommitId ? 'Adds a commit that undoes this commit’s changes' : 'The first commit has nothing to revert to'}>Revert</Button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

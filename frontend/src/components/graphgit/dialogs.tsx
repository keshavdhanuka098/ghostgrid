import { useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import type { Commit, GraphDoc, Patch, PatchOp } from '../../lib/graphGit';
import { commitLabel } from '../../lib/graphGit';
import { validateAsset, validateDependency } from '../../lib/scenarioOps';
import {
  ASSET_KINDS,
  CRITICALITIES,
  CRIT_LABEL,
  KIND_LABEL,
  LINK_STATUSES,
  RELATIONS,
  RELATION_LABEL,
  STATUS_LABEL,
  type Asset,
  type AssetKind,
  type Criticality,
  type Dependency,
  type DependencyMode,
  type LinkStatus,
  type Relation,
  type Scenario,
} from '../../lib/types';
import { Alert, Badge, Button, Dialog, SelectField, TextAreaField, TextField } from '../ui';

export const errorText = (err: unknown) =>
  err instanceof ApiError ? [err.message, ...err.details.filter((d) => d !== 'discardPending')].join(' ') : err instanceof Error ? err.message : 'Something went wrong.';

/** The existing scenario validators only read assets and dependencies; this wraps a branch graph so they can be reused as they are. */
const asScenario = (g: GraphDoc): Scenario => ({
  id: '',
  name: '',
  description: '',
  sector: '',
  sampleKey: null,
  isSample: false,
  createdAt: '',
  updatedAt: '',
  assets: g.assets,
  dependencies: g.dependencies,
  runs: [],
  strategies: [],
  assumptions: [],
});

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export function validateBranchName(name: string, others: string[], selfName?: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Give the branch a name, for example fix/auth-microservice-timeout.';
  if (n.length > 80) return 'Keep the name under 80 characters.';
  if (!BRANCH_RE.test(n) || n.includes('//') || n.includes('..') || /[/.]$/.test(n)) return 'Use letters, numbers, ".", "_", "-" and "/". Start with a letter or number; do not end with "/" or ".".';
  if (others.some((o) => o.toLowerCase() === n.toLowerCase() && o !== selfName)) return 'A branch with this name already exists.';
  return undefined;
}

function useSubmit(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, submit };
}

/* ------------------------------------------------------------------ branch */

interface CreateProps {
  open: boolean;
  onClose: () => void;
  branchNames: string[];
  /** Where the branch starts. */
  from: { branchName: string; commit: Commit; historical: boolean };
  uncommitted: number;
  onCreate: (v: { name: string; description: string; fromCommitId: string }) => Promise<unknown>;
}

export function CreateBranchDialog(p: CreateProps) {
  return (
    <Dialog open={p.open} onClose={p.onClose} title="Create branch">
      {p.open && <CreateForm {...p} />}
    </Dialog>
  );
}

function CreateForm({ onClose, branchNames, from, uncommitted, onCreate }: CreateProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const { busy, error, submit } = useSubmit(onClose);
  const go = (ev: FormEvent) => {
    ev.preventDefault();
    const e = validateBranchName(name, branchNames);
    setNameError(e);
    if (e) return;
    void submit(() => onCreate({ name: name.trim(), description: description.trim(), fromCommitId: from.commit.id }));
  };
  return (
    <form onSubmit={go} noValidate className="stack">
      <p className="dim">
        {from.historical ? 'Starts from the historical commit ' : `Starts from the latest commit of ${from.branchName}, `}
        <strong className="mono">{commitLabel(from.commit)}</strong> “{from.commit.message}”. The new branch gets its own copy of that graph.
      </p>
      {uncommitted > 0 && !from.historical && <Alert tone="warn">{uncommitted} uncommitted change{uncommitted === 1 ? '' : 's'} on {from.branchName} are not carried over. Commit them first to include them.</Alert>}
      <TextField label="Branch name" value={name} maxLength={80} placeholder="fix/auth-microservice-timeout" error={nameError} autoFocus onChange={(e) => { setName(e.target.value); setNameError(undefined); }} />
      <TextAreaField label="Description (optional)" value={description} maxLength={300} rows={2} onChange={(e) => setDescription(e.target.value)} />
      {error && <Alert tone="error">{error}</Alert>}
      <div className="dialog-foot">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>Create branch</Button>
      </div>
    </form>
  );
}

interface RenameProps {
  open: boolean;
  onClose: () => void;
  branch: { name: string; description: string } | null;
  branchNames: string[];
  onSave: (v: { name: string; description: string }) => Promise<unknown>;
}

export function RenameBranchDialog(p: RenameProps) {
  return (
    <Dialog open={p.open} onClose={p.onClose} title="Edit branch">
      {p.open && p.branch && <RenameForm {...p} branch={p.branch} />}
    </Dialog>
  );
}

function RenameForm({ onClose, branch, branchNames, onSave }: RenameProps & { branch: { name: string; description: string } }) {
  const [name, setName] = useState(branch.name);
  const [description, setDescription] = useState(branch.description);
  const [nameError, setNameError] = useState<string | undefined>();
  const { busy, error, submit } = useSubmit(onClose);
  return (
    <form
      noValidate
      className="stack"
      onSubmit={(ev) => {
        ev.preventDefault();
        const e = validateBranchName(name, branchNames, branch.name);
        setNameError(e);
        if (!e) void submit(() => onSave({ name: name.trim(), description: description.trim() }));
      }}
    >
      <TextField label="Branch name" value={name} maxLength={80} error={nameError} autoFocus onChange={(e) => { setName(e.target.value); setNameError(undefined); }} />
      <TextAreaField label="Description" value={description} maxLength={300} rows={2} onChange={(e) => setDescription(e.target.value)} />
      {error && <Alert tone="error">{error}</Alert>}
      <div className="dialog-foot">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>Save</Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ commit */

interface CommitProps {
  open: boolean;
  onClose: () => void;
  branchName: string;
  patches: Patch[];
  author: string;
  onCommit: (v: { message: string; body: string; author: string }) => Promise<unknown>;
}

export function CommitDialog(p: CommitProps) {
  return (
    <Dialog open={p.open} onClose={p.onClose} title={`Commit to ${p.branchName}`}>
      {p.open && <CommitForm {...p} />}
    </Dialog>
  );
}

function CommitForm({ onClose, patches, author: initialAuthor, onCommit }: CommitProps) {
  const [message, setMessage] = useState('');
  const [body, setBody] = useState('');
  const [author, setAuthor] = useState(initialAuthor);
  const [msgError, setMsgError] = useState<string | undefined>();
  const { busy, error, submit } = useSubmit(onClose);
  const lines = patches.filter((x) => x.category !== 'layout' && !x.reverted);
  const moves = patches.filter((x) => x.category === 'layout').length;
  return (
    <form
      noValidate
      className="stack"
      onSubmit={(ev) => {
        ev.preventDefault();
        const m = message.trim();
        const e = !m ? 'Describe what changed, for example “Add backup auth database”.' : m.length > 120 ? 'Keep the message under 120 characters.' : undefined;
        setMsgError(e);
        if (!e) void submit(() => onCommit({ message: m, body: body.trim(), author: author.trim() }));
      }}
    >
      <TextField label="Commit message" value={message} maxLength={120} error={msgError} autoFocus onChange={(e) => { setMessage(e.target.value); setMsgError(undefined); }} />
      <TextAreaField label="Details (optional)" value={body} maxLength={2000} rows={3} onChange={(e) => setBody(e.target.value)} />
      <TextField label="Author (optional)" value={author} maxLength={80} hint="Stored with the commit. GhostGrid has no sign-in, so this is whatever you type." onChange={(e) => setAuthor(e.target.value)} />
      <div>
        <h3 className="panel-h">Included changes ({patches.length})</h3>
        <ul className="gg-change-list">
          {lines.map((x) => (
            <li key={x.id}>{x.description}</li>
          ))}
          {moves > 0 && <li>Moved {moves} asset{moves === 1 ? '' : 's'} on the canvas</li>}
        </ul>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="dialog-foot">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>Commit</Button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------- patch forms */

const byName = (assets: Asset[]) => [...assets].sort((a, b) => a.name.localeCompare(b.name));

interface AssetPatchProps {
  open: boolean;
  onClose: () => void;
  graph: GraphDoc;
  editing?: Asset;
  onSubmit: (ops: PatchOp[]) => Promise<unknown>;
}

export function AssetPatchDialog(p: AssetPatchProps) {
  return (
    <Dialog open={p.open} onClose={p.onClose} title={p.editing ? 'Edit asset on this branch' : 'Add asset to this branch'}>
      {p.open && <AssetPatchForm {...p} />}
    </Dialog>
  );
}

function AssetPatchForm({ onClose, graph, editing, onSubmit }: AssetPatchProps) {
  const [name, setName] = useState(editing?.name ?? '');
  const [kind, setKind] = useState<AssetKind>(editing?.kind ?? 'service');
  const [criticality, setCriticality] = useState<Criticality>(editing?.criticality ?? 'medium');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [errors, setErrors] = useState<ReturnType<typeof validateAsset>>({});
  const { busy, error, submit } = useSubmit(onClose);
  return (
    <form
      noValidate
      className="stack"
      onSubmit={(ev) => {
        ev.preventDefault();
        const e = validateAsset({ name, notes }, asScenario(graph), editing?.id);
        setErrors(e);
        if (Object.keys(e).length) return;
        const ops: PatchOp[] = [];
        if (!editing) ops.push({ type: 'add_node', node: { name: name.trim(), kind, criticality, notes: notes.trim() } });
        else {
          const changes: { name?: string; kind?: AssetKind; notes?: string } = {};
          if (name.trim() !== editing.name) changes.name = name.trim();
          if (kind !== editing.kind) changes.kind = kind;
          if (notes.trim() !== editing.notes) changes.notes = notes.trim();
          if (Object.keys(changes).length) ops.push({ type: 'modify_node', nodeId: editing.id, changes });
          if (criticality !== editing.criticality) ops.push({ type: 'set_criticality', nodeId: editing.id, criticality });
          if (!ops.length) return void onClose();
        }
        void submit(() => onSubmit(ops));
      }}
    >
      <TextField label="Name" value={name} maxLength={60} error={errors.name} autoFocus onChange={(e) => setName(e.target.value)} />
      <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as AssetKind)}>
        {ASSET_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
      </SelectField>
      <SelectField label="Criticality" value={criticality} onChange={(e) => setCriticality(e.target.value as Criticality)}>
        {CRITICALITIES.map((c) => <option key={c} value={c}>{CRIT_LABEL[c]}</option>)}
      </SelectField>
      <TextAreaField label="Notes" value={notes} maxLength={200} rows={2} error={errors.notes} onChange={(e) => setNotes(e.target.value)} />
      {error && <Alert tone="error">{error}</Alert>}
      <div className="dialog-foot">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>{editing ? 'Save change' : 'Add asset'}</Button>
      </div>
    </form>
  );
}

interface DepPatchProps {
  open: boolean;
  onClose: () => void;
  graph: GraphDoc;
  editing?: Dependency;
  preset?: { dependentId?: string; providerId?: string };
  onSubmit: (ops: PatchOp[]) => Promise<unknown>;
}

export function DependencyPatchDialog(p: DepPatchProps) {
  return (
    <Dialog open={p.open} onClose={p.onClose} title={p.editing ? 'Edit dependency on this branch' : 'Add dependency to this branch'}>
      {p.open && <DepPatchForm {...p} />}
    </Dialog>
  );
}

function DepPatchForm({ onClose, graph, editing, preset, onSubmit }: DepPatchProps) {
  const [dependentId, setDependentId] = useState(editing?.dependentId ?? preset?.dependentId ?? '');
  const [providerId, setProviderId] = useState(editing?.providerId ?? preset?.providerId ?? '');
  const [relation, setRelation] = useState<Relation>(editing?.relation ?? 'power');
  const [status, setStatus] = useState<LinkStatus>(editing?.status ?? 'confirmed');
  const [mode, setMode] = useState<DependencyMode>(editing?.mode ?? 'required');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [errors, setErrors] = useState<ReturnType<typeof validateDependency>>({});
  const { busy, error, submit } = useSubmit(onClose);
  const sorted = byName(graph.assets);
  return (
    <form
      noValidate
      className="stack"
      onSubmit={(ev) => {
        ev.preventDefault();
        const e = validateDependency({ dependentId, providerId, notes }, asScenario(graph), editing?.id);
        setErrors(e);
        if (Object.keys(e).length) return;
        const ops: PatchOp[] = [];
        if (!editing) ops.push({ type: 'add_dependency', dependency: { dependentId, providerId, mode, status, relation, notes: notes.trim() } });
        else {
          if (providerId !== editing.providerId) ops.push({ type: 'replace_provider', dependencyId: editing.id, providerId });
          const changes: { status?: LinkStatus; relation?: Relation; notes?: string } = {};
          if (status !== editing.status) changes.status = status;
          if (relation !== editing.relation) changes.relation = relation;
          if (notes.trim() !== editing.notes) changes.notes = notes.trim();
          if (Object.keys(changes).length) ops.push({ type: 'modify_dependency', dependencyId: editing.id, changes });
          if (mode !== editing.mode) ops.push({ type: 'set_dependency_mode', dependencyId: editing.id, mode });
          if (!ops.length) return void onClose();
        }
        void submit(() => onSubmit(ops));
      }}
    >
      <SelectField label="Asset that relies on it" value={dependentId} error={errors.dependentId} disabled={!!editing} onChange={(e) => setDependentId(e.target.value)}>
        <option value="">Choose…</option>
        {sorted.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </SelectField>
      <SelectField label="Provider (relied on)" value={providerId} error={errors.providerId} onChange={(e) => setProviderId(e.target.value)}>
        <option value="">Choose…</option>
        {sorted.filter((a) => a.id !== dependentId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </SelectField>
      <SelectField label="Mode" value={mode} hint="Required: fails when the provider fails. Alternate: fails only when all its alternates fail. This changes simulation results." onChange={(e) => setMode(e.target.value as DependencyMode)}>
        <option value="required">Required</option>
        <option value="alternate">Alternate (backup)</option>
      </SelectField>
      <SelectField label="Relationship" value={relation} onChange={(e) => setRelation(e.target.value as Relation)}>
        {RELATIONS.map((r) => <option key={r} value={r}>{RELATION_LABEL[r]}</option>)}
      </SelectField>
      <SelectField label="How well is it known?" value={status} onChange={(e) => setStatus(e.target.value as LinkStatus)}>
        {LINK_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </SelectField>
      <TextAreaField label="Notes" value={notes} maxLength={300} rows={2} error={errors.notes} onChange={(e) => setNotes(e.target.value)} />
      {error && <Alert tone="error">{error}</Alert>}
      <div className="dialog-foot">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>{editing ? 'Save change' : 'Add dependency'}</Button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------- compare */

export function CompareDialog({ open, onClose, data }: { open: boolean; onClose: () => void; data: import('../../lib/graphGit').CommitComparison | null }) {
  const rel = { same: 'the same commit', ancestor: 'an ancestor of', descendant: 'a descendant of', diverged: 'on a diverging line from' } as const;
  return (
    <Dialog open={open} onClose={onClose} title="Compare commits">
      {data && (
        <div className="stack">
          <p>
            <span className="mono">{commitLabel(data.from)}</span> “{data.from.message}” is {rel[data.relation]} <span className="mono">{commitLabel(data.to)}</span> “{data.to.message}”.
          </p>
          <ul className="gg-compare-meta">
            {[data.from, data.to].map((c) => (
              <li key={c.id}>
                <Badge>{c.branchName ?? 'branch'}</Badge> <span className="mono">{commitLabel(c)}</span> · {new Date(c.createdAt).toLocaleString()} · {c.nodeCount} assets, {c.linkCount} dependencies{c.author ? ` · ${c.author}` : ''}
              </li>
            ))}
          </ul>
          <h3 className="panel-h">{data.sameContent ? 'Identical graphs' : `Changes from ${commitLabel(data.from)} to ${commitLabel(data.to)}`}</h3>
          {data.sameContent ? <p className="dim">The two commits hold exactly the same graph.</p> : <ul className="gg-change-list">{data.summary.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
          <div className="dialog-foot"><Button variant="primary" onClick={onClose}>Close</Button></div>
        </div>
      )}
    </Dialog>
  );
}

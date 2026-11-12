import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AssetDialog, AssumptionDialog, DependencyDialog, StatusBadge } from '../components/editors';
import { Alert, Badge, Button, ButtonLink, ConfirmDialog, CritBadge, Dialog, EmptyState, ErrorState, LoadingBlock, PageHeader, SelectField, TextAreaField, TextField } from '../components/ui';
import { buildIndex } from '../lib/graph';
import { assumptionTargetLabel, newScenario, removalImpact, removeAsset, removeAssumption, removeDependency, validateScenarioDetails } from '../lib/scenarioOps';
import {
  CONFIDENCE_LABEL,
  KIND_LABEL,
  LINK_STATUSES,
  RELATION_LABEL,
  SECTORS,
  STATUS_LABEL,
  type Asset,
  type Assumption,
  type Dependency,
  type LinkStatus,
  type Scenario,
} from '../lib/types';
import { describeError, useScenarios } from '../state/ScenarioContext';
import { useToast } from '../state/ToastContext';

/* ------------------------------------------------------ scenario dialogs */

function ScenarioDialog({
  open,
  onClose,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  editing?: Scenario;
}) {
  const { scenarios, addScenario, updateScenario } = useScenarios();
  const toast = useToast();
  const [name, setName] = useState(editing?.name ?? '');
  const [sector, setSector] = useState(editing?.sector ?? SECTORS[0]);
  const [description, setDescription] = useState(editing?.description ?? '');
  const [errors, setErrors] = useState<ReturnType<typeof validateScenarioDetails>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const validate = (v = { name, description }) => {
    const e = validateScenarioDetails(v, scenarios, editing?.id);
    setErrors(e);
    return e;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (Object.keys(validate()).length) return;
    setFailure(null);
    if (editing) {
      updateScenario(editing.id, (s) => ({ ...s, name: name.trim(), sector, description: description.trim() }));
      toast.success('Scenario details updated.');
      onClose();
      return;
    }
    setBusy(true);
    try {
      const created = await addScenario(newScenario({ name, sector, description }));
      toast.success(`Created “${created.name}”. Add some assets to get started.`);
      onClose();
    } catch (err) {
      setFailure(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={editing ? 'Edit scenario details' : 'New scenario'}>
      <form onSubmit={(e) => void submit(e)} noValidate className="stack">
        {failure && <Alert tone="error">{failure}</Alert>}
        <TextField
          label="Name"
          value={name}
          maxLength={90}
          autoFocus
          placeholder="e.g. Harbour district power and telecoms"
          error={errors.name}
          onChange={(e) => {
            setName(e.target.value);
            if (errors.name) validate({ name: e.target.value, description });
          }}
        />
        <SelectField label="Sector" value={sector} onChange={(e) => setSector(e.target.value)}>
          {SECTORS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </SelectField>
        <TextAreaField
          label="Description (optional)"
          value={description}
          hint={`${description.length}/300`}
          error={errors.description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="dialog-foot">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            {editing ? 'Save changes' : 'Create scenario'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* -------------------------------------------------------------- tab panes */

function OverviewPane({ s }: { s: Scenario }) {
  const count = (st: LinkStatus) => s.dependencies.filter((d) => d.status === st).length;
  return (
    <>
      {s.isSample && (
        <Alert>
          <strong>Simulated sample.</strong> Every asset, link and assumption here is invented for demonstration. It does not describe a real system.
        </Alert>
      )}
      <div className="overview-grid">
        <div className="card">
          <h3 className="card-title">Contents</h3>
          <ul className="status-count">
            <li>Assets <strong>{s.assets.length}</strong></li>
            <li>Dependencies <strong>{s.dependencies.length}</strong></li>
            <li>Saved runs <strong>{s.runs.length}</strong></li>
            <li>Mitigation strategies <strong>{s.strategies.length}</strong></li>
            <li>Assumptions <strong>{s.assumptions.length}</strong></li>
          </ul>
        </div>
        <div className="card">
          <h3 className="card-title">How well the links are known</h3>
          <ul className="status-count">
            {LINK_STATUSES.map((st) => (
              <li key={st}>
                <StatusBadge status={st} /> <strong>{count(st)}</strong>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="pane-head">
        <p className="dim">Updated {new Date(s.updatedAt).toLocaleString()}.</p>
        <ButtonLink variant="primary" to="/app/graph">
          Open dependency graph
        </ButtonLink>
      </div>
    </>
  );
}

function AssetsPane({ s }: { s: Scenario }) {
  const { updateScenario } = useScenarios();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [removing, setRemoving] = useState<Asset | null>(null);
  const idx = buildIndex(s.assets, s.dependencies);
  const impact = removing ? removalImpact(s, removing.id) : null;

  return (
    <>
      <div className="pane-head">
        <p className="dim">Assets are the things that can fail: facilities, networks, systems and services.</p>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add asset
        </Button>
      </div>

      {s.assets.length === 0 ? (
        <EmptyState title="No assets yet" actions={<Button variant="primary" onClick={() => setAdding(true)}>Add the first asset</Button>}>
          Start with the things the system cannot do without: power, connectivity, key facilities. You can map how they depend on each other next.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Assets in {s.name}</caption>
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col">Kind</th>
                <th scope="col">Criticality</th>
                <th scope="col" className="num">Relies on</th>
                <th scope="col" className="num">Relied on by</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {s.assets.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div className="cell-name">{a.name}</div>
                    {a.notes && <div className="cell-note">{a.notes}</div>}
                  </td>
                  <td>{KIND_LABEL[a.kind]}</td>
                  <td>
                    <CritBadge level={a.criticality} />
                  </td>
                  <td className="num">{idx.providers.get(a.id)?.length ?? 0}</td>
                  <td className="num">{idx.dependents.get(a.id)?.length ?? 0}</td>
                  <td className="actions">
                    <div className="row-actions">
                      <ButtonLink size="sm" variant="ghost" to={`/app/graph?focus=${encodeURIComponent(a.id)}`} aria-label={`Show ${a.name} in the graph`}>
                        Graph
                      </ButtonLink>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(a)} aria-label={`Edit ${a.name}`}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRemoving(a)} aria-label={`Delete ${a.name}`}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AssetDialog open={adding} onClose={() => setAdding(false)} scenario={s} />
      <AssetDialog open={!!editing} onClose={() => setEditing(null)} scenario={s} editing={editing ?? undefined} />
      <ConfirmDialog
        open={!!removing}
        danger
        title={`Delete “${removing?.name ?? ''}”?`}
        confirmLabel="Delete asset"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          updateScenario(s.id, (cur) => removeAsset(cur, removing.id));
          toast.success(`Deleted “${removing.name}”.`);
          setRemoving(null);
        }}
      >
        {impact && (
          <p>
            This also removes {impact.dependencies} mapped dependenc{impact.dependencies === 1 ? 'y' : 'ies'}
            {impact.strategies > 0 && `, ${impact.strategies} mitigation strateg${impact.strategies === 1 ? 'y' : 'ies'}`}
            {impact.assumptions > 0 && `, ${impact.assumptions} assumption${impact.assumptions === 1 ? '' : 's'}`}
            {impact.runs > 0 && `, and the asset from ${impact.runs} saved run${impact.runs === 1 ? '' : 's'}`}. This cannot be undone.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

function DependenciesPane({ s }: { s: Scenario }) {
  const { updateScenario } = useScenarios();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Dependency | null>(null);
  const [filter, setFilter] = useState<LinkStatus | 'all'>('all');
  const [q, setQ] = useState('');
  const name = (id: string) => s.assets.find((a) => a.id === id)?.name ?? 'Unknown';

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return s.dependencies.filter(
      (d) => (filter === 'all' || d.status === filter) && (!needle || `${name(d.dependentId)} ${name(d.providerId)} ${d.notes}`.toLowerCase().includes(needle)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.dependencies, s.assets, filter, q]);

  if (s.assets.length < 2)
    return (
      <EmptyState title="Add at least two assets first">
        A dependency links one asset to another, so the scenario needs two or more assets before you can map any.
      </EmptyState>
    );

  return (
    <>
      <div className="pane-head">
        <p className="dim">
          <strong>Required:</strong> the asset fails if this provider fails. <strong>Alternate:</strong> it keeps working until all of its alternates have failed.
        </p>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add dependency
        </Button>
      </div>
      <div className="toolbar">
        <TextField label="Search dependencies" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Asset name or note" />
        <SelectField label="Status" value={filter} onChange={(e) => setFilter(e.target.value as LinkStatus | 'all')}>
          <option value="all">All statuses</option>
          {LINK_STATUSES.map((st) => (
            <option key={st} value={st}>
              {STATUS_LABEL[st]}
            </option>
          ))}
        </SelectField>
      </div>

      {s.dependencies.length === 0 ? (
        <EmptyState title="No dependencies mapped yet" actions={<Button variant="primary" onClick={() => setAdding(true)}>Add a dependency</Button>}>
          Record what each asset relies on.
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState title="No dependencies match">Try a different search or status.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Dependencies in {s.name}</caption>
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col">Relies on</th>
                <th scope="col">Relationship</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>{name(d.dependentId)}</td>
                  <td>{name(d.providerId)}</td>
                  <td>{RELATION_LABEL[d.relation]}</td>
                  <td>{d.mode === 'required' ? <Badge tone="signal">Required</Badge> : <Badge>Alternate</Badge>}</td>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td className="actions">
                    <div className="row-actions">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(d)} aria-label={`Edit: ${name(d.dependentId)} relies on ${name(d.providerId)}`}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove: ${name(d.dependentId)} relies on ${name(d.providerId)}`}
                        onClick={() => {
                          updateScenario(s.id, (cur) => removeDependency(cur, d.id));
                          toast.success('Dependency removed.');
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DependencyDialog open={adding} onClose={() => setAdding(false)} scenario={s} />
      <DependencyDialog open={!!editing} onClose={() => setEditing(null)} scenario={s} editing={editing ?? undefined} />
    </>
  );
}

function AssumptionsPane({ s }: { s: Scenario }) {
  const { updateScenario } = useScenarios();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Assumption | null>(null);

  return (
    <>
      <div className="pane-head">
        <p className="dim">Record what you are taking as given, and how confident you are. Assumptions are included in reports.</p>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add assumption
        </Button>
      </div>
      {s.assumptions.length === 0 ? (
        <EmptyState title="No assumptions recorded">Note anything uncertain, such as a backup you have not tested or a link you inferred.</EmptyState>
      ) : (
        <ul className="assumption-list wide">
          {s.assumptions.map((a) => (
            <li key={a.id}>
              <p>{a.text}</p>
              <div className="row-actions">
                <Badge>{assumptionTargetLabel(s, a)}</Badge>
                <Badge>{CONFIDENCE_LABEL[a.confidence]} confidence</Badge>
                <Button size="sm" variant="ghost" onClick={() => setEditing(a)} aria-label="Edit assumption">
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Remove assumption"
                  onClick={() => {
                    updateScenario(s.id, (cur) => removeAssumption(cur, a.id));
                    toast.success('Assumption removed.');
                  }}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <AssumptionDialog open={adding} onClose={() => setAdding(false)} scenario={s} />
      <AssumptionDialog open={!!editing} onClose={() => setEditing(null)} scenario={s} editing={editing ?? undefined} />
    </>
  );
}

/* ------------------------------------------------------------ editor card */

type Tab = 'overview' | 'assets' | 'deps' | 'assumptions';

function Editor({ s }: { s: Scenario }) {
  const { duplicateScenario, deleteScenario } = useScenarios();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState<'dup' | 'del' | null>(null);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'assets', label: `Assets (${s.assets.length})` },
    { id: 'deps', label: `Dependencies (${s.dependencies.length})` },
    { id: 'assumptions', label: `Assumptions (${s.assumptions.length})` },
  ];
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.findIndex((t) => t.id === tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].id;
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  const duplicate = async () => {
    setBusy('dup');
    try {
      const copy = await duplicateScenario(s.id);
      toast.success(`Duplicated as “${copy.name}”.`);
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('del');
    try {
      await deleteScenario(s.id);
      toast.success(`Deleted “${s.name}”.`);
      setDeleting(false);
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="editor" aria-labelledby="editor-title">
      <div className="editor-head">
        <div>
          <h2 id="editor-title">{s.name}</h2>
          <div className="editor-meta">
            <Badge>{s.sector}</Badge>
            {s.isSample && <Badge tone="ghost">Simulated sample</Badge>}
          </div>
          {s.description && <p className="dim editor-desc">{s.description}</p>}
        </div>
        <div className="row-actions">
          <Button size="sm" onClick={() => setEditing(true)}>
            Edit details
          </Button>
          <Button size="sm" onClick={() => void duplicate()} loading={busy === 'dup'}>
            Duplicate
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDeleting(true)}>
            Delete
          </Button>
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label="Scenario data">
        {tabs.map((t) => (
          <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} className="tab" onClick={() => setTab(t.id)} onKeyDown={onTabKey}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'overview' && <OverviewPane s={s} />}
        {tab === 'assets' && <AssetsPane s={s} />}
        {tab === 'deps' && <DependenciesPane s={s} />}
        {tab === 'assumptions' && <AssumptionsPane s={s} />}
      </div>

      <ScenarioDialog key={`edit-${s.id}-${editing}`} open={editing} onClose={() => setEditing(false)} editing={s} />
      <ConfirmDialog open={deleting} danger busy={busy === 'del'} title={`Delete “${s.name}”?`} confirmLabel="Delete scenario" onCancel={() => setDeleting(false)} onConfirm={() => void remove()}>
        <p>
          This permanently deletes the scenario with its {s.assets.length} assets, {s.dependencies.length} dependencies, {s.runs.length} saved runs, {s.strategies.length} strategies and its saved reports.
          {s.isSample && ' You can bring simulated samples back with “Restore simulated samples”.'}
        </p>
      </ConfirmDialog>
    </section>
  );
}

/* ------------------------------------------------------------------- page */

type Kind = 'all' | 'sample' | 'mine';

export default function Workspace() {
  const { status, error, reload, scenarios, active, setActiveId, restoreSamples } = useScenarios();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [sort, setSort] = useState<'updated' | 'name'>('updated');

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = scenarios.filter(
      (s) => (kind === 'all' || (kind === 'sample' ? s.isSample : !s.isSample)) && (!needle || `${s.name} ${s.sector} ${s.description}`.toLowerCase().includes(needle)),
    );
    return list.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt)));
  }, [scenarios, q, kind, sort]);

  const restore = async () => {
    setRestoring(true);
    try {
      const n = (await restoreSamples()).length;
      toast.success(n ? `Restored ${n} simulated sample${n === 1 ? '' : 's'}.` : 'All simulated samples are already present.');
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setRestoring(false);
    }
  };

  const header = (
    <PageHeader
      title="Scenario workspace"
      description="Define the assets in a system and what each one relies on. Everything else in GhostGrid is calculated from this."
      actions={
        <>
          <Button onClick={() => void restore()} loading={restoring}>
            Restore simulated samples
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            New scenario
          </Button>
        </>
      }
    />
  );

  if (status === 'loading')
    return (
      <>
        {header}
        <LoadingBlock label="Loading your scenarios…" />
      </>
    );
  if (status === 'error')
    return (
      <>
        <PageHeader title="Scenario workspace" />
        <ErrorState title="Could not load scenarios" message={error ?? 'Unknown error.'} onRetry={() => void reload()} />
      </>
    );

  return (
    <>
      {header}
      {scenarios.length === 0 ? (
        <EmptyState
          title="No scenarios yet"
          actions={
            <>
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create a scenario
              </Button>
              <Button onClick={() => void restore()} loading={restoring}>
                Restore simulated samples
              </Button>
            </>
          }
        >
          A scenario is a set of assets and the dependencies between them. Start from scratch, or restore the invented sample scenarios to see the whole workflow.
        </EmptyState>
      ) : (
        <div className="workspace">
          <aside aria-label="Scenarios" className="scenario-list">
            <h2 className="section-title">Scenarios ({visible.length}/{scenarios.length})</h2>
            <div className="scenario-filters">
              <TextField label="Search scenarios" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or sector" />
              <div className="form-grid">
                <SelectField label="Show" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  <option value="all">All</option>
                  <option value="mine">Mine</option>
                  <option value="sample">Simulated samples</option>
                </SelectField>
                <SelectField label="Sort" value={sort} onChange={(e) => setSort(e.target.value as 'updated' | 'name')}>
                  <option value="updated">Recently updated</option>
                  <option value="name">Name</option>
                </SelectField>
              </div>
            </div>
            {visible.length === 0 ? (
              <p className="dim panel-note">No scenarios match.</p>
            ) : (
              <ul>
                {visible.map((s) => (
                  <li key={s.id}>
                    <button className="scenario-item" aria-current={active?.id === s.id ? 'true' : undefined} onClick={() => setActiveId(s.id)}>
                      <span className="scenario-name">{s.name}</span>
                      <span className="scenario-meta">
                        {s.assets.length} assets · {s.dependencies.length} dependencies
                        {s.isSample && ' · simulated sample'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
          {active && <Editor key={active.id} s={active} />}
        </div>
      )}
      <ScenarioDialog key={`new-${creating}`} open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

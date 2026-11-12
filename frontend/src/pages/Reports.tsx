import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ScenarioGate } from '../components/ScenarioGate';
import { Alert, Button, Checkbox, ConfirmDialog, EmptyState, PageHeader, SelectField } from '../components/ui';
import { api, type SavedReport } from '../lib/api';
import { buildReport, reportToMarkdown, type Block, type ReportOptions } from '../lib/report';
import { downloadFile, slug } from '../lib/storage';
import type { ReportSummary, Scenario } from '../lib/types';
import { describeError } from '../state/ScenarioContext';
import { useToast } from '../state/ToastContext';

function Render({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h':
            return b.level === 1 ? <h2 key={i} className="rep-h1">{b.text}</h2> : <h3 key={i} className="rep-h2">{b.text}</h3>;
          case 'p':
            return <p key={i}>{b.text}</p>;
          case 'ul':
            return (
              <ul key={i} className="rep-ul">
                {b.items.map((t, j) => <li key={j}>{t}</li>)}
              </ul>
            );
          case 'table':
            return (
              <div className="table-wrap" key={i}>
                <table className="table">
                  <thead>
                    <tr>{b.head.map((h) => <th key={h} scope="col">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>{r.map((c, k) => <Fragment key={k}>{k === 0 ? <th scope="row">{c}</th> : <td>{c}</td>}</Fragment>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </>
  );
}

function Inner({ s }: { s: Scenario }) {
  const toast = useToast();
  const [opts, setOpts] = useState<ReportOptions>({
    inventory: true,
    dependencies: true,
    assumptions: true,
    shared: true,
    runId: s.runs[0]?.id ?? null,
    mitigation: true,
  });
  const blocks = useMemo(() => buildReport(s, opts), [s, opts]);
  const set = (patch: Partial<ReportOptions>) => setOpts((o) => ({ ...o, ...patch }));
  const nothing = !opts.inventory && !opts.dependencies && !opts.assumptions && !opts.shared && !opts.runId && !opts.mitigation;

  const [saved, setSaved] = useState<ReportSummary[]>([]);
  const [savedErr, setSavedErr] = useState<string | null>(null);
  const [viewing, setViewing] = useState<SavedReport | null>(null);
  const [removing, setRemoving] = useState<ReportSummary | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSaved(await api.listReports(s.id));
      setSavedErr(null);
    } catch (err) {
      setSavedErr(describeError(err));
    }
  }, [s.id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const snapshot = async () => {
    setSaving(true);
    try {
      const r = await api.saveReport(s.id, { title: `${s.name} report, ${new Date().toLocaleString()}`, options: { ...opts }, content: blocks });
      toast.success('Snapshot saved.');
      setViewing(r);
      await refresh();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setSaving(false);
    }
  };
  const openSaved = async (r: ReportSummary) => {
    try {
      setViewing(await api.getReport(s.id, r.id));
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  const exportMd = () => {
    downloadFile(`${slug(s.name)}-report.md`, reportToMarkdown(blocks), 'text/markdown');
    toast.success('Markdown report downloaded.');
  };
  const exportJson = () => {
    downloadFile(`${slug(s.name)}-scenario.json`, JSON.stringify(s, null, 2), 'application/json');
    toast.success('Scenario JSON downloaded.');
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportToMarkdown(blocks));
      toast.success('Report copied to the clipboard.');
    } catch {
      toast.error('Could not access the clipboard. Use Download Markdown instead.');
    }
  };

  if (s.assets.length === 0)
    return (
      <>
        <PageHeader title="Reports" />
        <EmptyState title="Nothing to report yet">Add assets and dependencies to the scenario, then come back to export a report.</EmptyState>
      </>
    );

  return (
    <>
      <PageHeader
        title="Reports"
        description="Choose what to include, review the preview, then export."
        actions={
          <>
            <Button variant="primary" onClick={exportMd} disabled={nothing}>
              Download Markdown
            </Button>
            <Button onClick={() => void snapshot()} disabled={nothing} loading={saving}>
              Save snapshot
            </Button>
            <Button onClick={() => void copy()} disabled={nothing}>
              Copy Markdown
            </Button>
            <Button onClick={() => window.print()} disabled={nothing}>
              Print / save PDF
            </Button>
            <Button variant="ghost" onClick={exportJson}>
              Export scenario JSON
            </Button>
          </>
        }
      />
      <div className="report-layout">
        <aside className="card report-opts" aria-label="Report contents">
          <h2 className="card-title">Include</h2>
          <Checkbox checked={opts.inventory} onChange={(e) => set({ inventory: e.target.checked })} label="Asset inventory" />
          <Checkbox checked={opts.dependencies} onChange={(e) => set({ dependencies: e.target.checked })} label="Mapped dependencies" />
          <Checkbox checked={opts.assumptions} onChange={(e) => set({ assumptions: e.target.checked })} label="Assumptions" />
          <Checkbox checked={opts.shared} onChange={(e) => set({ shared: e.target.checked })} label="Hidden shared dependencies" />
          <SelectField
            label="Failure run"
            value={opts.runId ?? ''}
            onChange={(e) => set({ runId: e.target.value || null })}
            hint={s.runs.length ? undefined : 'Save a run in Simulation to include one.'}
          >
            <option value="">None</option>
            {s.runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </SelectField>
          <Checkbox checked={opts.mitigation} onChange={(e) => set({ mitigation: e.target.checked })} label="Mitigation comparison" />
          <h2 className="card-title saved-h">Saved snapshots</h2>
          {savedErr && <Alert tone="error">{savedErr}</Alert>}
          {saved.length === 0 && !savedErr ? (
            <p className="dim panel-note">None yet. A snapshot freezes the report as it reads now.</p>
          ) : (
            <ul className="saved-list">
              {saved.map((r) => (
                <li key={r.id}>
                  <span>{r.title}</span>
                  <span className="row-actions">
                    <Button size="sm" variant="ghost" onClick={() => void openSaved(r)}>Open</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(r)} aria-label={`Delete snapshot ${r.title}`}>Delete</Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <article className="report-preview card" aria-label="Report preview">
          {viewing && (
            <Alert>
              Viewing saved snapshot “{viewing.title}”.{' '}
              <button className="link-btn" onClick={() => downloadFile(`${slug(s.name)}-snapshot.md`, reportToMarkdown(viewing.content), 'text/markdown')}>Download it</button>{' '}
              <button className="link-btn" onClick={() => setViewing(null)}>Back to live preview</button>
            </Alert>
          )}
          {viewing ? <Render blocks={viewing.content} /> : nothing ? <EmptyState title="Nothing selected">Choose at least one section to include.</EmptyState> : <Render blocks={blocks} />}
        </article>
        <ConfirmDialog open={!!removing} danger title="Delete this snapshot?" confirmLabel="Delete snapshot" onCancel={() => setRemoving(null)} onConfirm={async () => {
          if (!removing) return;
          try {
            await api.removeReport(s.id, removing.id);
            if (viewing?.id === removing.id) setViewing(null);
            toast.success('Snapshot deleted.');
            await refresh();
          } catch (err) {
            toast.error(describeError(err));
          }
          setRemoving(null);
        }}>
          <p>{removing?.title}</p>
        </ConfirmDialog>
      </div>
    </>
  );
}

export default function Reports() {
  return (
    <ScenarioGate title="Reports" description="Export findings.">
      {(s) => <Inner key={s.id} s={s} />}
    </ScenarioGate>
  );
}

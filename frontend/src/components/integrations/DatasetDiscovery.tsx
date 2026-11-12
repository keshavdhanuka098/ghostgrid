import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Checkbox, LoadingBlock, SelectField, TextField } from '../ui';
import { formatBytes, integrationError, integrationsApi, type HfDetail, type HfItem, type ImportRow, type KaggleDetail, type KaggleItem, type LicenseAssessment, type LocalExperiment } from '../../lib/integrations';
import { useToast } from '../../state/ToastContext';
import { AiInsight } from './AiInsight';

type Mode = 'hf-datasets' | 'hf-models' | 'kaggle';
const ACTIVE = new Set(['downloading', 'extracting', 'validating']);

const LICENSE_WORDS: Record<LicenseAssessment['status'], string> = {
  permissive: 'Licence looks permissive',
  conditions: 'Licence has conditions',
  restricted: 'Licence is restricted',
  unknown: 'Licence unknown',
};
function LicenseBadge({ license, a }: { license: string | null; a: LicenseAssessment }) {
  return (
    <span title={a.summary}>
      <Badge tone={a.status === 'permissive' ? 'signal' : a.status === 'restricted' ? 'danger' : 'ghost'}>{LICENSE_WORDS[a.status]}{license ? `: ${license}` : ''}</Badge>
    </span>
  );
}

export function DatasetDiscovery({ importLimit, experiments }: { importLimit: number; experiments: LocalExperiment[] }) {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('hf-datasets');
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hfResults, setHfResults] = useState<HfItem[] | null>(null);
  const [kResults, setKResults] = useState<KaggleItem[] | null>(null);
  const [hfDetail, setHfDetail] = useState<HfDetail | null>(null);
  const [kDetail, setKDetail] = useState<KaggleDetail | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [ack, setAck] = useState(false);
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [expFor, setExpFor] = useState('');

  const loadImports = useCallback(async () => {
    try {
      setImports(await integrationsApi.imports());
    } catch {
      /* the list is refreshed again on the next tick */
    }
  }, []);
  useEffect(() => {
    void loadImports();
  }, [loadImports]);
  const anyActive = imports.some((i) => ACTIVE.has(i.status));
  useEffect(() => {
    if (!anyActive) return undefined;
    const t = setInterval(() => void loadImports(), 1500);
    return () => clearInterval(t);
  }, [anyActive, loadImports]);

  const resetDetail = () => {
    setHfDetail(null);
    setKDetail(null);
    setPicked([]);
    setConfirm(false);
    setAck(false);
  };
  const switchMode = (m: Mode) => {
    setMode(m);
    setHfResults(null);
    setKResults(null);
    setError(null);
    resetDetail();
  };

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!term.trim()) return;
    setBusy(true);
    setError(null);
    resetDetail();
    try {
      if (mode === 'kaggle') setKResults((await integrationsApi.kaggleSearch(term)).results);
      else setHfResults((await integrationsApi.hfSearch(mode === 'hf-datasets' ? 'datasets' : 'models', term)).results);
    } catch (err) {
      setError(integrationError(err));
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: string) => {
    setBusy(true);
    setError(null);
    resetDetail();
    try {
      if (mode === 'kaggle') setKDetail((await integrationsApi.kaggleDataset(id)).dataset);
      else if (mode === 'hf-datasets') setHfDetail((await integrationsApi.hfDataset(id)).dataset);
      else setHfDetail((await integrationsApi.hfModel(id)).model);
    } catch (err) {
      setError(integrationError(err));
    } finally {
      setBusy(false);
    }
  };

  const startImport = async () => {
    setBusy(true);
    setError(null);
    try {
      if (kDetail) await integrationsApi.kaggleImport({ ref: kDetail.ref, confirmDownload: confirm, acknowledgeLicense: ack });
      else if (hfDetail) await integrationsApi.hfImport({ id: hfDetail.id, files: picked, confirmDownload: confirm, acknowledgeLicense: ack });
      toast.success('Download started.');
      setConfirm(false);
      await loadImports();
    } catch (err) {
      setError(integrationError(err));
    } finally {
      setBusy(false);
    }
  };

  const linkModel = async () => {
    if (!hfDetail) return;
    setBusy(true);
    try {
      await integrationsApi.addModelReference({ repoId: hfDetail.id, experimentId: expFor || undefined });
      toast.success(expFor ? 'Model linked to the experiment.' : 'Model reference saved.');
    } catch (err) {
      setError(integrationError(err));
    } finally {
      setBusy(false);
    }
  };

  const license = hfDetail?.licenseAssessment ?? kDetail?.licenseAssessment ?? null;
  const needsAck = license !== null && license.status !== 'permissive';
  const sizeNow = kDetail ? kDetail.sizeBytes : hfDetail ? hfDetail.files.filter((f) => picked.includes(f.path)).reduce((n, f) => n + (f.sizeBytes ?? 0), 0) : 0;
  const overLimit = importLimit > 0 && (sizeNow ?? 0) > importLimit;
  const canImport = confirm && (!needsAck || ack) && !overLimit && !busy && (kDetail ? true : picked.length > 0);

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="disc-title">
        <h2 id="disc-title" className="card-title">Find datasets and models</h2>
        <div className="seg" role="tablist" aria-label="Source">
          {([['hf-datasets', 'Hugging Face datasets'], ['hf-models', 'Hugging Face models'], ['kaggle', 'Kaggle datasets']] as Array<[Mode, string]>).map(([m, l]) => (
            <Button key={m} size="sm" variant={mode === m ? 'primary' : 'secondary'} role="tab" aria-selected={mode === m} onClick={() => switchMode(m)}>{l}</Button>
          ))}
        </div>
        <form className="toolbar" onSubmit={(e) => void search(e)}>
          <TextField label="Search" value={term} maxLength={120} onChange={(e) => setTerm(e.target.value)} hint="Nothing is downloaded by searching." />
          <Button type="submit" variant="primary" loading={busy && !hfDetail && !kDetail} disabled={!term.trim()}>Search</Button>
        </form>
        {error && <Alert tone="error">{error}</Alert>}

        {busy && !hfResults && !kResults && <LoadingBlock label="Searching…" />}
        {hfResults && hfResults.length === 0 && <p className="dim">No results.</p>}
        {hfResults && hfResults.length > 0 && (
          <ul className="disc-list">
            {hfResults.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>{r.id}</strong> <LicenseBadge license={r.license} a={r.licenseAssessment} />
                  {r.gated && <> <Badge tone="ghost">Gated</Badge></>}{r.private && <> <Badge>Private</Badge></>}
                  <p className="dim">{[r.taskCategories.join(', '), r.sizeCategories.join(', '), r.downloads !== null ? `${r.downloads.toLocaleString()} downloads` : ''].filter(Boolean).join(' · ') || 'No summary available.'}</p>
                </div>
                <Button size="sm" onClick={() => void open(r.id)} disabled={busy}>Details</Button>
              </li>
            ))}
          </ul>
        )}
        {kResults && kResults.length === 0 && <p className="dim">No results.</p>}
        {kResults && kResults.length > 0 && (
          <ul className="disc-list">
            {kResults.map((r) => (
              <li key={r.ref}>
                <div>
                  <strong>{r.title}</strong> <span className="dim">{r.ref}</span> <LicenseBadge license={r.license} a={r.licenseAssessment} />
                  <p className="dim">{[r.subtitle, formatBytes(r.sizeBytes), r.downloads !== null ? `${r.downloads.toLocaleString()} downloads` : ''].filter(Boolean).join(' · ')}</p>
                </div>
                <Button size="sm" onClick={() => void open(r.ref)} disabled={busy}>Details</Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {hfDetail && (
        <section className="card stack" aria-label={`Details for ${hfDetail.id}`}>
          <h3 className="card-title">{hfDetail.id}</h3>
          <p>{hfDetail.description ?? 'No description provided.'}</p>
          <p><LicenseBadge license={hfDetail.license} a={hfDetail.licenseAssessment} /> <span className="dim">{hfDetail.licenseAssessment.summary}</span></p>
          <p className="dim">{[hfDetail.sizeBytes !== null ? `Repository ${formatBytes(hfDetail.sizeBytes)}` : '', hfDetail.revision ? `revision ${hfDetail.revision.slice(0, 8)}` : '', hfDetail.tags.slice(0, 8).join(', ')].filter(Boolean).join(' · ')}</p>
          {hfDetail.gated && <Alert tone="warn">Gated repository: requires <code>HF_TOKEN</code> and accepted terms on huggingface.co.</Alert>}
          {hfDetail.private && <Alert tone="info">Private repository visible to your token.</Alert>}
          {mode === 'hf-datasets' ? (
            <>
              {hfDetail.importNotes.map((n) => <p key={n} className="dim">{n}</p>)}
              <fieldset className="stack">
                <legend className="field-label">Files to import (JSON, JSONL, CSV or one ZIP)</legend>
                {hfDetail.files.filter((f) => f.importable).map((f) => (
                  <Checkbox key={f.path} label={<>{f.path} <span className="dim">{formatBytes(f.sizeBytes)}</span></>} checked={picked.includes(f.path)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, f.path] : p.filter((x) => x !== f.path)))} />
                ))}
              </fieldset>
            </>
          ) : (
            <div className="stack">
              <SelectField label="Associate with a local experiment (optional)" value={expFor} onChange={(e) => setExpFor(e.target.value)} hint="Saves a reference only. No model files are downloaded.">
                <option value="">Not linked to an experiment</option>
                {experiments.map((x) => <option key={x.experimentId} value={x.experimentId}>{x.modelName ?? 'model'} · {x.experimentId}</option>)}
              </SelectField>
              <div className="row-actions"><Button variant="primary" onClick={() => void linkModel()} loading={busy}>Save model reference</Button></div>
            </div>
          )}
          {mode === 'hf-datasets' && <ImportControls size={sizeNow} limit={importLimit} overLimit={overLimit} needsAck={needsAck} confirm={confirm} setConfirm={setConfirm} ack={ack} setAck={setAck} canImport={canImport} busy={busy} onImport={() => void startImport()} />}
        </section>
      )}

      {kDetail && (
        <section className="card stack" aria-label={`Details for ${kDetail.ref}`}>
          <h3 className="card-title">{kDetail.title}</h3>
          <p>{kDetail.description ?? kDetail.subtitle ?? 'No description provided.'}</p>
          <p><LicenseBadge license={kDetail.license} a={kDetail.licenseAssessment} /> <span className="dim">{kDetail.licenseAssessment.summary}</span></p>
          <p className="dim">Download size {formatBytes(kDetail.sizeBytes)} · {kDetail.files.length} file(s) listed</p>
          {kDetail.downloadNotes.map((n) => <p key={n} className="dim">{n}</p>)}
          <ImportControls size={sizeNow} limit={importLimit} overLimit={overLimit} needsAck={needsAck} confirm={confirm} setConfirm={setConfirm} ack={ack} setAck={setAck} canImport={canImport} busy={busy} onImport={() => void startImport()} />
        </section>
      )}

      <ImportList imports={imports} reload={loadImports} />
    </div>
  );
}

function ImportControls({ size, limit, overLimit, needsAck, confirm, setConfirm, ack, setAck, canImport, busy, onImport }: { size: number | null; limit: number; overLimit: boolean; needsAck: boolean; confirm: boolean; setConfirm: (v: boolean) => void; ack: boolean; setAck: (v: boolean) => void; canImport: boolean; busy: boolean; onImport: () => void }) {
  return (
    <div className="stack import-controls">
      {overLimit && <Alert tone="error">This is {formatBytes(size)}; GhostGrid imports at most {formatBytes(limit)} (set GHOSTGRID_IMPORT_MAX_MB to change it).</Alert>}
      {needsAck && <Checkbox label="I have reviewed this dataset’s licence and may use it for this purpose." checked={ack} onChange={(e) => setAck(e.target.checked)} />}
      <Checkbox label={`Download ${formatBytes(size)} to this computer now.`} checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
      <div className="row-actions"><Button variant="primary" disabled={!canImport} loading={busy} onClick={onImport}>Download and import</Button></div>
      <p className="dim">Imported files are stored under <code>backend/datasets/external/</code> and are never overwritten. They must be in GhostGrid’s record format before they can be registered for training.</p>
    </div>
  );
}

function ImportList({ imports, reload }: { imports: ImportRow[]; reload: () => Promise<void> }) {
  const toast = useToast();
  const [reg, setReg] = useState<{ id: string; file: string; name: string; version: string; ack: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!imports.length) return null;

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      setError(null);
      await fn();
      if (ok) toast.success(ok);
      await reload();
    } catch (err) {
      setError(integrationError(err));
    }
  };

  return (
    <section className="card stack" aria-labelledby="imp-title">
      <h2 id="imp-title" className="card-title">Imported datasets</h2>
      {error && <Alert tone="error">{error}</Alert>}
      <ul className="disc-list">
        {imports.map((i) => {
          const good = i.validation?.checked.filter((c) => c.ok) ?? [];
          return (
            <li key={i.id} className="import-row">
              <div>
                <strong>{i.sourceId}</strong> <span className="dim">{i.source === 'kaggle' ? 'Kaggle' : 'Hugging Face'} · {i.revision ? i.revision.slice(0, 12) : 'latest'}</span> <Badge tone={i.status === 'failed' ? 'danger' : i.status === 'registered' || i.status === 'downloaded' ? 'signal' : 'ghost'}>{i.status}</Badge>
                {ACTIVE.has(i.status) && <progress value={i.downloadedBytes} max={i.totalBytes ?? undefined} aria-label="Download progress">{formatBytes(i.downloadedBytes)}</progress>}
                {ACTIVE.has(i.status) && <p className="dim">{formatBytes(i.downloadedBytes)}{i.totalBytes ? ` of about ${formatBytes(i.totalBytes)}` : ''}</p>}
                {i.error && <p className="import-error">{i.error}</p>}
                {i.status === 'downloaded' && (
                  <p className="dim">
                    {i.files.length} file(s), stored in <code>{i.localPath}</code>.{' '}
                    {good.length ? `${good.length} file(s) match GhostGrid’s record format.` : 'No file matches GhostGrid’s record format yet, so none can be registered for training. Convert one first.'}
                  </p>
                )}
                {i.status === 'registered' && <p className="dim">Registered as {i.manifestName} {i.manifestVersion}.</p>}
                <p className="dim">Source: <a href={i.sourceUrl} target="_blank" rel="noreferrer noopener">{i.sourceUrl}</a> · licence {i.license ?? 'unknown'}</p>
              </div>
              <div className="row-actions">
                {ACTIVE.has(i.status) && <Button size="sm" variant="ghost" onClick={() => void act(() => integrationsApi.cancelImport(i.id))}>Cancel</Button>}
                {i.status === 'downloaded' && good.length > 0 && <Button size="sm" onClick={() => setReg({ id: i.id, file: good[0].file, name: i.sourceId.split('/').pop() ?? 'dataset', version: '1.0.0', ack: false })}>Register…</Button>}
                {(i.status === 'failed' || i.status === 'cancelled') && <Button size="sm" variant="ghost" onClick={() => void act(() => integrationsApi.removeImport(i.id))}>Remove</Button>}
              </div>
              {reg?.id === i.id && (
                <form className="stack reg-form" onSubmit={(e) => { e.preventDefault(); void act(async () => { await integrationsApi.registerImport(i.id, { file: reg.file, name: reg.name, version: reg.version, acknowledgeLicense: reg.ack }); setReg(null); }, 'Dataset registered.'); }}>
                  <SelectField label="File" value={reg.file} onChange={(e) => setReg({ ...reg, file: e.target.value })}>{good.map((g) => <option key={g.file} value={g.file}>{g.file} ({g.records} records)</option>)}</SelectField>
                  <TextField label="Name" value={reg.name} maxLength={80} onChange={(e) => setReg({ ...reg, name: e.target.value })} />
                  <TextField label="Version" value={reg.version} maxLength={32} onChange={(e) => setReg({ ...reg, version: e.target.value })} />
                  {i.licenseStatus !== 'permissive' && <Checkbox label="I have reviewed the licence." checked={reg.ack} onChange={(e) => setReg({ ...reg, ack: e.target.checked })} />}
                  <div className="row-actions"><Button type="submit" variant="primary" disabled={i.licenseStatus !== 'permissive' && !reg.ack}>Add to dataset manifest</Button><Button variant="ghost" onClick={() => setReg(null)}>Close</Button></div>
                </form>
              )}
              {(i.status === 'downloaded' || i.status === 'registered') && i.files.length > 0 && (
                <div className="import-ai">
                  <AiInsight task="dataset_quality" params={{ importId: i.id }} label="Explain dataset quality with AI" resetKey={i.id} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

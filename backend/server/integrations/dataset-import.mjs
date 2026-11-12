import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { IntegrationError, USER_MESSAGES } from './errors.mjs';
import { classifyStatus } from './http.mjs';
import { backendRoot as defaultRoot, parseJsonOutput, runPython } from './python.mjs';

const MB = 1024 * 1024;
const DATA_FILE = /\.(jsonl|ndjson|json|csv)$/i;
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const VERSION_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const nowIso = () => new Date().toISOString();

/** Flattens a repository path into one safe file name; never returns something that could escape its folder. */
export function safeFileName(p) {
  const name = String(p).split('/').filter(Boolean).map((s) => s.replace(/[^A-Za-z0-9._-]+/g, '_')).join('__').replace(/^\.+/, '');
  if (!name || name.length > 180) throw new IntegrationError('bad_request', 'A file name is empty or too long to import safely.');
  return name;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'dataset';

const toRow = (r) => r && ({
  id: r.id, source: r.source, sourceId: r.source_id, revision: r.revision, sourceUrl: r.source_url,
  license: r.license, licenseStatus: r.license_status, status: r.status, totalBytes: r.total_bytes, downloadedBytes: r.downloaded_bytes,
  localPath: r.local_path, files: JSON.parse(r.files || '[]'), sha256: r.sha256, validation: r.validation ? JSON.parse(r.validation) : null,
  manifestName: r.manifest_name, manifestVersion: r.manifest_version, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * Downloads, unpacks, validates and registers third-party datasets. Nothing here starts on its own: every import is the
 * result of an explicit user request, runs once per source item and revision, and never overwrites an existing folder.
 */
export function createImportManager({ db, backendRoot = defaultRoot, fetchImpl = globalThis.fetch, python, log = (m) => console.warn(m), limits = {}, runPythonImpl = runPython }) {
  const maxBytes = limits.maxBytes ?? (Number(process.env.GHOSTGRID_IMPORT_MAX_MB) || 250) * MB;
  const stallMs = limits.stallMs ?? 60000;
  const root = path.join(backendRoot, 'datasets', 'external');
  const active = new Map(); // id -> AbortController
  const tasks = new Map(); // id -> promise (lets tests await completion)

  const get = (id) => toRow(db.prepare('SELECT * FROM external_datasets WHERE id = ?').get(id));
  const list = () => db.prepare('SELECT * FROM external_datasets ORDER BY created_at DESC').all().map(toRow);
  const update = (id, patch) => {
    const cols = Object.keys(patch);
    db.prepare(`UPDATE external_datasets SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => (typeof patch[c] === 'object' && patch[c] !== null ? JSON.stringify(patch[c]) : patch[c])), nowIso(), id);
  };

  function recoverInterrupted() {
    const n = db.prepare("UPDATE external_datasets SET status = 'failed', error = 'Interrupted by a server restart. Remove it and import again.', updated_at = ? WHERE status IN ('downloading', 'extracting', 'validating')").run(nowIso());
    return n.changes;
  }

  /** Streams one HTTPS download to a NEW file ('wx'), enforcing the size cap, a stall timeout and a host allow-list. */
  async function downloadTo({ request, dest, remaining, signal, onBytes }) {
    const u = new URL(request.url);
    if (u.protocol !== 'https:' || !request.allowedHosts.includes(u.hostname)) throw new IntegrationError('bad_request', 'Download URL is not on an allowed host.');
    const stall = new AbortController();
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), stallMs);
    };
    const merged = AbortSignal.any([signal, stall.signal]);
    arm();
    let res;
    try {
      res = await fetchImpl(request.url, { headers: request.headers, signal: merged, redirect: 'follow' });
    } catch (err) {
      clearTimeout(timer);
      if (signal.aborted) throw new IntegrationError('conflict', 'The download was cancelled.');
      throw new IntegrationError(stall.signal.aborted ? 'timeout' : 'unavailable', USER_MESSAGES[stall.signal.aborted ? 'timeout' : 'unavailable']('The dataset host'), { cause: err });
    }
    try {
      if (res.url && new URL(res.url).protocol !== 'https:') throw new IntegrationError('bad_response', 'The download was redirected to an insecure address.');
      if (!res.ok) {
        const code = classifyStatus(res.status);
        throw new IntegrationError(code, code === 'forbidden' || code === 'invalid_credentials' ? 'The host refused the download. For gated or restricted datasets, accept the terms on the provider’s website with the account whose credentials GhostGrid uses.' : (USER_MESSAGES[code] ?? USER_MESSAGES.bad_request)('The dataset host'), { status: res.status });
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > remaining) throw new IntegrationError('too_large', `The file is ${(declared / MB).toFixed(1)} MB, which exceeds the remaining import limit of ${(remaining / MB).toFixed(1)} MB.`);
      if (!res.body) throw new IntegrationError('bad_response', 'The host sent an empty response.');
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      const fh = await fs.open(dest, 'wx');
      try {
        for await (const chunk of Readable.fromWeb(res.body)) {
          arm();
          bytes += chunk.length;
          if (bytes > remaining) throw new IntegrationError('too_large', 'The download exceeded the import size limit and was stopped.');
          hash.update(chunk);
          await fh.write(chunk);
          onBytes(chunk.length);
        }
      } catch (err) {
        if (signal.aborted) throw new IntegrationError('conflict', 'The download was cancelled.');
        if (stall.signal.aborted) throw new IntegrationError('timeout', 'The download stalled and was stopped.');
        throw err instanceof IntegrationError ? err : new IntegrationError('unavailable', 'The download was interrupted.', { cause: err });
      } finally {
        await fh.close();
      }
      return { bytes, sha256: hash.digest('hex') };
    } finally {
      clearTimeout(timer);
    }
  }

  async function sha256File(file) {
    const h = crypto.createHash('sha256');
    for await (const c of fsSync.createReadStream(file)) h.update(c);
    return h.digest('hex');
  }

  async function validateFiles(dir, files) {
    const results = [];
    for (const f of files.filter((x) => DATA_FILE.test(x.name))) {
      const r = await runPythonImpl('validate_dataset.py', [path.join(dir, f.name)], { python, timeoutMs: 120000 }).catch((err) => ({ code: 9, stdout: '', stderr: err.message }));
      const out = parseJsonOutput(r.stdout);
      results.push({ file: f.name, ok: r.code === 0 && out?.valid === true, records: out?.records ?? null, errors: (out?.errors ?? [String(r.stdout || r.stderr).slice(0, 200)]).slice(0, 5) });
    }
    return { ok: results.length > 0 && results.every((r) => r.ok), checked: results, note: results.length ? undefined : 'No JSON, JSONL or CSV file to validate.' };
  }

  async function run(id, plan, dir, controller) {
    const filesDir = path.join(dir, 'files');
    try {
      let total = 0;
      let lastWrite = 0;
      const onBytes = (n) => {
        total += n;
        if (Date.now() - lastWrite > 400) {
          lastWrite = Date.now();
          update(id, { downloaded_bytes: total });
        }
      };
      const written = [];
      const hasZip = plan.downloads.some((d) => d.kind === 'zip');
      if (!hasZip) await fs.mkdir(filesDir);
      for (const d of plan.downloads) {
        const dest = d.kind === 'zip' ? path.join(dir, '.download.zip') : path.join(filesDir, d.name);
        const r = await downloadTo({ request: d.request, dest, remaining: maxBytes - total, signal: controller.signal, onBytes });
        if (d.kind === 'zip') {
          update(id, { status: 'extracting', downloaded_bytes: total, sha256: r.sha256 });
          const ex = await runPythonImpl('safe_extract.py', [dest, filesDir, '--max-total-bytes', String(Math.max(maxBytes * 4, 64 * MB))], { python, timeoutMs: 120000 });
          const out = parseJsonOutput(ex.stdout);
          if (ex.code !== 0 || !out?.files) throw new IntegrationError('unsupported', `The archive was rejected: ${String(out?.error ?? 'unreadable archive').slice(0, 200)}`);
          await fs.rm(dest, { force: true });
          for (const f of out.files) written.push({ name: f.name, bytes: f.bytes, sha256: await sha256File(path.join(filesDir, f.name)), origin: f.source });
        } else {
          written.push({ name: d.name, bytes: r.bytes, sha256: r.sha256, origin: d.origin ?? d.name });
        }
      }
      update(id, { status: 'validating', downloaded_bytes: total, files: written });
      const validation = await validateFiles(filesDir, written);
      const row = get(id);
      await fs.writeFile(path.join(dir, 'provenance.json'), JSON.stringify({ source: row.source, sourceId: row.sourceId, revision: row.revision, sourceUrl: row.sourceUrl, license: row.license, licenseStatus: row.licenseStatus, importedAt: nowIso(), files: written, ghostgridValidation: validation }, null, 2), { flag: 'wx' });
      update(id, { status: 'downloaded', downloaded_bytes: total, validation, error: null });
    } catch (err) {
      const cancelled = controller.signal.aborted;
      const message = err instanceof IntegrationError ? err.message : 'The import failed unexpectedly.';
      if (!(err instanceof IntegrationError)) log(`[import] ${id} failed: ${err?.name}`);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); // dir was created by this very import, so removing it cannot touch other data
      update(id, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? 'Cancelled.' : message, files: [] });
    } finally {
      active.delete(id);
    }
  }

  /**
   * @param plan { source, sourceId, revision, sourceUrl, license, licenseStatus, expectedBytes, downloads: [{ name, kind, request, origin }] }
   */
  async function start(plan) {
    if (plan.expectedBytes && plan.expectedBytes > maxBytes) throw new IntegrationError('too_large', `This dataset is ${(plan.expectedBytes / MB).toFixed(1)} MB; GhostGrid imports at most ${(maxBytes / MB).toFixed(0)} MB (GHOSTGRID_IMPORT_MAX_MB).`);
    const dirName = `${slug(plan.sourceId)}-${slug(plan.revision || 'latest').slice(0, 12)}`;
    const dir = path.join(root, plan.source, dirName);
    const rel = path.relative(backendRoot, dir).split(path.sep).join('/');
    const existing = db.prepare('SELECT * FROM external_datasets WHERE source = ? AND source_id = ? AND revision = ?').get(plan.source, plan.sourceId, plan.revision ?? '');
    if (existing && !['failed', 'cancelled'].includes(existing.status)) throw new IntegrationError('conflict', 'This dataset revision has already been imported (or is importing). GhostGrid will not overwrite it.');
    if (existing) db.prepare('DELETE FROM external_datasets WHERE id = ?').run(existing.id); // a failed attempt may be retried; its folder was already cleaned
    await fs.mkdir(path.dirname(dir), { recursive: true });
    try {
      await fs.mkdir(dir); // non-recursive: fails if anything is already there
    } catch (err) {
      if (err.code === 'EEXIST') throw new IntegrationError('conflict', 'A folder for this dataset already exists on disk. GhostGrid will not overwrite it.');
      throw err;
    }
    const id = `imp-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    try {
      db.prepare(`INSERT INTO external_datasets (id, source, source_id, revision, source_url, license, license_status, status, total_bytes, downloaded_bytes, local_path, files, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'downloading', ?, 0, ?, '[]', ?, ?)`).run(id, plan.source, plan.sourceId, plan.revision ?? '', plan.sourceUrl, plan.license ?? null, plan.licenseStatus ?? 'unknown', plan.expectedBytes ?? null, `${rel}/files`, nowIso(), nowIso());
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true });
      throw err;
    }
    const controller = new AbortController();
    active.set(id, controller);
    tasks.set(id, run(id, plan, dir, controller).finally(() => tasks.delete(id)));
    return get(id);
  }

  function cancel(id) {
    const c = active.get(id);
    if (!c) throw new IntegrationError('conflict', 'That import is not running.');
    c.abort();
  }

  async function remove(id) {
    const row = get(id);
    if (!row) throw new IntegrationError('not_found', 'Import not found.', { provider: 'GhostGrid' });
    if (!['failed', 'cancelled'].includes(row.status)) throw new IntegrationError('conflict', 'Only failed or cancelled imports can be removed. Downloaded data is never deleted automatically.');
    db.prepare('DELETE FROM external_datasets WHERE id = ?').run(id);
  }

  /** Adds a validated import to GhostGrid's dataset manifest through the existing register_dataset.py script. */
  async function register(id, { file, name, version, description, acknowledgeLicense }) {
    const row = get(id);
    if (!row) throw new IntegrationError('not_found', 'Import not found.', { provider: 'GhostGrid' });
    if (row.status !== 'downloaded') throw new IntegrationError('conflict', row.status === 'registered' ? 'Already registered.' : 'Only a finished, validated import can be registered.');
    if (!NAME_OK.test(name ?? '') || !VERSION_OK.test(version ?? '')) throw new IntegrationError('bad_request', 'Give the dataset a name (letters, digits, spaces, . _ -) and a version such as 1.0.0.');
    const target = row.files.find((f) => f.name === file);
    const check = row.validation?.checked?.find((c) => c.file === file);
    if (!target || !check?.ok) throw new IntegrationError('unsupported', 'That file did not pass GhostGrid validation (records need record_id, features and target), so it cannot be registered. Convert it first.');
    if (row.licenseStatus !== 'permissive' && acknowledgeLicense !== true) throw new IntegrationError('forbidden', 'The licence is not clearly permissive. Review it and confirm to continue.');
    const relFile = `${row.localPath}/${target.name}`;
    const source = `${row.source}:${row.sourceId}@${row.revision || 'latest'} ${row.sourceUrl}`;
    const r = await runPythonImpl('register_dataset.py', [relFile, '--name', name, '--version', version, '--description', String(description || `Imported from ${row.source}`).slice(0, 300), '--source', source, '--license', row.license || 'Unknown'], { python, timeoutMs: 120000 });
    if (r.code !== 0) {
      const text = String(r.stderr || r.stdout);
      throw new IntegrationError(/Refusing to overwrite/.test(text) ? 'conflict' : 'unsupported', /Refusing to overwrite/.test(text) ? 'A dataset with that name and version is already registered.' : `Registration failed: ${text.replace(/\s+/g, ' ').slice(0, 240)}`);
    }
    update(id, { status: 'registered', manifest_name: name, manifest_version: version });
    return get(id);
  }

  return { start, get, list, cancel, remove, register, recoverInterrupted, whenDone: (id) => tasks.get(id) ?? Promise.resolve(), limits: { maxBytes } };
}

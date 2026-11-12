import crypto from 'node:crypto';
import { tx } from './db.mjs';
import { HttpError } from './errors.mjs';
import { ensureMainBranch } from './graphgit/repo.mjs';
import { LIMITS } from './validate.mjs';

const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const plain = (row) => ({ ...row });

/* ------------------------------------------------------------- reading */

function assemble(db, s) {
  const q = (sql) => db.prepare(sql).all(s.id).map(plain);
  const failed = new Map();
  for (const r of q('SELECT run_id, node_id FROM run_failed_nodes WHERE scenario_id = ? ORDER BY rowid')) {
    (failed.get(r.run_id) ?? failed.set(r.run_id, []).get(r.run_id)).push(r.node_id);
  }
  const failedLinks = new Map();
  for (const r of q('SELECT run_id, link_id FROM run_failed_links WHERE scenario_id = ? ORDER BY rowid')) {
    (failedLinks.get(r.run_id) ?? failedLinks.set(r.run_id, []).get(r.run_id)).push(r.link_id);
  }
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    sector: s.sector,
    sampleKey: s.sample_key ?? null,
    isSample: s.sample_key !== null && s.sample_key !== undefined,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    assets: q('SELECT id, name, kind, criticality, notes, x, y FROM nodes WHERE scenario_id = ? ORDER BY sort_order'),
    dependencies: q(
      'SELECT id, dependent_id AS dependentId, provider_id AS providerId, mode, status, relation, notes FROM links WHERE scenario_id = ? ORDER BY sort_order',
    ),
    runs: q('SELECT id, name, created_at AS createdAt FROM simulation_runs WHERE scenario_id = ? ORDER BY sort_order').map((r) => ({
      ...r,
      failedIds: failed.get(r.id) ?? [],
      failedLinkIds: failedLinks.get(r.id) ?? [],
    })),
    strategies: q(
      "SELECT id, name, kind, dependent_id AS dependentId, provider_id AS providerId, COALESCE(backup_id, '') AS backupId, notes, cost_level AS costLevel, effort_level AS effortLevel FROM mitigations WHERE scenario_id = ? ORDER BY sort_order",
    ),
    assumptions: q(
      'SELECT id, text, target_type AS targetType, target_id AS targetId, confidence, created_at AS createdAt FROM assumptions WHERE scenario_id = ? ORDER BY sort_order',
    ),
  };
}

export function listScenarios(db) {
  return db.prepare('SELECT * FROM scenarios ORDER BY created_at, rowid').all().map((s) => assemble(db, s));
}

export function readScenario(db, id) {
  const s = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id);
  return s ? assemble(db, s) : null;
}

export function countScenarios(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM scenarios').get().n;
}

/* ------------------------------------------------------------- writing */

function nameTaken(db, name, exceptId) {
  return !!db.prepare('SELECT 1 FROM scenarios WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, exceptId ?? '');
}

function writeContent(db, id, doc) {
  const node = db.prepare('INSERT INTO nodes (scenario_id, id, name, kind, criticality, notes, x, y, sort_order) VALUES (?,?,?,?,?,?,?,?,?)');
  doc.assets.forEach((a, i) => node.run(id, a.id, a.name, a.kind, a.criticality, a.notes ?? '', a.x ?? null, a.y ?? null, i));

  const link = db.prepare('INSERT INTO links (scenario_id, id, dependent_id, provider_id, mode, status, relation, notes, sort_order) VALUES (?,?,?,?,?,?,?,?,?)');
  doc.dependencies.forEach((d, i) => link.run(id, d.id, d.dependentId, d.providerId, d.mode, d.status, d.relation, d.notes ?? '', i));

  const run = db.prepare('INSERT INTO simulation_runs (scenario_id, id, name, created_at, sort_order) VALUES (?,?,?,?,?)');
  const failed = db.prepare('INSERT INTO run_failed_nodes (scenario_id, run_id, node_id) VALUES (?,?,?)');
  const failedLink = db.prepare('INSERT INTO run_failed_links (scenario_id, run_id, link_id) VALUES (?,?,?)');
  doc.runs.forEach((r, i) => {
    run.run(id, r.id, r.name, r.createdAt, i);
    r.failedIds.forEach((n) => failed.run(id, r.id, n));
    (r.failedLinkIds ?? []).forEach((l) => failedLink.run(id, r.id, l));
  });

  const mit = db.prepare(
    'INSERT INTO mitigations (scenario_id, id, name, kind, dependent_id, provider_id, backup_id, notes, cost_level, effort_level, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  doc.strategies.forEach((m, i) =>
    mit.run(id, m.id, m.name, m.kind ?? 'backup', m.dependentId, m.providerId, m.kind === 'decouple' ? null : m.backupId, m.notes ?? '', m.costLevel ?? null, m.effortLevel ?? null, i),
  );

  const asm = db.prepare('INSERT INTO assumptions (scenario_id, id, text, target_type, target_id, confidence, created_at, sort_order) VALUES (?,?,?,?,?,?,?,?)');
  doc.assumptions.forEach((a, i) => asm.run(id, a.id, a.text, a.targetType, a.targetId ?? null, a.confidence, a.createdAt, i));
}

function clearContent(db, id) {
  // Deleting nodes cascades to links, mitigations and run_failed_nodes.
  for (const table of ['nodes', 'assumptions', 'simulation_runs']) db.prepare(`DELETE FROM ${table} WHERE scenario_id = ?`).run(id);
}

/** Inserts a validated scenario. `keepTimestamps` is for imports and bundled samples. */
export function createScenario(db, doc, { sampleKey = null, keepTimestamps = false } = {}) {
  return tx(db, () => {
    if (db.prepare('SELECT 1 FROM scenarios WHERE id = ?').get(doc.id)) throw new HttpError(409, 'A scenario with this id already exists.');
    if (nameTaken(db, doc.name)) throw new HttpError(409, 'Another scenario already uses this name.');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO scenarios (id, name, description, sector, sample_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(
      doc.id,
      doc.name,
      doc.description,
      doc.sector,
      sampleKey,
      keepTimestamps ? doc.createdAt : now,
      keepTimestamps ? doc.updatedAt : now,
    );
    writeContent(db, doc.id, doc);
    ensureMainBranch(db, doc.id); // every scenario starts with a "main" branch
    return readScenario(db, doc.id);
  });
}

/** Replaces a scenario's whole content atomically. The sample key and creation time are never changed by clients. */
export function replaceScenario(db, id, doc) {
  return tx(db, () => {
    if (!db.prepare('SELECT 1 FROM scenarios WHERE id = ?').get(id)) throw new HttpError(404, 'Scenario not found.');
    if (nameTaken(db, doc.name, id)) throw new HttpError(409, 'Another scenario already uses this name.');
    db.prepare('UPDATE scenarios SET name = ?, description = ?, sector = ?, updated_at = ? WHERE id = ?').run(
      doc.name,
      doc.description,
      doc.sector,
      new Date().toISOString(),
      id,
    );
    clearContent(db, id);
    writeContent(db, id, doc);
    return readScenario(db, id);
  });
}

export function deleteScenario(db, id) {
  const res = db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
  if (res.changes === 0) throw new HttpError(404, 'Scenario not found.');
}

export function deleteAllScenarios(db) {
  db.prepare('DELETE FROM scenarios').run();
}

export function duplicateScenario(db, id, requestedName) {
  return tx(db, () => {
    const source = readScenario(db, id);
    if (!source) throw new HttpError(404, 'Scenario not found.');
    let name = (requestedName ?? '').trim();
    if (requestedName !== undefined && !name) throw new HttpError(400, 'name cannot be empty.');
    if (name.length > 80) throw new HttpError(400, 'name must be 80 characters or fewer.');
    if (!name) {
      name = `${source.name} (copy)`.slice(0, 80);
      for (let i = 2; nameTaken(db, name); i++) name = `${source.name.slice(0, 70)} (copy ${i})`;
    } else if (nameTaken(db, name)) {
      throw new HttpError(409, 'Another scenario already uses this name.');
    }
    // Ids inside a scenario are scoped to it, so the content can be copied verbatim.
    return createScenario(db, { ...source, id: newId('sc'), name }, { sampleKey: null });
  });
}

/* ------------------------------------------------------------- reports */

const reportMeta = (r) => ({ id: r.id, scenarioId: r.scenario_id, title: r.title, createdAt: r.created_at });

export function listReports(db, scenarioId) {
  return db.prepare('SELECT id, scenario_id, title, created_at FROM reports WHERE scenario_id = ? ORDER BY created_at DESC, rowid DESC').all(scenarioId).map(reportMeta);
}

export function readReport(db, scenarioId, reportId) {
  const r = db.prepare('SELECT * FROM reports WHERE scenario_id = ? AND id = ?').get(scenarioId, reportId);
  if (!r) return null;
  return { ...reportMeta(r), options: JSON.parse(r.options), content: JSON.parse(r.content) };
}

export function createReport(db, scenarioId, value) {
  return tx(db, () => {
    if (!db.prepare('SELECT 1 FROM scenarios WHERE id = ?').get(scenarioId)) throw new HttpError(404, 'Scenario not found.');
    const count = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE scenario_id = ?').get(scenarioId).n;
    if (count >= LIMITS.reports) throw new HttpError(409, `A scenario can hold at most ${LIMITS.reports} saved reports. Delete some first.`);
    const id = newId('rp');
    db.prepare('INSERT INTO reports (id, scenario_id, title, options, content, created_at) VALUES (?,?,?,?,?,?)').run(
      id,
      scenarioId,
      value.title,
      value.options,
      value.content,
      new Date().toISOString(),
    );
    return readReport(db, scenarioId, id);
  });
}

export function deleteReport(db, scenarioId, reportId) {
  const res = db.prepare('DELETE FROM reports WHERE scenario_id = ? AND id = ?').run(scenarioId, reportId);
  if (res.changes === 0) throw new HttpError(404, 'Report not found.');
}

/* ------------------------------------------------------------ metadata */

export const getMeta = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
export const setMeta = (db, key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

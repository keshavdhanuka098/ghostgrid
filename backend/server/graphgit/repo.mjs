// Graph Git persistence. Every function that writes runs in one transaction (tx), so a branch, commit, restore or
// patch batch is either saved completely or not at all.
//
// Model in one paragraph: a commit points at an immutable snapshot of the whole graph and at its parent commit. A branch
// points at its head commit. Uncommitted edits are "pending patches" (structured operations stored on the branch);
// the branch's working graph is its head snapshot with the pending patches applied. Committing turns the working graph
// into a new snapshot and attaches the patches to the new commit. History is never rewritten: restore and revert add commits.

import crypto from 'node:crypto';
import { tx } from '../db.mjs';
import { HttpError } from '../errors.mjs';
import { validateGraph } from '../validate.mjs';
import { LIMITS_GG } from './constants.mjs';
import { runSimulation, simulationConfig } from './engine.mjs';
import { applyOps, baselineSummary, canonicalGraph, diffGraphs, graphHash, summarizeResults } from './patch.mjs';

const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
const nowIso = () => new Date().toISOString();
const json = (v) => JSON.stringify(v);
const parse = (s) => JSON.parse(s);
const one = (db, sql, ...args) => db.prepare(sql).get(...args);
const all = (db, sql, ...args) => db.prepare(sql).all(...args);
const run = (db, sql, ...args) => db.prepare(sql).run(...args);

/* ------------------------------------------------------------- validation */

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function validateBranchName(input) {
  if (typeof input !== 'string') throw new HttpError(400, 'name is required.');
  const name = input.trim();
  if (!name) throw new HttpError(400, 'name is required.');
  if (name.length > 80) throw new HttpError(400, 'name must be 80 characters or fewer.');
  if (!BRANCH_NAME.test(name) || name.includes('//') || name.includes('..') || /[/.]$/.test(name)) {
    throw new HttpError(400, 'name may use letters, numbers, ".", "_", "-" and "/" (for example fix/auth-microservice-timeout), must start with a letter or number, and cannot end with "/" or ".".');
  }
  return name;
}
function validateDescription(input) {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') throw new HttpError(400, 'description must be a string.');
  const d = input.trim();
  if (d.length > 300) throw new HttpError(400, 'description must be 300 characters or fewer.');
  return d;
}
function validateAuthor(input) {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string') throw new HttpError(400, 'author must be a string.');
  const a = input.trim();
  if (a.length > 80) throw new HttpError(400, 'author must be 80 characters or fewer.');
  return a || null;
}
function validateMessage(input, { required = true } = {}) {
  if (input === undefined || input === null || input === '') {
    if (required) throw new HttpError(400, 'message is required.');
    return '';
  }
  if (typeof input !== 'string') throw new HttpError(400, 'message must be a string.');
  const m = input.trim();
  if (!m && required) throw new HttpError(400, 'message is required.');
  if (m.length > 120) throw new HttpError(400, 'message must be 120 characters or fewer. Put detail in body.');
  if (/[\r\n]/.test(m)) throw new HttpError(400, 'message must be a single line. Put detail in body.');
  return m;
}
function validateBody(input) {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') throw new HttpError(400, 'body must be a string.');
  if (input.length > 2000) throw new HttpError(400, 'body must be 2000 characters or fewer.');
  return input.trim();
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/* -------------------------------------------------------------- snapshots */

function storeSnapshot(db, scenarioId, graph) {
  const canon = canonicalGraph(graph);
  const hash = graphHash(graph);
  const existing = one(db, 'SELECT id FROM graph_snapshots WHERE scenario_id = ? AND hash = ?', scenarioId, hash);
  if (existing) return { id: existing.id, hash };
  const id = newId('sn');
  run(db, 'INSERT INTO graph_snapshots (id, scenario_id, hash, graph, node_count, link_count, created_at) VALUES (?,?,?,?,?,?,?)',
    id, scenarioId, hash, json(canon), canon.assets.length, canon.dependencies.length, nowIso());
  return { id, hash };
}

function readSnapshot(db, snapshotId) {
  const row = one(db, 'SELECT graph FROM graph_snapshots WHERE id = ?', snapshotId);
  if (!row) throw new HttpError(500, 'Snapshot is missing.');
  const g = parse(row.graph);
  return { assets: g.assets, dependencies: g.dependencies };
}

const snapshotHashOf = (db, snapshotId) => one(db, 'SELECT hash FROM graph_snapshots WHERE id = ?', snapshotId).hash;

/** The scenario's own live graph (what the workspace and the other pages edit). */
export function readLiveGraph(db, scenarioId) {
  return {
    assets: all(db, 'SELECT id, name, kind, criticality, notes, x, y FROM nodes WHERE scenario_id = ? ORDER BY sort_order', scenarioId),
    dependencies: all(db, 'SELECT id, dependent_id AS dependentId, provider_id AS providerId, mode, status, relation, notes FROM links WHERE scenario_id = ? ORDER BY sort_order', scenarioId),
  };
}

/* ---------------------------------------------------------------- reading */

function commitView(db, row) {
  const snap = one(db, 'SELECT hash, node_count, link_count FROM graph_snapshots WHERE id = ?', row.snapshot_id);
  const branch = one(db, 'SELECT name FROM branches WHERE id = ?', row.branch_id);
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    branchId: row.branch_id,
    branchName: branch?.name ?? null,
    parentCommitId: row.parent_commit_id,
    snapshotId: row.snapshot_id,
    snapshotHash: snap.hash,
    seq: row.seq,
    kind: row.kind,
    message: row.message,
    body: row.body,
    author: row.author,
    summary: parse(row.summary),
    nodeCount: snap.node_count,
    linkCount: snap.link_count,
    createdAt: row.created_at,
  };
}

const commitRow = (db, id) => one(db, 'SELECT * FROM commits WHERE id = ?', id);
function requireCommit(db, id) {
  const row = commitRow(db, id);
  if (!row) throw new HttpError(404, 'Commit not found.');
  return row;
}
function requireBranchRow(db, id) {
  const row = one(db, 'SELECT * FROM branches WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Branch not found.');
  return row;
}

function patchView(row, revertedIds) {
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    branchId: row.branch_id,
    commitId: row.commit_id,
    baseCommitId: row.base_commit_id,
    seq: row.seq,
    type: row.op_type,
    category: row.category,
    op: parse(row.payload),
    inverse: parse(row.inverse),
    description: row.description,
    revertsPatchId: row.reverts_patch_id,
    reverted: revertedIds.has(row.id),
    pending: row.commit_id === null,
    createdAt: row.created_at,
  };
}
function patchViews(db, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const reverted = new Set(all(db, `SELECT reverts_patch_id AS id FROM graph_patches WHERE reverts_patch_id IN (${ids.map(() => '?').join(',')})`, ...ids).map((r) => r.id));
  return rows.map((r) => patchView(r, reverted));
}

const pendingRows = (db, branchId) => all(db, 'SELECT * FROM graph_patches WHERE branch_id = ? AND commit_id IS NULL ORDER BY seq', branchId);

/** Head snapshot with the pending patches applied. */
function workingGraph(db, branch) {
  const head = commitRow(db, branch.head_commit_id);
  const base = readSnapshot(db, head.snapshot_id);
  const pending = pendingRows(db, branch.id);
  if (!pending.length) return { graph: base, results: [], pending };
  const { graph, results } = applyOps(base, pending.map((p) => parse(p.payload)));
  return { graph, results, pending };
}

function branchAncestry(db, row) {
  const chain = [];
  const seen = new Set();
  let cur = row;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift({ id: cur.id, name: cur.name });
    cur = cur.parent_branch_id ? one(db, 'SELECT id, name, parent_branch_id FROM branches WHERE id = ?', cur.parent_branch_id) : null;
  }
  return chain;
}

function branchView(db, row) {
  const head = commitRow(db, row.head_commit_id);
  const counts = one(db, 'SELECT COUNT(*) AS n FROM commits WHERE branch_id = ?', row.id).n;
  const pending = one(db, 'SELECT COUNT(*) AS n FROM graph_patches WHERE branch_id = ? AND commit_id IS NULL', row.id).n;
  const sims = one(db, 'SELECT COUNT(*) AS n FROM branch_simulations WHERE branch_id = ?', row.id).n;
  const parent = row.parent_branch_id ? one(db, 'SELECT name FROM branches WHERE id = ?', row.parent_branch_id) : null;
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    name: row.name,
    description: row.description,
    parentBranchId: row.parent_branch_id,
    parentBranchName: parent?.name ?? null,
    ancestry: branchAncestry(db, row),
    baseCommitId: row.base_commit_id,
    baseCommitSeq: one(db, 'SELECT seq FROM commits WHERE id = ?', row.base_commit_id).seq,
    headCommitId: row.head_commit_id,
    isDefault: row.is_default === 1,
    commitCount: counts,
    pendingPatchCount: pending,
    simulationCount: sims,
    headCommit: commitView(db, head),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ----------------------------------------------------------- branch state */

/** Everything the UI needs to show one branch: metadata, head commit, working graph and pending patches. */
export function readBranchState(db, branchId) {
  const row = requireBranchRow(db, branchId);
  const { graph, pending } = workingGraph(db, row);
  const head = commitRow(db, row.head_commit_id);
  const state = {
    branch: branchView(db, row),
    head: commitView(db, head),
    working: { assets: graph.assets, dependencies: graph.dependencies },
    patches: patchViews(db, pending),
    dirty: pending.length > 0,
  };
  if (row.is_default === 1) {
    // Edits made to the scenario elsewhere in GhostGrid (workspace, graph page) never touch main on their own; this flags the difference.
    const live = readLiveGraph(db, row.scenario_id);
    state.scenarioDrift = graphHash(live, { layout: false }) !== graphHash(readSnapshot(db, head.snapshot_id), { layout: false });
  }
  return state;
}

export function listBranches(db, scenarioId) {
  requireScenarioRow(db, scenarioId);
  ensureMainBranch(db, scenarioId);
  return all(db, 'SELECT * FROM branches WHERE scenario_id = ? ORDER BY is_default DESC, created_at, rowid', scenarioId).map((r) => branchView(db, r));
}

function requireScenarioRow(db, scenarioId) {
  if (!one(db, 'SELECT 1 FROM scenarios WHERE id = ?', scenarioId)) throw new HttpError(404, 'Scenario not found.');
}

/* ---------------------------------------------------------------- writing */

function insertCommit(db, { scenarioId, branchId, parentId, snapshotId, kind, message, body = '', author = null, summary, id = newId('cm') }) {
  const seq = one(db, 'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM commits WHERE scenario_id = ?', scenarioId).n;
  if (seq > LIMITS_GG.commitsPerScenario) throw new HttpError(409, `A scenario can hold at most ${LIMITS_GG.commitsPerScenario} commits.`);
  run(db, 'INSERT INTO commits (id, scenario_id, branch_id, parent_commit_id, snapshot_id, seq, kind, message, body, author, summary, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    id, scenarioId, branchId, parentId, snapshotId, seq, kind, message, body, author, json(summary), nowIso());
  return id;
}

function insertPatch(db, { scenarioId, branchId, commitId = null, baseCommitId, result, revertsPatchId = null }) {
  const seq = one(db, 'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM graph_patches WHERE branch_id = ?', branchId).n;
  const id = newId('pt');
  run(db, 'INSERT INTO graph_patches (id, scenario_id, branch_id, commit_id, base_commit_id, seq, op_type, category, payload, inverse, description, reverts_patch_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, scenarioId, branchId, commitId, baseCommitId, seq, result.op.type, result.category, json(result.op), json(result.inverse), result.description, revertsPatchId, nowIso());
  return id;
}

/**
 * Creates the default "main" branch with a baseline commit of the scenario's current graph, if it does not exist yet.
 * Called when a scenario is created, once at startup for older scenarios, and lazily when branches are listed.
 */
export function ensureMainBranch(db, scenarioId) {
  return tx(db, () => {
    const existing = one(db, 'SELECT id FROM branches WHERE scenario_id = ? AND is_default = 1', scenarioId);
    if (existing) return existing.id;
    const graph = readLiveGraph(db, scenarioId);
    const snap = storeSnapshot(db, scenarioId, graph);
    const branchId = newId('br');
    const commitId = newId('cm');
    const now = nowIso();
    // The branch and its first commit reference each other; those foreign keys are deferred until the transaction ends.
    run(db, 'INSERT INTO branches (id, scenario_id, name, description, parent_branch_id, base_commit_id, head_commit_id, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      branchId, scenarioId, 'main', 'Default branch. Starts from the scenario as it was mapped.', null, commitId, commitId, 1, now, now);
    insertCommit(db, { id: commitId, scenarioId, branchId, parentId: null, snapshotId: snap.id, kind: 'baseline', message: 'Initial infrastructure baseline', summary: baselineSummary(graph) });
    return branchId;
  });
}

/** Adds main branches to scenarios created before Graph Git existed. Safe to run on every start. */
export function backfillMainBranches(db) {
  let n = 0;
  for (const { id } of all(db, 'SELECT id FROM scenarios WHERE id NOT IN (SELECT scenario_id FROM branches WHERE is_default = 1)')) {
    ensureMainBranch(db, id);
    n++;
  }
  return n;
}

export function createBranch(db, scenarioId, input) {
  return tx(db, () => {
    requireScenarioRow(db, scenarioId);
    const mainId = ensureMainBranch(db, scenarioId);
    const name = validateBranchName(input?.name);
    const description = validateDescription(input?.description);
    if (one(db, 'SELECT COUNT(*) AS n FROM branches WHERE scenario_id = ?', scenarioId).n >= LIMITS_GG.branches) {
      throw new HttpError(409, `A scenario can hold at most ${LIMITS_GG.branches} branches.`);
    }
    if (one(db, 'SELECT 1 FROM branches WHERE scenario_id = ? AND name = ? COLLATE NOCASE', scenarioId, name)) throw new HttpError(409, `A branch named "${name}" already exists.`);

    let source;
    if (input?.fromCommitId !== undefined && input?.fromCommitId !== null) {
      source = requireCommit(db, String(input.fromCommitId));
      if (source.scenario_id !== scenarioId) throw new HttpError(400, 'That commit belongs to a different scenario.');
    } else {
      const from = input?.fromBranchId !== undefined && input?.fromBranchId !== null ? requireBranchRow(db, String(input.fromBranchId)) : requireBranchRow(db, mainId);
      if (from.scenario_id !== scenarioId) throw new HttpError(400, 'That branch belongs to a different scenario.');
      source = commitRow(db, from.head_commit_id);
    }
    const id = newId('br');
    const now = nowIso();
    run(db, 'INSERT INTO branches (id, scenario_id, name, description, parent_branch_id, base_commit_id, head_commit_id, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, scenarioId, name, description, source.branch_id, source.id, source.id, 0, now, now);
    return readBranchState(db, id);
  });
}

export function updateBranch(db, branchId, input) {
  return tx(db, () => {
    const row = requireBranchRow(db, branchId);
    if (input?.name === undefined && input?.description === undefined) throw new HttpError(400, 'Provide a name or a description to change.');
    const name = input.name === undefined ? row.name : validateBranchName(input.name);
    const description = input.description === undefined ? row.description : validateDescription(input.description);
    if (name.toLowerCase() !== row.name.toLowerCase() && one(db, 'SELECT 1 FROM branches WHERE scenario_id = ? AND name = ? COLLATE NOCASE AND id <> ?', row.scenario_id, name, row.id)) {
      throw new HttpError(409, `A branch named "${name}" already exists.`);
    }
    run(db, 'UPDATE branches SET name = ?, description = ?, updated_at = ? WHERE id = ?', name, description, nowIso(), row.id);
    return readBranchState(db, row.id);
  });
}

/** Branches that must not lose this branch's history: other branches built on its commits. */
function deletionBlockers(db, branch) {
  const own = 'SELECT id FROM commits WHERE branch_id = ?';
  const reasons = [];
  for (const b of all(db, `SELECT DISTINCT name FROM branches WHERE id <> ? AND (base_commit_id IN (${own}) OR head_commit_id IN (${own}))`, branch.id, branch.id, branch.id)) {
    reasons.push(`Branch "${b.name}" was created from this branch's history.`);
  }
  for (const b of all(db, `SELECT DISTINCT b.name FROM commits c JOIN branches b ON b.id = c.branch_id WHERE c.branch_id <> ? AND c.parent_commit_id IN (${own})`, branch.id, branch.id)) {
    reasons.push(`Branch "${b.name}" has commits that build on this branch's history.`);
  }
  return [...new Set(reasons)];
}

export function deleteBranch(db, branchId) {
  tx(db, () => {
    const row = requireBranchRow(db, branchId);
    if (row.is_default === 1) throw new HttpError(409, 'The default branch cannot be deleted.');
    const blockers = deletionBlockers(db, row);
    if (blockers.length) throw new HttpError(409, `Branch "${row.name}" cannot be deleted while other history depends on it.`, blockers);
    run(db, 'DELETE FROM branches WHERE id = ?', row.id); // cascades to its commits, patches and simulations
    run(db, 'DELETE FROM graph_snapshots WHERE scenario_id = ? AND id NOT IN (SELECT snapshot_id FROM commits)', row.scenario_id);
  });
}

/* ---------------------------------------------------------------- patches */

function checkExpectedHead(branch, expected) {
  if (expected !== undefined && expected !== null && expected !== branch.head_commit_id) {
    throw new HttpError(409, 'This branch has moved on since you loaded it. Reload and try again.');
  }
}

/** Applies a batch of structured operations to a branch's working graph, atomically. */
export function addPatches(db, branchId, ops, { expectedHeadCommitId } = {}) {
  return tx(db, () => {
    const branch = requireBranchRow(db, branchId);
    checkExpectedHead(branch, expectedHeadCommitId);
    if (!Array.isArray(ops) || ops.length === 0) throw new HttpError(400, 'Provide an operation (op) or a non-empty list of operations (ops).');
    if (ops.length > LIMITS_GG.patchesPerRequest) throw new HttpError(400, `At most ${LIMITS_GG.patchesPerRequest} operations per request.`);
    const { graph, pending } = workingGraph(db, branch);
    const { results } = applyOps(graph, ops);
    const created = [];

    // Dragging an asset repeatedly should not bury real changes: consecutive moves of one asset become one patch.
    const last = pending.at(-1);
    if (results.length === 1 && results[0].op.type === 'move_node' && last && last.op_type === 'move_node' && parse(last.payload).nodeId === results[0].op.nodeId) {
      run(db, 'UPDATE graph_patches SET payload = ? WHERE id = ?', json(results[0].op), last.id);
      created.push(last.id);
    } else {
      if (pending.length + results.length > LIMITS_GG.pendingPatches) throw new HttpError(409, 'Too many uncommitted changes. Commit or discard some first.');
      for (const result of results) created.push(insertPatch(db, { scenarioId: branch.scenario_id, branchId: branch.id, baseCommitId: branch.head_commit_id, result }));
    }
    run(db, 'UPDATE branches SET updated_at = ? WHERE id = ?', nowIso(), branch.id);
    const rows = created.map((id) => one(db, 'SELECT * FROM graph_patches WHERE id = ?', id));
    return { created: patchViews(db, rows), state: readBranchState(db, branch.id) };
  });
}

export function listPatches(db, branchId, status = 'all') {
  requireBranchRow(db, branchId);
  const where = status === 'pending' ? ' AND commit_id IS NULL' : status === 'committed' ? ' AND commit_id IS NOT NULL' : '';
  return patchViews(db, all(db, `SELECT * FROM graph_patches WHERE branch_id = ?${where} ORDER BY seq`, branchId));
}

/** Undoes one pending patch by appending its inverse as new patches. The original stays in the record. */
export function revertPatch(db, branchId, patchId) {
  return tx(db, () => {
    const branch = requireBranchRow(db, branchId);
    const patch = one(db, 'SELECT * FROM graph_patches WHERE id = ? AND branch_id = ?', patchId, branchId);
    if (!patch) throw new HttpError(404, 'Patch not found on this branch.');
    if (patch.commit_id !== null) throw new HttpError(409, 'That change is already committed. Revert the commit instead.');
    if (one(db, 'SELECT 1 FROM graph_patches WHERE reverts_patch_id = ?', patch.id)) throw new HttpError(409, 'That change has already been undone.');
    const { graph } = workingGraph(db, branch);
    const { results } = applyOps(graph, parse(patch.inverse), { strict: true });
    for (const result of results) insertPatch(db, { scenarioId: branch.scenario_id, branchId, baseCommitId: branch.head_commit_id, result, revertsPatchId: patch.id });
    run(db, 'UPDATE branches SET updated_at = ? WHERE id = ?', nowIso(), branchId);
    return readBranchState(db, branchId);
  });
}

export function discardPending(db, branchId) {
  return tx(db, () => {
    const branch = requireBranchRow(db, branchId);
    run(db, 'DELETE FROM graph_patches WHERE branch_id = ? AND commit_id IS NULL', branchId);
    run(db, 'UPDATE branches SET updated_at = ? WHERE id = ?', nowIso(), branch.id);
    return readBranchState(db, branchId);
  });
}

/* ---------------------------------------------------------------- commits */

export function commitBranch(db, branchId, input) {
  return tx(db, () => {
    const branch = requireBranchRow(db, branchId);
    checkExpectedHead(branch, input?.expectedHeadCommitId);
    const message = validateMessage(input?.message);
    const body = validateBody(input?.body);
    const author = validateAuthor(input?.author);
    const { graph, results, pending } = workingGraph(db, branch);
    if (!pending.length) throw new HttpError(409, 'Nothing to commit: this branch has no uncommitted changes.');
    const head = commitRow(db, branch.head_commit_id);
    if (graphHash(graph) === snapshotHashOf(db, head.snapshot_id)) {
      throw new HttpError(409, 'The uncommitted changes cancel each other out, so there is nothing to commit. Discard them instead.');
    }
    const snap = storeSnapshot(db, branch.scenario_id, graph);
    const commitId = insertCommit(db, { scenarioId: branch.scenario_id, branchId, parentId: head.id, snapshotId: snap.id, kind: 'commit', message, body, author, summary: summarizeResults(results) });
    run(db, 'UPDATE graph_patches SET commit_id = ? WHERE branch_id = ? AND commit_id IS NULL', commitId, branchId);
    run(db, 'UPDATE branches SET head_commit_id = ?, updated_at = ? WHERE id = ?', commitId, nowIso(), branchId);
    return { commit: commitView(db, commitRow(db, commitId)), state: readBranchState(db, branchId) };
  });
}

/** Newest first, following parent links from the branch head. History shared with the branch it was created from is included. */
export function listCommits(db, branchId, { limit = 100, offset = 0 } = {}) {
  const branch = requireBranchRow(db, branchId);
  const lim = Math.min(500, Math.max(1, Number.isInteger(limit) ? limit : 100));
  const off = Math.max(0, Number.isInteger(offset) ? offset : 0);
  const rows = all(db, `
    WITH RECURSIVE anc(id, depth) AS (
      SELECT id, 0 FROM commits WHERE id = ?
      UNION ALL
      SELECT c.parent_commit_id, anc.depth + 1 FROM commits c JOIN anc ON c.id = anc.id WHERE c.parent_commit_id IS NOT NULL
    )
    SELECT c.* FROM anc JOIN commits c ON c.id = anc.id ORDER BY anc.depth LIMIT ? OFFSET ?`, branch.head_commit_id, lim, off);
  const total = one(db, `
    WITH RECURSIVE anc(id) AS (
      SELECT id FROM commits WHERE id = ?
      UNION ALL
      SELECT c.parent_commit_id FROM commits c JOIN anc ON c.id = anc.id WHERE c.parent_commit_id IS NOT NULL
    ) SELECT COUNT(*) AS n FROM anc`, branch.head_commit_id).n;
  return { commits: rows.map((r) => commitView(db, r)), total };
}

export function readCommit(db, commitId) {
  const row = requireCommit(db, commitId);
  const patches = patchViews(db, all(db, 'SELECT * FROM graph_patches WHERE commit_id = ? ORDER BY seq', commitId));
  return { commit: commitView(db, row), graph: readSnapshot(db, row.snapshot_id), patches };
}

function isAncestorOrSelf(db, ancestorId, headId) {
  return !!one(db, `
    WITH RECURSIVE anc(id) AS (
      SELECT id FROM commits WHERE id = ?
      UNION ALL
      SELECT c.parent_commit_id FROM commits c JOIN anc ON c.id = anc.id WHERE c.parent_commit_id IS NOT NULL
    ) SELECT 1 FROM anc WHERE id = ? LIMIT 1`, headId, ancestorId);
}

/** Shared by restore, revert and sync: apply operations strictly, check the outcome, and write one new commit with its patches. */
function commitOps(db, branch, { kind, message, body = '', author = null, ops, expectHash }) {
  const head = commitRow(db, branch.head_commit_id);
  const base = readSnapshot(db, head.snapshot_id);
  const { graph, results } = applyOps(base, ops, { strict: true });
  const hash = graphHash(graph);
  if (expectHash && hash !== expectHash) throw new HttpError(500, 'Verification failed: the resulting graph does not match the expected content. Nothing was saved.');
  if (hash === snapshotHashOf(db, head.snapshot_id)) throw new HttpError(409, 'That would not change the branch: its current graph is already identical.');
  const snap = storeSnapshot(db, branch.scenario_id, graph);
  const commitId = insertCommit(db, { scenarioId: branch.scenario_id, branchId: branch.id, parentId: head.id, snapshotId: snap.id, kind, message, body, author, summary: summarizeResults(results) });
  for (const result of results) insertPatch(db, { scenarioId: branch.scenario_id, branchId: branch.id, commitId, baseCommitId: head.id, result });
  run(db, 'UPDATE branches SET head_commit_id = ?, updated_at = ? WHERE id = ?', commitId, nowIso(), branch.id);
  return commitId;
}

function prepareTargetBranch(db, input, fallbackBranchId, scenarioId) {
  const branch = requireBranchRow(db, String(input?.branchId ?? fallbackBranchId));
  if (branch.scenario_id !== scenarioId) throw new HttpError(400, 'That branch belongs to a different scenario.');
  const pending = one(db, 'SELECT COUNT(*) AS n FROM graph_patches WHERE branch_id = ? AND commit_id IS NULL', branch.id).n;
  if (pending) {
    if (input?.discardPending !== true) {
      throw new HttpError(409, `Branch "${branch.name}" has ${pending} uncommitted change${pending === 1 ? '' : 's'}. Commit or discard them first, or confirm that they may be discarded.`, ['discardPending']);
    }
    run(db, 'DELETE FROM graph_patches WHERE branch_id = ? AND commit_id IS NULL', branch.id);
  }
  return branch;
}

/** Brings an older version back as a NEW commit on the branch. The old commit and everything after it stay as they were. */
export function restoreCommit(db, commitId, input) {
  return tx(db, () => {
    const target = requireCommit(db, commitId);
    const branch = prepareTargetBranch(db, input, target.branch_id, target.scenario_id);
    checkExpectedHead(branch, input?.expectedHeadCommitId);
    const head = commitRow(db, branch.head_commit_id);
    const targetGraph = readSnapshot(db, target.snapshot_id);
    const headGraph = readSnapshot(db, head.snapshot_id);
    const message = validateMessage(input?.message, { required: false }) || clip(`Restore commit #${target.seq}: ${target.message}`, 120);
    const newId_ = commitOps(db, branch, {
      kind: 'restore',
      message,
      body: validateBody(input?.body) || `Restored the graph from commit #${target.seq} (${target.id}).`,
      author: validateAuthor(input?.author),
      ops: diffGraphs(headGraph, targetGraph),
      expectHash: snapshotHashOf(db, target.snapshot_id),
    });
    return { commit: commitView(db, commitRow(db, newId_)), state: readBranchState(db, branch.id) };
  });
}

/** Adds a commit that undoes what an earlier commit changed. Refused if later changes conflict with it. */
export function revertCommit(db, commitId, input) {
  return tx(db, () => {
    const target = requireCommit(db, commitId);
    const branch = prepareTargetBranch(db, input, target.branch_id, target.scenario_id);
    checkExpectedHead(branch, input?.expectedHeadCommitId);
    if (!target.parent_commit_id) throw new HttpError(409, 'The first commit on a branch has nothing before it to go back to. Use restore instead.');
    if (!isAncestorOrSelf(db, target.id, branch.head_commit_id)) throw new HttpError(400, `Commit #${target.seq} is not part of branch "${branch.name}"'s history.`);
    const parent = commitRow(db, target.parent_commit_id);
    const ops = diffGraphs(readSnapshot(db, target.snapshot_id), readSnapshot(db, parent.snapshot_id), { expect: true });
    if (!ops.length) throw new HttpError(409, `Commit #${target.seq} did not change the graph, so there is nothing to revert.`);
    let newId_;
    try {
      newId_ = commitOps(db, branch, {
        kind: 'revert',
        message: validateMessage(input?.message, { required: false }) || clip(`Revert "${target.message}"`, 120),
        body: validateBody(input?.body) || `Reverts commit #${target.seq} (${target.id}).`,
        author: validateAuthor(input?.author),
        ops,
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) throw new HttpError(409, `Commit #${target.seq} cannot be reverted cleanly: ${err.message}`, err.details);
      throw err;
    }
    return { commit: commitView(db, commitRow(db, newId_)), state: readBranchState(db, branch.id) };
  });
}

/** Copies edits made to the scenario itself (outside Graph Git) onto the default branch, as a visible commit. */
export function syncFromScenario(db, branchId, input) {
  return tx(db, () => {
    const branch = requireBranchRow(db, branchId);
    if (branch.is_default !== 1) throw new HttpError(400, 'Only the default branch can be synced from the scenario.');
    const pending = one(db, 'SELECT COUNT(*) AS n FROM graph_patches WHERE branch_id = ? AND commit_id IS NULL', branch.id).n;
    if (pending && input?.discardPending !== true) throw new HttpError(409, 'The branch has uncommitted changes. Commit or discard them first.', ['discardPending']);
    if (pending) run(db, 'DELETE FROM graph_patches WHERE branch_id = ? AND commit_id IS NULL', branch.id);
    const live = readLiveGraph(db, branch.scenario_id);
    const check = validateGraph(live);
    if (!check.ok) throw new HttpError(409, 'The scenario graph is not valid.', check.errors);
    const head = commitRow(db, branch.head_commit_id);
    const id = commitOps(db, branch, {
      kind: 'sync',
      message: validateMessage(input?.message, { required: false }) || 'Sync scenario edits',
      body: 'Copied the scenario\'s current assets and dependencies onto this branch.',
      author: validateAuthor(input?.author),
      ops: diffGraphs(readSnapshot(db, head.snapshot_id), live),
      expectHash: graphHash(live),
    });
    return { commit: commitView(db, commitRow(db, id)), state: readBranchState(db, branch.id) };
  });
}

/** Metadata and a change summary for two commits of one scenario. */
export function compareCommits(db, fromId, toId) {
  const from = requireCommit(db, fromId);
  const to = requireCommit(db, toId);
  if (from.scenario_id !== to.scenario_id) throw new HttpError(400, 'Commits must belong to the same scenario.');
  const fromGraph = readSnapshot(db, from.snapshot_id);
  const toGraph = readSnapshot(db, to.snapshot_id);
  const ops = diffGraphs(fromGraph, toGraph);
  const { results } = applyOps(fromGraph, ops);
  const relation = from.id === to.id ? 'same' : isAncestorOrSelf(db, from.id, to.id) ? 'ancestor' : isAncestorOrSelf(db, to.id, from.id) ? 'descendant' : 'diverged';
  return {
    from: commitView(db, from),
    to: commitView(db, to),
    relation,
    sameContent: snapshotHashOf(db, from.snapshot_id) === snapshotHashOf(db, to.snapshot_id),
    summary: summarizeResults(results),
  };
}

/* ------------------------------------------------------------ simulations */

function simView(db, row, branchHead) {
  const commit = commitRow(db, row.commit_id);
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    branchId: row.branch_id,
    commitId: row.commit_id,
    commit: { id: commit.id, seq: commit.seq, message: commit.message, branchId: commit.branch_id, createdAt: commit.created_at },
    isCurrent: row.commit_id === branchHead,
    name: row.name,
    failedIds: parse(row.failed_nodes),
    failedLinkIds: parse(row.failed_links),
    config: parse(row.config),
    totals: { failed: row.total_failed, cascaded: row.cascaded, critical: row.critical, rounds: row.rounds },
    createdAt: row.created_at,
  };
}

function seedList(input, field) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((x) => typeof x !== 'string' || !x)) throw new HttpError(400, `${field} must be an array of ids.`);
  return [...new Set(input)];
}

/**
 * Runs the existing cascade engine on a committed snapshot and stores the result against that commit.
 * The server computes the result itself; clients only choose the failure.
 */
export function createSimulation(db, branchId, input) {
  return tx(db, () => {
    const branch = requireBranchRow(db, branchId);
    const commit = requireCommit(db, String(input?.commitId ?? branch.head_commit_id));
    if (commit.scenario_id !== branch.scenario_id || !isAncestorOrSelf(db, commit.id, branch.head_commit_id)) {
      throw new HttpError(400, `Commit #${commit.seq} is not part of branch "${branch.name}"'s history.`);
    }
    const graph = readSnapshot(db, commit.snapshot_id);
    const nodes = seedList(input?.failedIds, 'failedIds');
    const links = seedList(input?.failedLinkIds, 'failedLinkIds');
    if (!nodes.length && !links.length) throw new HttpError(400, 'Choose at least one asset or dependency link to fail.');
    const unknownN = nodes.filter((id) => !graph.assets.some((a) => a.id === id));
    const unknownL = links.filter((id) => !graph.dependencies.some((d) => d.id === id));
    if (unknownN.length || unknownL.length) {
      throw new HttpError(400, `Commit #${commit.seq} does not contain: ${[...unknownN, ...unknownL].join(', ')}.`);
    }
    let name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (input?.name !== undefined && input?.name !== null && typeof input.name !== 'string') throw new HttpError(400, 'name must be a string.');
    if (name.length > 80) throw new HttpError(400, 'name must be 80 characters or fewer.');
    if (!name) {
      const label = (id) => graph.assets.find((a) => a.id === id)?.name ?? id;
      name = clip(nodes.length === 1 && !links.length ? `${label(nodes[0])} outage` : `${nodes.length + links.length} failures`, 60) + ` @ #${commit.seq}`;
    }
    if (one(db, 'SELECT COUNT(*) AS n FROM branch_simulations WHERE branch_id = ?', branch.id).n >= LIMITS_GG.simulationsPerBranch) {
      throw new HttpError(409, `A branch can hold at most ${LIMITS_GG.simulationsPerBranch} saved simulations.`);
    }
    const result = runSimulation(graph, { nodes, links });
    const id = newId('sm');
    run(db, 'INSERT INTO branch_simulations (id, scenario_id, branch_id, commit_id, name, failed_nodes, failed_links, config, result, total_failed, cascaded, critical, rounds, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, branch.scenario_id, branch.id, commit.id, name, json(nodes), json(links), json(simulationConfig()), json(result),
      result.totals.failed, result.totals.cascaded, result.totals.critical, Math.max(0, result.totals.rounds), nowIso());
    return readSimulation(db, id);
  });
}

export function listSimulations(db, branchId, { commitId } = {}) {
  const branch = requireBranchRow(db, branchId);
  const rows = commitId
    ? all(db, 'SELECT * FROM branch_simulations WHERE branch_id = ? AND commit_id = ? ORDER BY created_at DESC, rowid DESC', branchId, commitId)
    : all(db, 'SELECT * FROM branch_simulations WHERE branch_id = ? ORDER BY created_at DESC, rowid DESC', branchId);
  return rows.map((r) => simView(db, r, branch.head_commit_id));
}

/** One saved simulation, with the exact graph it ran on and a check that recomputing it today gives the identical result. */
export function readSimulation(db, simId) {
  const row = one(db, 'SELECT * FROM branch_simulations WHERE id = ?', simId);
  if (!row) throw new HttpError(404, 'Simulation not found.');
  const branch = requireBranchRow(db, row.branch_id);
  const commit = commitRow(db, row.commit_id);
  const graph = readSnapshot(db, commit.snapshot_id);
  const result = parse(row.result);
  const again = runSimulation(graph, { nodes: parse(row.failed_nodes), links: parse(row.failed_links) });
  return {
    ...simView(db, row, branch.head_commit_id),
    result,
    graph,
    reproducible: json(again) === json(result),
  };
}


// Graph Git patch engine: canonical graphs, structured patch operations, inverses, and graph diffs.
// Pure functions only (no database access), so every rule here can be tested directly.
//
// A graph is { assets, dependencies } in the same shape the scenario API uses. Operations are a closed set of
// structured types (see PATCH_TYPES); there is no way to submit "free-form" JSON edits. After every operation the
// resulting graph is checked with the scenario validator (validateGraph), so a patched graph is always a valid scenario graph.

import crypto from 'node:crypto';
import { HttpError } from '../errors.mjs';
import { ASSET_KINDS, CRITICALITIES, LINK_STATUSES, MODES, RELATIONS, validateGraph } from '../validate.mjs';
import { ENGINE_VERSION, UNSUPPORTED_PATCH_TYPES } from './constants.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* ------------------------------------------------------------ canonical graph */

const canonAsset = (a) => ({
  id: a.id,
  name: a.name,
  kind: a.kind,
  criticality: a.criticality,
  notes: a.notes ?? '',
  x: typeof a.x === 'number' && typeof a.y === 'number' ? a.x : null,
  y: typeof a.x === 'number' && typeof a.y === 'number' ? a.y : null,
});
const canonDep = (d) => ({
  id: d.id,
  dependentId: d.dependentId,
  providerId: d.providerId,
  mode: d.mode,
  status: d.status,
  relation: d.relation,
  notes: d.notes ?? '',
});
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Stable form of a graph: fixed field order, sorted by id. Two graphs with the same content have the same canonical form. */
export function canonicalGraph(graph) {
  return {
    engineVersion: ENGINE_VERSION,
    assets: graph.assets.map(canonAsset).sort(byId),
    dependencies: graph.dependencies.map(canonDep).sort(byId),
  };
}

/** SHA-256 of the canonical graph. With layout:false, canvas positions are ignored. */
export function graphHash(graph, { layout = true } = {}) {
  const c = canonicalGraph(graph);
  if (!layout) c.assets = c.assets.map((a) => ({ ...a, x: null, y: null }));
  return crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex');
}

export const cloneGraph = (g) => ({ assets: g.assets.map((a) => ({ ...a })), dependencies: g.dependencies.map((d) => ({ ...d })) });

/* ------------------------------------------------------------------- helpers */

const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

/** Errors about the state of the graph are conflicts (409) when applying strictly (reverts, restores), otherwise bad requests (400). */
class Ctx {
  constructor(strict) {
    this.strict = !!strict;
  }
  bad(message) {
    throw new HttpError(400, message);
  }
  state(message) {
    throw new HttpError(this.strict ? 409 : 400, message);
  }
}

function text(ctx, v, field, max, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) ctx.bad(`${field} is required.`);
    return '';
  }
  if (typeof v !== 'string') ctx.bad(`${field} must be a string.`);
  const t = v.trim();
  if (required && !t) ctx.bad(`${field} is required.`);
  if (t.length > max) ctx.bad(`${field} must be ${max} characters or fewer.`);
  return t;
}
function oneOf(ctx, list, v, field) {
  if (!list.includes(v)) ctx.bad(`${field} must be one of: ${list.join(', ')}.`);
  return v;
}
const coord = (v) => Math.round(v * 10) / 10;
function position(ctx, x, y) {
  if ((x === null || x === undefined) && (y === null || y === undefined)) return { x: null, y: null };
  const ok = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100000;
  if (!ok(x) || !ok(y)) ctx.bad('x and y must both be numbers (within ±100000), or both empty to release the pinned position.');
  return { x: coord(x), y: coord(y) };
}
function findNode(ctx, g, id, field = 'nodeId') {
  if (typeof id !== 'string' || !id) ctx.bad(`${field} is required.`);
  const n = g.assets.find((a) => a.id === id);
  if (!n) ctx.state(`Asset "${id}" does not exist in this branch.`);
  return n;
}
function findDep(ctx, g, id) {
  if (typeof id !== 'string' || !id) ctx.bad('dependencyId is required.');
  const d = g.dependencies.find((x) => x.id === id);
  if (!d) ctx.state(`Dependency "${id}" does not exist in this branch.`);
  return d;
}
const nameOf = (g, id) => g.assets.find((a) => a.id === id)?.name ?? id;
const q = (s) => `"${s}"`;

/** Compares an operation's optional `expect` values with the graph, so stale or conflicting operations are refused. */
function checkExpect(ctx, expect, current, label) {
  if (expect === undefined) return;
  if (!isObj(expect)) ctx.bad('expect must be an object.');
  for (const [k, v] of Object.entries(expect)) {
    if ((current[k] ?? null) !== (v ?? null)) ctx.state(`${label} has changed since this operation was prepared (${k} is now ${JSON.stringify(current[k] ?? null)}).`);
  }
}

function rejectUnknownKeys(ctx, obj, allowed, field, hints = {}) {
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k)) continue;
    ctx.bad(hints[k] ?? `${field}.${k} is not a field that can be changed here.`);
  }
}

/* -------------------------------------------------------------- operations */

const CATEGORY = {
  add_node: 'structural',
  delete_node: 'structural',
  modify_node: 'structural',
  set_criticality: 'structural',
  move_node: 'layout',
  add_dependency: 'structural',
  remove_dependency: 'structural',
  modify_dependency: 'structural',
  replace_provider: 'structural',
  set_dependency_mode: 'behavioural',
};
export const categoryOf = (type) => CATEGORY[type];

const HANDLERS = {
  add_node(ctx, g, op) {
    if (!isObj(op.node)) ctx.bad('node is required.');
    const n = op.node;
    const id = n.id === undefined ? newId('as') : text(ctx, n.id, 'node.id', 80, { required: true });
    if (g.assets.some((a) => a.id === id)) ctx.state(`An asset with id "${id}" already exists.`);
    const name = text(ctx, n.name, 'node.name', 60, { required: true });
    if (g.assets.some((a) => a.name.toLowerCase() === name.toLowerCase())) ctx.state(`An asset named "${name}" already exists.`);
    const asset = {
      id,
      name,
      kind: oneOf(ctx, ASSET_KINDS, n.kind, 'node.kind'),
      criticality: oneOf(ctx, CRITICALITIES, n.criticality, 'node.criticality'),
      notes: text(ctx, n.notes, 'node.notes', 200),
      ...position(ctx, n.x, n.y),
    };
    g.assets.push(asset);
    return {
      op: { type: 'add_node', node: { ...asset } },
      inverse: [{ type: 'delete_node', nodeId: id }],
      description: `Add asset ${q(name)} (${asset.kind}, ${asset.criticality} criticality)`,
    };
  },

  delete_node(ctx, g, op) {
    const node = findNode(ctx, g, op.nodeId);
    const touching = g.dependencies.filter((d) => d.dependentId === node.id || d.providerId === node.id);
    if (ctx.strict && touching.length) {
      ctx.state(`Asset ${q(node.name)} still has ${touching.length} dependenc${touching.length === 1 ? 'y' : 'ies'} that later changes rely on, so it cannot be removed here.`);
    }
    const before = { ...node };
    const removedDeps = touching.map((d) => ({ ...d }));
    g.assets = g.assets.filter((a) => a.id !== node.id);
    g.dependencies = g.dependencies.filter((d) => d.dependentId !== node.id && d.providerId !== node.id);
    return {
      op: { type: 'delete_node', nodeId: node.id },
      inverse: [{ type: 'add_node', node: before }, ...removedDeps.map((dependency) => ({ type: 'add_dependency', dependency }))],
      description: `Delete asset ${q(node.name)}${removedDeps.length ? ` and ${removedDeps.length} dependenc${removedDeps.length === 1 ? 'y' : 'ies'} on it` : ''}`,
    };
  },

  modify_node(ctx, g, op) {
    const node = findNode(ctx, g, op.nodeId);
    if (!isObj(op.changes) || !Object.keys(op.changes).length) ctx.bad('changes must name at least one field.');
    rejectUnknownKeys(ctx, op.changes, ['name', 'kind', 'notes'], 'changes', {
      criticality: 'Use the set_criticality operation to change criticality.',
      x: 'Use the move_node operation to move an asset.',
      y: 'Use the move_node operation to move an asset.',
      id: 'An asset id cannot be changed.',
    });
    checkExpect(ctx, op.expect, node, `Asset ${q(node.name)}`);
    const next = {};
    if (has(op.changes, 'name')) {
      const name = text(ctx, op.changes.name, 'changes.name', 60, { required: true });
      if (g.assets.some((a) => a.id !== node.id && a.name.toLowerCase() === name.toLowerCase())) ctx.state(`An asset named "${name}" already exists.`);
      next.name = name;
    }
    if (has(op.changes, 'kind')) next.kind = oneOf(ctx, ASSET_KINDS, op.changes.kind, 'changes.kind');
    if (has(op.changes, 'notes')) next.notes = text(ctx, op.changes.notes, 'changes.notes', 200);
    const changes = {};
    const before = {};
    for (const [k, v] of Object.entries(next)) {
      if (node[k] !== v) {
        before[k] = node[k];
        changes[k] = v;
      }
    }
    if (!Object.keys(changes).length) ctx.bad(`Asset ${q(node.name)} already has those values; there is nothing to change.`);
    const label = node.name;
    Object.assign(node, changes);
    const parts = Object.keys(changes).map((k) => (k === 'notes' ? 'notes' : `${k} ${JSON.stringify(before[k])} → ${JSON.stringify(changes[k])}`));
    return {
      op: { type: 'modify_node', nodeId: node.id, changes },
      inverse: [{ type: 'modify_node', nodeId: node.id, changes: before, expect: changes }],
      description: `Edit asset ${q(label)}: ${parts.join(', ')}`,
    };
  },

  set_criticality(ctx, g, op) {
    const node = findNode(ctx, g, op.nodeId);
    const criticality = oneOf(ctx, CRITICALITIES, op.criticality, 'criticality');
    checkExpect(ctx, op.expect, node, `Asset ${q(node.name)}`);
    if (node.criticality === criticality) ctx.bad(`Asset ${q(node.name)} is already ${criticality}.`);
    const prev = node.criticality;
    node.criticality = criticality;
    return {
      op: { type: 'set_criticality', nodeId: node.id, criticality },
      inverse: [{ type: 'set_criticality', nodeId: node.id, criticality: prev, expect: { criticality } }],
      description: `Change criticality of ${q(node.name)} from ${prev} to ${criticality}`,
    };
  },

  move_node(ctx, g, op) {
    const node = findNode(ctx, g, op.nodeId);
    const pos = position(ctx, op.x, op.y);
    if ((node.x ?? null) === pos.x && (node.y ?? null) === pos.y) ctx.bad(`Asset ${q(node.name)} is already there.`);
    const prev = { x: node.x ?? null, y: node.y ?? null };
    node.x = pos.x;
    node.y = pos.y;
    return {
      op: { type: 'move_node', nodeId: node.id, x: pos.x, y: pos.y },
      inverse: [{ type: 'move_node', nodeId: node.id, x: prev.x, y: prev.y }],
      description: pos.x === null ? `Release pinned position of ${q(node.name)}` : `Move asset ${q(node.name)}`,
    };
  },

  add_dependency(ctx, g, op) {
    if (!isObj(op.dependency)) ctx.bad('dependency is required.');
    const d = op.dependency;
    const id = d.id === undefined ? newId('dp') : text(ctx, d.id, 'dependency.id', 80, { required: true });
    if (g.dependencies.some((x) => x.id === id)) ctx.state(`A dependency with id "${id}" already exists.`);
    const dependent = findNode(ctx, g, d.dependentId, 'dependency.dependentId');
    const provider = findNode(ctx, g, d.providerId, 'dependency.providerId');
    if (dependent.id === provider.id) ctx.bad('An asset cannot depend on itself.');
    if (g.dependencies.some((x) => x.dependentId === dependent.id && x.providerId === provider.id)) {
      ctx.state(`${q(dependent.name)} already relies on ${q(provider.name)}.`);
    }
    const dep = {
      id,
      dependentId: dependent.id,
      providerId: provider.id,
      mode: oneOf(ctx, MODES, d.mode, 'dependency.mode'),
      status: oneOf(ctx, LINK_STATUSES, d.status, 'dependency.status'),
      relation: oneOf(ctx, RELATIONS, d.relation, 'dependency.relation'),
      notes: text(ctx, d.notes, 'dependency.notes', 300),
    };
    g.dependencies.push(dep);
    return {
      op: { type: 'add_dependency', dependency: { ...dep } },
      inverse: [{ type: 'remove_dependency', dependencyId: id }],
      description: `Add dependency: ${q(dependent.name)} relies on ${q(provider.name)} (${dep.mode}, ${dep.status})`,
    };
  },

  remove_dependency(ctx, g, op) {
    const dep = findDep(ctx, g, op.dependencyId);
    const label = `${q(nameOf(g, dep.dependentId))} no longer relies on ${q(nameOf(g, dep.providerId))}`;
    g.dependencies = g.dependencies.filter((x) => x.id !== dep.id);
    return {
      op: { type: 'remove_dependency', dependencyId: dep.id },
      inverse: [{ type: 'add_dependency', dependency: { ...dep } }],
      description: `Remove dependency: ${label}`,
    };
  },

  modify_dependency(ctx, g, op) {
    const dep = findDep(ctx, g, op.dependencyId);
    if (!isObj(op.changes) || !Object.keys(op.changes).length) ctx.bad('changes must name at least one field.');
    rejectUnknownKeys(ctx, op.changes, ['status', 'relation', 'notes'], 'changes', {
      mode: 'Use the set_dependency_mode operation to switch between required and alternate.',
      providerId: 'Use the replace_provider operation to change the provider.',
      dependentId: 'Remove the dependency and add a new one to change the dependent asset.',
      id: 'A dependency id cannot be changed.',
    });
    checkExpect(ctx, op.expect, dep, 'The dependency');
    const next = {};
    if (has(op.changes, 'status')) next.status = oneOf(ctx, LINK_STATUSES, op.changes.status, 'changes.status');
    if (has(op.changes, 'relation')) next.relation = oneOf(ctx, RELATIONS, op.changes.relation, 'changes.relation');
    if (has(op.changes, 'notes')) next.notes = text(ctx, op.changes.notes, 'changes.notes', 300);
    const changes = {};
    const before = {};
    for (const [k, v] of Object.entries(next)) {
      if (dep[k] !== v) {
        before[k] = dep[k];
        changes[k] = v;
      }
    }
    const label = `${q(nameOf(g, dep.dependentId))} → ${q(nameOf(g, dep.providerId))}`;
    if (!Object.keys(changes).length) ctx.bad(`Dependency ${label} already has those values; there is nothing to change.`);
    Object.assign(dep, changes);
    const parts = Object.keys(changes).map((k) => (k === 'notes' ? 'notes' : `${k} ${before[k]} → ${changes[k]}`));
    return {
      op: { type: 'modify_dependency', dependencyId: dep.id, changes },
      inverse: [{ type: 'modify_dependency', dependencyId: dep.id, changes: before, expect: changes }],
      description: `Edit dependency ${label}: ${parts.join(', ')}`,
    };
  },

  replace_provider(ctx, g, op) {
    const dep = findDep(ctx, g, op.dependencyId);
    const provider = findNode(ctx, g, op.providerId, 'providerId');
    checkExpect(ctx, op.expect, dep, 'The dependency');
    if (provider.id === dep.providerId) ctx.bad(`${q(provider.name)} is already the provider.`);
    if (provider.id === dep.dependentId) ctx.bad('An asset cannot depend on itself.');
    if (g.dependencies.some((x) => x.id !== dep.id && x.dependentId === dep.dependentId && x.providerId === provider.id)) {
      ctx.state(`${q(nameOf(g, dep.dependentId))} already relies on ${q(provider.name)}.`);
    }
    const prev = dep.providerId;
    dep.providerId = provider.id;
    return {
      op: { type: 'replace_provider', dependencyId: dep.id, providerId: provider.id },
      inverse: [{ type: 'replace_provider', dependencyId: dep.id, providerId: prev, expect: { providerId: provider.id } }],
      description: `Replace provider of ${q(nameOf(g, dep.dependentId))}: ${q(nameOf(g, prev))} → ${q(provider.name)}`,
    };
  },

  set_dependency_mode(ctx, g, op) {
    const dep = findDep(ctx, g, op.dependencyId);
    const mode = oneOf(ctx, MODES, op.mode, 'mode');
    checkExpect(ctx, op.expect, dep, 'The dependency');
    const label = `${q(nameOf(g, dep.dependentId))} → ${q(nameOf(g, dep.providerId))}`;
    if (dep.mode === mode) ctx.bad(`Dependency ${label} is already ${mode}.`);
    const prev = dep.mode;
    dep.mode = mode;
    return {
      op: { type: 'set_dependency_mode', dependencyId: dep.id, mode },
      inverse: [{ type: 'set_dependency_mode', dependencyId: dep.id, mode: prev, expect: { mode } }],
      description:
        mode === 'alternate'
          ? `Make dependency ${label} an alternate: ${q(nameOf(g, dep.dependentId))} now fails only if all its alternates fail`
          : `Make dependency ${label} required: ${q(nameOf(g, dep.dependentId))} now fails whenever ${q(nameOf(g, dep.providerId))} fails`,
    };
  },
};

/**
 * Applies one operation to `graph` in place (callers pass a clone). Returns the normalised operation, the operations
 * that undo it, and a human-readable description. Throws HttpError when the operation is invalid.
 */
export function applyOp(graph, rawOp, { strict = false } = {}) {
  const ctx = new Ctx(strict);
  if (!isObj(rawOp)) ctx.bad('Each operation must be an object with a type.');
  const type = rawOp.type;
  if (typeof type !== 'string') ctx.bad(`Operation type is required. Supported types: ${Object.keys(HANDLERS).join(', ')}.`);
  if (has(UNSUPPORTED_PATCH_TYPES, type)) {
    ctx.bad(
      `"${type}" is not supported: GhostGrid's failure model has no ${UNSUPPORTED_PATCH_TYPES[type]} setting, so changing it could not affect any simulation. ` +
        `Supported behavioural change: set_dependency_mode (required or alternate).`,
    );
  }
  if (!has(HANDLERS, type)) ctx.bad(`Unknown operation type "${type}". Supported types: ${Object.keys(HANDLERS).join(', ')}.`);
  const result = HANDLERS[type](ctx, graph, rawOp);
  const check = validateGraph(graph);
  if (!check.ok) ctx.bad(`The change would make the graph invalid: ${check.errors[0]}`);
  return { ...result, category: CATEGORY[type] };
}

/**
 * Applies a list of operations in order on a copy of `graph`; nothing is returned half-applied.
 * @returns {{ graph: object, results: { op: object, inverse: object[], description: string, category: string }[] }}
 */
export function applyOps(graph, ops, { strict = false } = {}) {
  const work = cloneGraph(graph);
  const results = [];
  ops.forEach((raw, i) => {
    try {
      results.push(applyOp(work, raw, { strict }));
    } catch (err) {
      if (err instanceof HttpError && ops.length > 1) throw new HttpError(err.status, `Operation ${i + 1}: ${err.message}`, err.details);
      throw err;
    }
  });
  return { graph: work, results };
}

/* ------------------------------------------------------------------- diff */

/**
 * Operations that turn `from` into `to`, ordered so each is valid when applied in sequence. With `expect`, modify
 * operations carry the values they expect to find, so applying them to a graph that has since moved on is a conflict.
 * Positions are included as move_node operations.
 */
export function diffGraphs(from, to, { expect = false } = {}) {
  const ops = [];
  const fa = new Map(from.assets.map((a) => [a.id, a]));
  const ta = new Map(to.assets.map((a) => [a.id, a]));
  const fd = new Map(from.dependencies.map((d) => [d.id, d]));
  const td = new Map(to.dependencies.map((d) => [d.id, d]));
  const sortedIds = (m) => [...m.keys()].sort();

  const endpointsChanged = (a, b) => a.dependentId !== b.dependentId || a.providerId !== b.providerId;
  const depsToRemove = sortedIds(fd).filter((id) => !td.has(id) || endpointsChanged(fd.get(id), td.get(id)));
  for (const id of depsToRemove) ops.push({ type: 'remove_dependency', dependencyId: id });

  for (const id of sortedIds(fa)) if (!ta.has(id)) ops.push({ type: 'delete_node', nodeId: id });
  // Deleting a node also deletes dependencies on it; those are already covered above (or are not present in `to`).

  for (const id of sortedIds(ta)) if (!fa.has(id)) ops.push({ type: 'add_node', node: { ...canonAsset(ta.get(id)) } });

  for (const id of sortedIds(ta)) {
    const a = fa.get(id);
    const b = ta.get(id);
    if (!a) continue;
    const changes = {};
    for (const k of ['name', 'kind', 'notes']) if ((a[k] ?? '') !== (b[k] ?? '')) changes[k] = b[k] ?? '';
    if (Object.keys(changes).length) {
      const op = { type: 'modify_node', nodeId: id, changes };
      if (expect) op.expect = Object.fromEntries(Object.keys(changes).map((k) => [k, a[k] ?? '']));
      ops.push(op);
    }
    if (a.criticality !== b.criticality) {
      const op = { type: 'set_criticality', nodeId: id, criticality: b.criticality };
      if (expect) op.expect = { criticality: a.criticality };
      ops.push(op);
    }
  }
  // Renames can collide transiently (swapping two names); if so the caller's validation reports it clearly.
  for (const id of sortedIds(ta)) {
    const a = fa.get(id);
    const b = ta.get(id);
    if (!a) continue;
    const ca = canonAsset(a);
    const cb = canonAsset(b);
    if (ca.x !== cb.x || ca.y !== cb.y) ops.push({ type: 'move_node', nodeId: id, x: cb.x, y: cb.y });
  }

  for (const id of sortedIds(td)) {
    const b = td.get(id);
    const a = fd.get(id);
    if (!a || endpointsChanged(a, b)) {
      ops.push({ type: 'add_dependency', dependency: { ...canonDep(b) } });
      continue;
    }
    const changes = {};
    for (const k of ['status', 'relation', 'notes']) if ((a[k] ?? '') !== (b[k] ?? '')) changes[k] = b[k] ?? '';
    if (Object.keys(changes).length) {
      const op = { type: 'modify_dependency', dependencyId: id, changes };
      if (expect) op.expect = Object.fromEntries(Object.keys(changes).map((k) => [k, a[k] ?? '']));
      ops.push(op);
    }
    if (a.mode !== b.mode) {
      const op = { type: 'set_dependency_mode', dependencyId: id, mode: b.mode };
      if (expect) op.expect = { mode: a.mode };
      ops.push(op);
    }
  }
  return ops;
}

/* ---------------------------------------------------------------- summary */

/**
 * Change summary for a list of applied operations: counts plus short readable lines. Layout moves are folded into
 * one line because they do not change simulation results.
 * @param {{ op: object, inverse: object[], description: string, category: string }[]} results
 */
export function summarizeResults(results) {
  const s = { nodesAdded: 0, nodesRemoved: 0, nodesModified: 0, depsAdded: 0, depsRemoved: 0, depsModified: 0, behavioural: 0, moved: 0, lines: [] };
  const touchedNodes = new Set();
  const touchedDeps = new Set();
  const moved = new Set();
  for (const r of results) {
    const t = r.op.type;
    if (t === 'add_node') s.nodesAdded++;
    else if (t === 'delete_node') {
      s.nodesRemoved++;
      s.depsRemoved += r.inverse.filter((i) => i.type === 'add_dependency').length;
    } else if (t === 'modify_node' || t === 'set_criticality') touchedNodes.add(r.op.nodeId);
    else if (t === 'move_node') moved.add(r.op.nodeId);
    else if (t === 'add_dependency') s.depsAdded++;
    else if (t === 'remove_dependency') s.depsRemoved++;
    else touchedDeps.add(r.op.dependencyId);
    if (r.category === 'behavioural') s.behavioural++;
    if (t !== 'move_node') s.lines.push(r.description);
  }
  s.nodesModified = touchedNodes.size;
  s.depsModified = touchedDeps.size;
  s.moved = moved.size;
  if (moved.size) s.lines.push(`Moved ${moved.size} asset${moved.size === 1 ? '' : 's'} on the canvas`);
  const MAX = 25;
  if (s.lines.length > MAX) {
    const extra = s.lines.length - MAX;
    s.lines = [...s.lines.slice(0, MAX), `…and ${extra} more change${extra === 1 ? '' : 's'}`];
  }
  return s;
}

export function baselineSummary(graph) {
  return {
    nodesAdded: graph.assets.length,
    nodesRemoved: 0,
    nodesModified: 0,
    depsAdded: graph.dependencies.length,
    depsRemoved: 0,
    depsModified: 0,
    behavioural: 0,
    moved: 0,
    lines: [`Baseline of ${graph.assets.length} asset${graph.assets.length === 1 ? '' : 's'} and ${graph.dependencies.length} dependenc${graph.dependencies.length === 1 ? 'y' : 'ies'}`],
  };
}

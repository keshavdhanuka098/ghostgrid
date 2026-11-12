// Structural validation for scenario documents and report snapshots.
// The database enforces the same rules again (CHECK constraints and foreign keys), so this layer exists to give
// clear, field-level error messages rather than to be the only line of defence.

export const ASSET_KINDS = ['power', 'network', 'compute', 'data', 'water', 'transport', 'service', 'other'];
export const CRITICALITIES = ['low', 'medium', 'high', 'critical'];
export const MODES = ['required', 'alternate'];
export const LINK_STATUSES = ['confirmed', 'inferred', 'unknown'];
export const RELATIONS = ['power', 'data', 'network', 'control', 'physical', 'service', 'other'];
export const CONFIDENCES = ['low', 'medium', 'high'];
export const TARGET_TYPES = ['scenario', 'node', 'link'];
export const MITIGATION_KINDS = ['backup', 'decouple'];
export const ESTIMATE_LEVELS = ['low', 'medium', 'high'];
export const LIMITS = { assets: 300, dependencies: 1500, runs: 100, strategies: 100, assumptions: 300, reports: 200 };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const oneOf = (list, v, fallback) => (list.includes(v) ? v : fallback);
const coord = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100000 ? Math.round(v * 10) / 10 : null);

/**
 * Validates the graph part of a document (assets and dependencies). Shared by scenario saves and Graph Git
 * (snapshots and patched graphs), so there is exactly one definition of what a valid graph is.
 * Pushes messages onto `errors` and returns the normalised graph plus the id sets other sections validate against.
 */
function validateGraphParts(rawAssets, rawDeps, options, errors) {
  if (rawAssets.length > LIMITS.assets) errors.push(`At most ${LIMITS.assets} assets per scenario.`);
  if (rawDeps.length > LIMITS.dependencies) errors.push(`At most ${LIMITS.dependencies} dependencies per scenario.`);

  const assets = [];
  const assetIds = new Set();
  const assetNames = new Set();
  rawAssets.forEach((a, i) => {
    if (!isObj(a)) return errors.push(`assets[${i}] must be an object.`);
    const aid = str(a.id, 80);
    const aname = str(a.name, 60);
    if (!aid || !aname) return errors.push(`assets[${i}] needs an id and a name.`);
    if (assetIds.has(aid)) return errors.push(`Duplicate asset id "${aid}".`);
    if (assetNames.has(aname.toLowerCase())) return errors.push(`Duplicate asset name "${aname}".`);
    if (!ASSET_KINDS.includes(a.kind)) return errors.push(`assets[${i}].kind is not valid.`);
    if (!CRITICALITIES.includes(a.criticality)) return errors.push(`assets[${i}].criticality is not valid.`);
    if (typeof a.notes === 'string' && a.notes.length > 200) return errors.push(`assets[${i}].notes must be 200 characters or fewer.`);
    assetIds.add(aid);
    assetNames.add(aname.toLowerCase());
    const x = coord(a.x);
    const y = coord(a.y);
    assets.push({ id: aid, name: aname, kind: a.kind, criticality: a.criticality, notes: str(a.notes, 200), x: x !== null && y !== null ? x : null, y: x !== null && y !== null ? y : null });
  });

  const dependencies = [];
  const depIds = new Set();
  const pairs = new Set();
  rawDeps.forEach((d, i) => {
    if (!isObj(d)) return errors.push(`dependencies[${i}] must be an object.`);
    const did = str(d.id, 80);
    if (!did || depIds.has(did)) return errors.push(`dependencies[${i}] needs a unique id.`);
    if (!assetIds.has(d.dependentId) || !assetIds.has(d.providerId)) return errors.push(`dependencies[${i}] references an unknown asset.`);
    if (d.dependentId === d.providerId) return errors.push(`dependencies[${i}] cannot depend on itself.`);
    if (!MODES.includes(d.mode)) return errors.push(`dependencies[${i}].mode is not valid.`);
    const status = d.status === undefined && options.legacy ? 'confirmed' : d.status;
    const relation = d.relation === undefined && options.legacy ? 'other' : d.relation;
    if (!LINK_STATUSES.includes(status)) return errors.push(`dependencies[${i}].status must be confirmed, inferred or unknown.`);
    if (!RELATIONS.includes(relation)) return errors.push(`dependencies[${i}].relation is not valid.`);
    if (typeof d.notes === 'string' && d.notes.length > 300) return errors.push(`dependencies[${i}].notes must be 300 characters or fewer.`);
    const pair = `${d.dependentId}>${d.providerId}`;
    if (pairs.has(pair)) return errors.push(`dependencies[${i}] duplicates another dependency.`);
    depIds.add(did);
    pairs.add(pair);
    dependencies.push({ id: did, dependentId: d.dependentId, providerId: d.providerId, mode: d.mode, status, relation, notes: str(d.notes, 300) });
  });
  return { assets, dependencies, assetIds, depIds };
}

/**
 * @param {unknown} input
 * @param {{ legacy?: boolean }} [options] legacy: accept Part 1 documents that lack the newer fields.
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
export function validateScenario(input, options = {}) {
  const errors = [];
  if (!isObj(input)) return { ok: false, errors: ['Body must be a JSON object.'] };

  const id = str(input.id, 80);
  const name = str(input.name, 80);
  if (!id) errors.push('id is required.');
  if (!name) errors.push('name is required.');
  if (typeof input.description === 'string' && input.description.length > 300) errors.push('description must be 300 characters or fewer.');

  const rawAssets = Array.isArray(input.assets) ? input.assets : null;
  const rawDeps = Array.isArray(input.dependencies) ? input.dependencies : null;
  if (!rawAssets) errors.push('assets must be an array.');
  if (!rawDeps) errors.push('dependencies must be an array.');
  if (errors.length) return { ok: false, errors };

  const { assets, dependencies, assetIds, depIds } = validateGraphParts(rawAssets, rawDeps, options, errors);

  const rawRuns = Array.isArray(input.runs) ? input.runs : [];
  if (rawRuns.length > LIMITS.runs) errors.push(`At most ${LIMITS.runs} saved runs per scenario.`);
  const runs = [];
  const runIds = new Set();
  rawRuns.forEach((r, i) => {
    if (!isObj(r) || !str(r.id, 80) || !str(r.name, 80) || !Array.isArray(r.failedIds)) return errors.push(`runs[${i}] is not valid.`);
    if (runIds.has(str(r.id, 80))) return errors.push(`Duplicate run id at runs[${i}].`);
    if (r.failedLinkIds !== undefined && !Array.isArray(r.failedLinkIds)) return errors.push(`runs[${i}].failedLinkIds must be an array.`);
    const failedIds = r.failedIds.filter((x) => assetIds.has(x));
    const failedLinkIds = (r.failedLinkIds ?? []).filter((x) => depIds.has(x));
    if (!failedIds.length && !failedLinkIds.length) return errors.push(`runs[${i}] must reference at least one known asset or dependency.`);
    runIds.add(str(r.id, 80));
    runs.push({
      id: str(r.id, 80),
      name: str(r.name, 80),
      failedIds: [...new Set(failedIds)],
      failedLinkIds: [...new Set(failedLinkIds)],
      createdAt: str(r.createdAt, 40) || new Date().toISOString(),
    });
  });

  const rawStrategies = Array.isArray(input.strategies) ? input.strategies : [];
  if (rawStrategies.length > LIMITS.strategies) errors.push(`At most ${LIMITS.strategies} strategies per scenario.`);
  const strategies = [];
  const stratIds = new Set();
  rawStrategies.forEach((s, i) => {
    if (!isObj(s) || !str(s.id, 80) || !str(s.name, 80)) return errors.push(`strategies[${i}] is not valid.`);
    if (stratIds.has(str(s.id, 80))) return errors.push(`Duplicate strategy id at strategies[${i}].`);
    const kind = s.kind === undefined ? 'backup' : s.kind;
    if (!MITIGATION_KINDS.includes(kind)) return errors.push(`strategies[${i}].kind must be backup or decouple.`);
    if (!assetIds.has(s.dependentId) || !assetIds.has(s.providerId)) return errors.push(`strategies[${i}] references an unknown asset.`);
    if (kind === 'backup' && !assetIds.has(s.backupId)) return errors.push(`strategies[${i}] needs a known backup asset.`);
    const level = (v, field) => {
      if (v === undefined || v === null || v === '') return null;
      if (!ESTIMATE_LEVELS.includes(v)) {
        errors.push(`strategies[${i}].${field} must be low, medium, high or empty.`);
        return null;
      }
      return v;
    };
    const costLevel = level(s.costLevel, 'costLevel');
    const effortLevel = level(s.effortLevel, 'effortLevel');
    stratIds.add(str(s.id, 80));
    strategies.push({
      id: str(s.id, 80),
      name: str(s.name, 80),
      kind,
      dependentId: s.dependentId,
      providerId: s.providerId,
      backupId: kind === 'backup' ? s.backupId : '',
      notes: str(s.notes, 300),
      costLevel,
      effortLevel,
    });
  });

  const rawAssumptions = Array.isArray(input.assumptions) ? input.assumptions : [];
  if (rawAssumptions.length > LIMITS.assumptions) errors.push(`At most ${LIMITS.assumptions} assumptions per scenario.`);
  const assumptions = [];
  const assumptionIds = new Set();
  rawAssumptions.forEach((a, i) => {
    if (!isObj(a) || !str(a.id, 80)) return errors.push(`assumptions[${i}] needs an id.`);
    const text = str(a.text, 400);
    if (!text) return errors.push(`assumptions[${i}] needs text.`);
    if (assumptionIds.has(str(a.id, 80))) return errors.push(`Duplicate assumption id at assumptions[${i}].`);
    const targetType = oneOf(TARGET_TYPES, a.targetType, 'scenario');
    let targetId = null;
    if (targetType === 'node') {
      if (!assetIds.has(a.targetId)) return errors.push(`assumptions[${i}] references an unknown asset.`);
      targetId = a.targetId;
    } else if (targetType === 'link') {
      if (!depIds.has(a.targetId)) return errors.push(`assumptions[${i}] references an unknown dependency.`);
      targetId = a.targetId;
    }
    assumptionIds.add(str(a.id, 80));
    assumptions.push({ id: str(a.id, 80), text, targetType, targetId, confidence: oneOf(CONFIDENCES, a.confidence, 'medium'), createdAt: str(a.createdAt, 40) || new Date().toISOString() });
  });

  if (errors.length) return { ok: false, errors };

  const now = new Date().toISOString();
  return {
    ok: true,
    value: {
      id,
      name,
      description: str(input.description, 300),
      sector: str(input.sector, 60) || 'Mixed / regional',
      createdAt: str(input.createdAt, 40) || now,
      updatedAt: str(input.updatedAt, 40) || now,
      assets,
      dependencies,
      runs,
      strategies,
      assumptions,
    },
  };
}

const BLOCK_TYPES = new Set(['h', 'p', 'ul', 'table']);

/** Validates a saved report snapshot. Content is a list of display blocks produced by the client. */
export function validateReport(input) {
  const errors = [];
  if (!isObj(input)) return { ok: false, errors: ['Body must be a JSON object.'] };
  const title = str(input.title, 120);
  if (!title) errors.push('title is required.');
  if (!Array.isArray(input.content) || input.content.length === 0) errors.push('content must be a non-empty array of blocks.');
  else if (input.content.length > 2000) errors.push('content has too many blocks.');
  else {
    input.content.forEach((b, i) => {
      if (!isObj(b) || !BLOCK_TYPES.has(b.t)) return errors.push(`content[${i}] has an unknown block type.`);
      if (b.t === 'h' && (typeof b.text !== 'string' || ![1, 2, 3].includes(b.level))) errors.push(`content[${i}] heading is not valid.`);
      if (b.t === 'p' && typeof b.text !== 'string') errors.push(`content[${i}] paragraph is not valid.`);
      if (b.t === 'ul' && !(Array.isArray(b.items) && b.items.every((x) => typeof x === 'string'))) errors.push(`content[${i}] list is not valid.`);
      if (b.t === 'table' && !(Array.isArray(b.head) && Array.isArray(b.rows) && b.rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === 'string')))) errors.push(`content[${i}] table is not valid.`);
    });
  }
  const options = isObj(input.options) ? input.options : {};
  if (errors.length) return { ok: false, errors: errors.slice(0, 5) };
  const content = JSON.stringify(input.content);
  if (content.length > 1_000_000) return { ok: false, errors: ['Report is too large to save.'] };
  return { ok: true, value: { title, options: JSON.stringify(options).slice(0, 4000), content } };
}

/**
 * Validates a bare graph ({ assets, dependencies }) with the same rules as a scenario document.
 * @returns {{ ok: true, value: { assets: object[], dependencies: object[] } } | { ok: false, errors: string[] }}
 */
export function validateGraph(input) {
  if (!isObj(input) || !Array.isArray(input.assets) || !Array.isArray(input.dependencies)) {
    return { ok: false, errors: ['Graph must have assets and dependencies arrays.'] };
  }
  const errors = [];
  const { assets, dependencies } = validateGraphParts(input.assets, input.dependencies, {}, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: { assets, dependencies } };
}

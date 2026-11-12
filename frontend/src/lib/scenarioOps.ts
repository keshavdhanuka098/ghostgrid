import { uid } from './id';
import type { Asset, Assumption, Confidence, Dependency, Scenario, SavedRun, Strategy } from './types';

export function newScenario(input: { name: string; description: string; sector: string }): Scenario {
  const now = new Date().toISOString();
  return {
    id: uid('sc'),
    name: input.name.trim(),
    description: input.description.trim(),
    sector: input.sector,
    sampleKey: null,
    isSample: false,
    createdAt: now,
    updatedAt: now,
    assets: [],
    dependencies: [],
    runs: [],
    strategies: [],
    assumptions: [],
  };
}

/** Fills fields added after the first release, so older documents behave like new ones. The server does the same on load. */
export function normalizeScenario(s: Scenario): Scenario {
  return {
    ...s,
    runs: s.runs.map((r): SavedRun => ({ ...r, failedLinkIds: r.failedLinkIds ?? [] })),
    strategies: s.strategies.map((m): Strategy => ({ ...m, kind: m.kind ?? 'backup', backupId: m.backupId ?? '', costLevel: m.costLevel ?? null, effortLevel: m.effortLevel ?? null })),
  };
}

/* ---------------------------------------------------------------- assets */

export type AssetInput = Omit<Asset, 'id' | 'x' | 'y'>;

export function addAsset(s: Scenario, input: AssetInput, position?: { x: number; y: number }): { scenario: Scenario; asset: Asset } {
  const asset: Asset = {
    ...input,
    id: uid('as'),
    name: input.name.trim(),
    notes: input.notes.trim(),
    x: position ? Math.round(position.x) : null,
    y: position ? Math.round(position.y) : null,
  };
  return { scenario: { ...s, assets: [...s.assets, asset] }, asset };
}

/** Updates an asset's details. Its pinned position is kept. */
export function updateAsset(s: Scenario, id: string, input: AssetInput): Scenario {
  return {
    ...s,
    assets: s.assets.map((x) => (x.id === id ? { ...x, ...input, name: input.name.trim(), notes: input.notes.trim() } : x)),
  };
}

export function setAssetPosition(s: Scenario, id: string, x: number, y: number): Scenario {
  return { ...s, assets: s.assets.map((a) => (a.id === id ? { ...a, x: Math.round(x), y: Math.round(y) } : a)) };
}

/** Releases every pinned position so the automatic layout takes over again. */
export function clearPositions(s: Scenario): Scenario {
  return { ...s, assets: s.assets.map((a) => ({ ...a, x: null, y: null })) };
}

/** What removing an asset would take with it, for the confirmation message. */
export function removalImpact(s: Scenario, id: string) {
  const depIds = new Set(s.dependencies.filter((d) => d.dependentId === id || d.providerId === id).map((d) => d.id));
  return {
    dependencies: depIds.size,
    strategies: s.strategies.filter((m) => [m.dependentId, m.providerId, m.backupId].includes(id)).length,
    runs: s.runs.filter((r) => r.failedIds.includes(id) || r.failedLinkIds.some((l) => depIds.has(l))).length,
    assumptions: s.assumptions.filter(
      (a) => (a.targetType === 'node' && a.targetId === id) || (a.targetType === 'link' && a.targetId !== null && depIds.has(a.targetId)),
    ).length,
  };
}

/** Removes the asset and cleans everything that referenced it. Runs left with no failed assets are dropped. */
export function removeAsset(s: Scenario, id: string): Scenario {
  const depIds = new Set(s.dependencies.filter((d) => d.dependentId === id || d.providerId === id).map((d) => d.id));
  return {
    ...s,
    assets: s.assets.filter((x) => x.id !== id),
    dependencies: s.dependencies.filter((d) => !depIds.has(d.id)),
    strategies: s.strategies.filter((m) => ![m.dependentId, m.providerId, m.backupId].includes(id)),
    runs: s.runs
      .map((r) => ({ ...r, failedIds: r.failedIds.filter((f) => f !== id), failedLinkIds: r.failedLinkIds.filter((l) => !depIds.has(l)) }))
      .filter((r) => r.failedIds.length + r.failedLinkIds.length > 0),
    assumptions: s.assumptions.filter(
      (a) => !((a.targetType === 'node' && a.targetId === id) || (a.targetType === 'link' && a.targetId !== null && depIds.has(a.targetId))),
    ),
  };
}

/* ----------------------------------------------------------- dependencies */

export type DependencyInput = Omit<Dependency, 'id'>;

export function addDependency(s: Scenario, input: DependencyInput): { scenario: Scenario; dependency: Dependency } {
  const dependency: Dependency = { ...input, id: uid('dp'), notes: input.notes.trim() };
  return { scenario: { ...s, dependencies: [...s.dependencies, dependency] }, dependency };
}

/**
 * Edits a dependency. Changing its endpoints can orphan a mitigation that was anchored on the old pair, so those are dropped.
 */
/** Marks a dependency as verified. It then counts as confirmed in every analysis. */
export function confirmDependency(s: Scenario, id: string): Scenario {
  return { ...s, dependencies: s.dependencies.map((d) => (d.id === id ? { ...d, status: 'confirmed' } : d)) };
}

export function updateDependency(s: Scenario, id: string, input: DependencyInput): Scenario {
  const old = s.dependencies.find((d) => d.id === id);
  if (!old) return s;
  const moved = old.dependentId !== input.dependentId || old.providerId !== input.providerId;
  return {
    ...s,
    dependencies: s.dependencies.map((d) => (d.id === id ? { ...d, ...input, notes: input.notes.trim() } : d)),
    strategies: moved ? s.strategies.filter((m) => !(m.dependentId === old.dependentId && m.providerId === old.providerId)) : s.strategies,
  };
}

export function removeDependency(s: Scenario, id: string): Scenario {
  const dep = s.dependencies.find((d) => d.id === id);
  return {
    ...s,
    dependencies: s.dependencies.filter((d) => d.id !== id),
    // A strategy is anchored on one dependency, and assumptions can be about one; drop the ones that lose it.
    strategies: dep ? s.strategies.filter((m) => !(m.dependentId === dep.dependentId && m.providerId === dep.providerId)) : s.strategies,
    runs: s.runs
      .map((r) => ({ ...r, failedLinkIds: r.failedLinkIds.filter((l) => l !== id) }))
      .filter((r) => r.failedIds.length + r.failedLinkIds.length > 0),
    assumptions: s.assumptions.filter((a) => !(a.targetType === 'link' && a.targetId === id)),
  };
}

/* ------------------------------------------------------------ assumptions */

export type AssumptionInput = Pick<Assumption, 'text' | 'targetType' | 'targetId' | 'confidence'>;

export function addAssumption(s: Scenario, input: AssumptionInput): Scenario {
  const a: Assumption = {
    id: uid('as'),
    text: input.text.trim(),
    targetType: input.targetType,
    targetId: input.targetType === 'scenario' ? null : input.targetId,
    confidence: input.confidence,
    createdAt: new Date().toISOString(),
  };
  return { ...s, assumptions: [...s.assumptions, a] };
}

export function updateAssumption(s: Scenario, id: string, input: AssumptionInput): Scenario {
  return {
    ...s,
    assumptions: s.assumptions.map((a) =>
      a.id === id ? { ...a, text: input.text.trim(), targetType: input.targetType, targetId: input.targetType === 'scenario' ? null : input.targetId, confidence: input.confidence } : a,
    ),
  };
}

export function removeAssumption(s: Scenario, id: string): Scenario {
  return { ...s, assumptions: s.assumptions.filter((a) => a.id !== id) };
}

export const assumptionsFor = (s: Scenario, type: 'node' | 'link', id: string) =>
  s.assumptions.filter((a) => a.targetType === type && a.targetId === id);

/** Human label for what an assumption is about. */
export function assumptionTargetLabel(s: Scenario, a: Assumption): string {
  if (a.targetType === 'scenario') return 'Whole scenario';
  if (a.targetType === 'node') return s.assets.find((x) => x.id === a.targetId)?.name ?? 'Unknown asset';
  const d = s.dependencies.find((x) => x.id === a.targetId);
  const name = (id: string) => s.assets.find((x) => x.id === id)?.name ?? 'Unknown';
  return d ? `${name(d.dependentId)} relies on ${name(d.providerId)}` : 'Unknown dependency';
}

/* ------------------------------------------------------------ validation */

export type Errors<K extends string> = Partial<Record<K, string>>;

export function validateScenarioDetails(
  v: { name: string; description: string },
  others: Scenario[],
  selfId?: string,
): Errors<'name' | 'description'> {
  const e: Errors<'name' | 'description'> = {};
  const name = v.name.trim();
  if (!name) e.name = 'Give the scenario a name.';
  else if (name.length > 80) e.name = 'Keep the name under 80 characters.';
  else if (others.some((o) => o.id !== selfId && o.name.trim().toLowerCase() === name.toLowerCase())) e.name = 'Another scenario already uses this name.';
  if (v.description.length > 300) e.description = 'Keep the description under 300 characters.';
  return e;
}

export function validateAsset(v: { name: string; notes: string }, s: Scenario, selfId?: string): Errors<'name' | 'notes'> {
  const e: Errors<'name' | 'notes'> = {};
  const name = v.name.trim();
  if (!name) e.name = 'Give the asset a name.';
  else if (name.length > 60) e.name = 'Keep the name under 60 characters.';
  else if (s.assets.some((x) => x.id !== selfId && x.name.trim().toLowerCase() === name.toLowerCase()))
    e.name = 'An asset with this name already exists in the scenario.';
  if (v.notes.length > 200) e.notes = 'Keep notes under 200 characters.';
  return e;
}

export function validateDependency(
  v: { dependentId: string; providerId: string; notes: string },
  s: Scenario,
  selfId?: string,
): Errors<'dependentId' | 'providerId' | 'notes'> {
  const e: Errors<'dependentId' | 'providerId' | 'notes'> = {};
  if (!v.providerId) e.providerId = 'Choose the asset that is relied on.';
  if (!v.dependentId) e.dependentId = 'Choose the asset that relies on it.';
  if (v.dependentId && v.providerId) {
    if (v.dependentId === v.providerId) e.providerId = 'An asset cannot depend on itself.';
    else if (s.dependencies.some((d) => d.id !== selfId && d.dependentId === v.dependentId && d.providerId === v.providerId))
      e.providerId = 'This dependency is already mapped.';
  }
  if (v.notes.length > 300) e.notes = 'Keep notes under 300 characters.';
  return e;
}

export function validateAssumption(v: { text: string }): Errors<'text'> {
  const e: Errors<'text'> = {};
  const t = v.text.trim();
  if (!t) e.text = 'Write the assumption.';
  else if (t.length > 400) e.text = 'Keep it under 400 characters.';
  return e;
}

export const CONFIDENCE_ORDER: Confidence[] = ['high', 'medium', 'low'];

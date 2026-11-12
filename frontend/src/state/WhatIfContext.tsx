import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Hypothesis } from '../lib/analysis';
import { readStore, writeStore } from '../lib/storage';
import { uid } from '../lib/id';
import { applyChanges, changedAssetIds, changedLinkIds, cleanChanges, countChanges, emptyChanges, WHATIF_PREFIX, type AssetChange, type WhatIfChanges } from '../lib/whatif';
import type { Asset, Dependency, Scenario } from '../lib/types';

/**
 * Browser-side what-if state. Hypothetical changes to assets and dependency links live here (localStorage, per scenario)
 * and are never written to the scenario or the server. Every analysis page reads the same state through useWhatIf.
 */
interface Stored extends WhatIfChanges {
  on: boolean;
}
type Store = Record<string, Stored>;
const KEY = 'ghostgrid.whatif.v1';
const blank = (): Stored => ({ on: false, ...emptyChanges() });

function load(): Store {
  try {
    const raw = readStore(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    // Older saves only held link hypotheses under "hyps"; keep them.
    const out: Store = {};
    for (const [id, v] of Object.entries(parsed as Record<string, Partial<Stored> & { hyps?: Record<string, Hypothesis> }>))
      out[id] = { on: !!v.on, links: v.links ?? v.hyps ?? {}, assets: v.assets ?? {}, addedAssets: v.addedAssets ?? [], addedLinks: v.addedLinks ?? [] };
    return out;
  } catch {
    return {};
  }
}

interface Api {
  store: Store;
  update: (scenarioId: string, fn: (cur: Stored) => Stored) => void;
}
const Ctx = createContext<Api | null>(null);

export function WhatIfProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<Store>(load);
  const update = useCallback((scenarioId: string, fn: (cur: Stored) => Stored) => {
    setStore((cur) => {
      const next = { ...cur, [scenarioId]: fn(cur[scenarioId] ?? blank()) };
      writeStore(KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const value = useMemo(() => ({ store, update }), [store, update]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export interface WhatIf {
  /** Whether the hypothetical changes are applied to results. Changes are kept while this is off. */
  on: boolean;
  setOn: (on: boolean) => void;
  /** Active changes, with anything stale (deleted assets or links, no-ops) removed. */
  changes: WhatIfChanges;
  count: number;
  /** on and at least one change: analysis pages are showing hypothetical results. */
  applied: boolean;
  /** What every analysis should use. Equals the saved scenario unless hypothetical changes are applied. */
  assets: Asset[];
  deps: Dependency[];
  changedLinks: Set<string>;
  changedAssets: Set<string>;
  setLink: (linkId: string, h: Hypothesis | null) => void;
  setAsset: (assetId: string, c: AssetChange | null) => void;
  addAsset: (input: Omit<Asset, 'id' | 'x' | 'y'>) => Asset;
  addLink: (input: Omit<Dependency, 'id' | 'status'>) => Dependency;
  /** Removes one change. Key as produced by describeChanges. */
  undo: (key: string) => void;
  /** Reverts every change to the saved model and keeps what-if mode on. */
  reset: () => void;
  /** Ends the what-if: reverts every change and switches it off. */
  discard: () => void;
}

export function useWhatIf(s: Scenario): WhatIf {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useWhatIf must be used inside WhatIfProvider');
  const { store, update } = ctx;
  const entry = store[s.id];
  const id = s.id;

  const changes = useMemo(() => cleanChanges(s, entry ?? blank()), [s, entry]);
  const count = countChanges(changes);
  const on = entry?.on ?? false;
  const applied = on && count > 0;
  const effective = useMemo(() => (applied ? applyChanges(s.assets, s.dependencies, changes) : { assets: s.assets, deps: s.dependencies }), [applied, s.assets, s.dependencies, changes]);

  const edit = useCallback((fn: (c: Stored) => Stored) => update(id, (c) => ({ ...fn(c), on: true })), [update, id]);
  const setOn = useCallback((v: boolean) => update(id, (c) => ({ ...c, on: v })), [update, id]);
  const setLink = useCallback(
    (linkId: string, h: Hypothesis | null) =>
      edit((c) => {
        const links = { ...c.links };
        if (h) links[linkId] = h;
        else delete links[linkId];
        return { ...c, links };
      }),
    [edit],
  );
  const setAsset = useCallback(
    (assetId: string, ch: AssetChange | null) =>
      edit((c) => {
        const assets = { ...c.assets };
        if (ch) assets[assetId] = ch;
        else delete assets[assetId];
        return { ...c, assets };
      }),
    [edit],
  );
  const addAsset = useCallback(
    (input: Omit<Asset, 'id' | 'x' | 'y'>) => {
      const asset: Asset = { ...input, id: uid(`${WHATIF_PREFIX}as`), x: null, y: null };
      edit((c) => ({ ...c, addedAssets: [...c.addedAssets, asset] }));
      return asset;
    },
    [edit],
  );
  const addLink = useCallback(
    (input: Omit<Dependency, 'id' | 'status'>) => {
      const dep: Dependency = { ...input, id: uid(`${WHATIF_PREFIX}dp`), status: 'inferred' };
      edit((c) => ({ ...c, addedLinks: [...c.addedLinks, dep] }));
      return dep;
    },
    [edit],
  );
  const undo = useCallback(
    (key: string) =>
      update(id, (c) => {
        const [kind, ref] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
        const next = { ...c, links: { ...c.links }, assets: { ...c.assets } };
        if (kind === 'l') delete next.links[ref];
        if (kind === 'a') delete next.assets[ref];
        if (kind === 'na') {
          next.addedAssets = c.addedAssets.filter((a) => a.id !== ref);
          next.addedLinks = c.addedLinks.filter((d) => d.dependentId !== ref && d.providerId !== ref);
        }
        if (kind === 'nl') next.addedLinks = c.addedLinks.filter((d) => d.id !== ref);
        return next;
      }),
    [update, id],
  );
  const reset = useCallback(() => update(id, () => ({ ...blank(), on: true })), [update, id]);
  const discard = useCallback(() => update(id, () => blank()), [update, id]);

  return {
    on,
    setOn,
    changes,
    count,
    applied,
    assets: effective.assets,
    deps: effective.deps,
    changedLinks: useMemo(() => (applied ? changedLinkIds(changes) : new Set<string>()), [applied, changes]),
    changedAssets: useMemo(() => (applied ? changedAssetIds(changes) : new Set<string>()), [applied, changes]),
    setLink,
    setAsset,
    addAsset,
    addLink,
    undo,
    reset,
    discard,
  };
}

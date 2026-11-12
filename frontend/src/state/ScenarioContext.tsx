import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { readStore, writeStore } from '../lib/storage';
import type { Scenario } from '../lib/types';
import { useToast } from './ToastContext';

type Status = 'loading' | 'ready' | 'error';
const ACTIVE_KEY = 'ghostgrid.active.v1';

interface ScenarioApi {
  status: Status;
  error: string | null;
  scenarios: Scenario[];
  active: Scenario | null;
  setActiveId: (id: string) => void;
  reload: () => Promise<void>;
  /** Saves a new scenario and makes it active. */
  addScenario: (s: Scenario) => Promise<Scenario>;
  /** Applies an edit immediately and saves it in the background; failures are reported and state is reloaded. */
  updateScenario: (id: string, fn: (s: Scenario) => Scenario) => void;
  deleteScenario: (id: string) => Promise<void>;
  /** Duplicates a scenario on the server (flushing pending edits first) and makes the copy active. */
  duplicateScenario: (id: string, name?: string) => Promise<Scenario>;
  /** Opens the metro sample scenario, restoring the bundled samples first if none exist. */
  openSample: () => Promise<Scenario>;
  /** Adds any bundled simulated sample that is missing. Returns the scenarios that were added. */
  restoreSamples: () => Promise<Scenario[]>;
  resetAll: () => Promise<void>;
}

const Ctx = createContext<ScenarioApi | null>(null);

export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.details.length ? `${err.message} ${err.details[0]}` : err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export function ScenarioProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveIdState] = useState<string | null>(() => readStore(ACTIVE_KEY));

  const ref = useRef<Scenario[]>([]);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());

  const commit = useCallback((next: Scenario[]) => {
    ref.current = next;
    setScenarios(next);
  }, []);

  const setActiveId = useCallback((id: string) => {
    setActiveIdState(id);
    writeStore(ACTIVE_KEY, id);
  }, []);

  const reload = useCallback(async () => {
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    try {
      commit(await api.list());
      setError(null);
      setStatus('ready');
    } catch (err) {
      setError(describeError(err));
      setStatus('error');
    }
  }, [commit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const active = useMemo(
    () => scenarios.find((s) => s.id === activeId) ?? scenarios[0] ?? null,
    [scenarios, activeId],
  );

  const addScenario = useCallback(
    async (s: Scenario) => {
      const saved = await api.create(s);
      commit([...ref.current, saved]);
      setActiveId(saved.id);
      return saved;
    },
    [commit, setActiveId],
  );

  const updateScenario = useCallback(
    (id: string, fn: (s: Scenario) => Scenario) => {
      const current = ref.current.find((s) => s.id === id);
      if (!current) return;
      const next: Scenario = { ...fn(current), id, updatedAt: new Date().toISOString() };
      commit(ref.current.map((s) => (s.id === id ? next : s)));
      saveQueue.current = saveQueue.current
        .then(() => api.update(next))
        .catch(async (err) => {
          toast.error(`Could not save changes. ${describeError(err)}`);
          await reload();
        });
    },
    [commit, reload, toast],
  );

  const deleteScenario = useCallback(
    async (id: string) => {
      await saveQueue.current;
      await api.remove(id);
      commit(ref.current.filter((s) => s.id !== id));
    },
    [commit],
  );

  const duplicateScenario = useCallback(
    async (id: string, name?: string) => {
      await saveQueue.current; // make sure the server has every edit before copying
      const copy = await api.duplicate(id, name);
      commit([...ref.current, copy]);
      setActiveId(copy.id);
      return copy;
    },
    [commit, setActiveId],
  );

  const restoreSamples = useCallback(async () => {
    await saveQueue.current;
    const added = await api.restoreSamples();
    if (added.length) commit([...ref.current, ...added]);
    return added;
  }, [commit]);

  const openSample = useCallback(async () => {
    const find = () => ref.current.find((s) => s.sampleKey === 'metro-corridor') ?? ref.current.find((s) => s.isSample);
    let sample = find();
    if (!sample) {
      await restoreSamples();
      sample = find();
    }
    if (!sample) throw new Error('The sample scenarios could not be loaded.');
    setActiveId(sample.id);
    return sample;
  }, [restoreSamples, setActiveId]);

  const resetAll = useCallback(async () => {
    await saveQueue.current;
    await api.removeAll();
    commit([]);
  }, [commit]);

  const value = useMemo<ScenarioApi>(
    () => ({
      status,
      error,
      scenarios,
      active,
      setActiveId,
      reload,
      addScenario,
      updateScenario,
      deleteScenario,
      duplicateScenario,
      openSample,
      restoreSamples,
      resetAll,
    }),
    [status, error, scenarios, active, setActiveId, reload, addScenario, updateScenario, deleteScenario, duplicateScenario, openSample, restoreSamples, resetAll],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useScenarios(): ScenarioApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useScenarios must be used inside ScenarioProvider');
  return ctx;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { BranchInfo, BranchSimulation, BranchSimulationDetail, BranchState, Commit, CommitDetail, PatchOp } from '../lib/graphGit';
import { readStore, writeStore } from '../lib/storage';

type Status = 'loading' | 'ready' | 'error';
const activeKey = (scenarioId: string) => `ghostgrid.graphgit.branch.${scenarioId}`;
const authorKey = 'ghostgrid.graphgit.author';

/** Remembered per browser as a convenience only. Branches, commits and patches live on the server. */
export const readAuthor = () => readStore(authorKey) ?? '';
export const writeAuthor = (name: string) => writeStore(authorKey, name.trim() || null);

export interface GraphGit {
  status: Status;
  error: string | null;
  branches: BranchInfo[];
  state: BranchState | null;
  commits: Commit[];
  commitTotal: number;
  sims: BranchSimulation[];
  /** Number of server requests in flight that change data. */
  pending: number;
  reload: () => Promise<void>;
  selectBranch: (id: string) => Promise<void>;
  createBranch: (body: { name: string; description?: string; fromCommitId?: string }) => Promise<BranchState>;
  renameBranch: (id: string, body: { name?: string; description?: string }) => Promise<void>;
  deleteBranch: (id: string) => Promise<void>;
  applyOps: (ops: PatchOp[]) => Promise<void>;
  undoPatch: (patchId: string) => Promise<void>;
  discard: () => Promise<void>;
  commit: (body: { message: string; body?: string; author?: string }) => Promise<Commit>;
  restore: (commitId: string, opts?: { discardPending?: boolean; author?: string }) => Promise<Commit>;
  revert: (commitId: string, opts?: { discardPending?: boolean; author?: string }) => Promise<Commit>;
  syncMain: (opts?: { discardPending?: boolean; author?: string }) => Promise<Commit>;
  saveSimulation: (body: { failedIds: string[]; failedLinkIds: string[]; commitId?: string; name?: string }) => Promise<BranchSimulationDetail>;
  openSimulation: (id: string) => Promise<BranchSimulationDetail>;
  loadCommit: (id: string) => Promise<CommitDetail>;
}

/**
 * Loads and changes one scenario's branches through the server. Every write is queued so edits reach the server in
 * the order they were made, and the screen always shows what the server returned, never a guess.
 */
export function useGraphGit(scenarioId: string): GraphGit {
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [state, setState] = useState<BranchState | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [commitTotal, setCommitTotal] = useState(0);
  const [sims, setSims] = useState<BranchSimulation[]>([]);
  const [pending, setPending] = useState(0);

  const activeId = useRef<string | null>(null);
  const headId = useRef<string | undefined>(undefined);
  const token = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  /** Loads the branch list and one branch (its state, history and simulations). */
  const load = useCallback(
    async (prefer?: string | null) => {
      const mine = ++token.current;
      const list = await api.listBranches(scenarioId);
      const wanted = prefer ?? activeId.current ?? readStore(activeKey(scenarioId));
      const chosen = list.find((b) => b.id === wanted) ?? list.find((b) => b.isDefault) ?? list[0];
      if (!chosen) throw new Error('This scenario has no branches.');
      const [st, hist, simList] = await Promise.all([api.getBranch(chosen.id), api.listCommits(chosen.id), api.listBranchSimulations(chosen.id)]);
      if (mine !== token.current) return; // a newer load superseded this one
      activeId.current = chosen.id;
      writeStore(activeKey(scenarioId), chosen.id);
      headId.current = st.head.id;
      setBranches(list);
      setState(st);
      setCommits(hist.commits);
      setCommitTotal(hist.total);
      setSims(simList);
    },
    [scenarioId],
  );

  const reload = useCallback(async () => {
    try {
      await load();
      setError(null);
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load branches.');
      setStatus('error');
    }
  }, [load]);

  useEffect(() => {
    setStatus('loading');
    void reload();
  }, [reload]);

  /** Runs a write after earlier writes finish. On a conflict the screen is reloaded so it shows the server's truth. */
  const write = useCallback(
    <T,>(fn: () => Promise<T>): Promise<T> => {
      setPending((n) => n + 1);
      const run = queue.current.then(fn, fn);
      queue.current = run.catch(() => undefined);
      return run
        .catch(async (err: unknown) => {
          if ((err as { status?: number }).status === 409) await load().catch(() => undefined);
          throw err;
        })
        .finally(() => setPending((n) => n - 1));
    },
    [load],
  );

  const branchId = () => {
    if (!activeId.current) throw new Error('No branch is selected.');
    return activeId.current;
  };

  const selectBranch = useCallback(async (id: string) => load(id), [load]);

  const createBranch = useCallback(
    (body: { name: string; description?: string; fromCommitId?: string }) =>
      write(async () => {
        const created = await api.createBranch(scenarioId, body);
        await load(created.branch.id);
        return created;
      }),
    [write, scenarioId, load],
  );

  const renameBranch = useCallback(
    (id: string, body: { name?: string; description?: string }) =>
      write(async () => {
        await api.updateBranch(id, body);
        await load();
      }),
    [write, load],
  );

  const deleteBranch = useCallback(
    (id: string) =>
      write(async () => {
        await api.deleteBranch(id);
        await load(id === activeId.current ? null : activeId.current).catch(async () => {
          activeId.current = null;
          await load();
        });
      }),
    [write, load],
  );

  const applyState = useCallback((st: BranchState) => {
    headId.current = st.head.id;
    setState(st);
    setBranches((list) => list.map((b) => (b.id === st.branch.id ? st.branch : b)));
  }, []);

  const applyOps = useCallback(
    (ops: PatchOp[]) =>
      write(async () => {
        const { created: _created, ...st } = await api.addPatches(branchId(), ops, headId.current);
        void _created;
        applyState(st);
      }),
    [write, applyState],
  );

  const undoPatch = useCallback(
    (patchId: string) =>
      write(async () => {
        applyState(await api.revertPatch(branchId(), patchId));
      }),
    [write, applyState],
  );

  const discard = useCallback(
    () =>
      write(async () => {
        applyState(await api.discardPatches(branchId()));
      }),
    [write, applyState],
  );

  const commit = useCallback(
    (body: { message: string; body?: string; author?: string }) =>
      write(async () => {
        const res = await api.commitBranch(branchId(), { ...body, expectedHeadCommitId: headId.current });
        await load();
        return res.commit;
      }),
    [write, load],
  );

  const restore = useCallback(
    (commitId: string, opts: { discardPending?: boolean; author?: string } = {}) =>
      write(async () => {
        const res = await api.restoreCommit(commitId, { branchId: branchId(), expectedHeadCommitId: headId.current, ...opts });
        await load();
        return res.commit;
      }),
    [write, load],
  );

  const revert = useCallback(
    (commitId: string, opts: { discardPending?: boolean; author?: string } = {}) =>
      write(async () => {
        const res = await api.revertCommit(commitId, { branchId: branchId(), expectedHeadCommitId: headId.current, ...opts });
        await load();
        return res.commit;
      }),
    [write, load],
  );

  const syncMain = useCallback(
    (opts: { discardPending?: boolean; author?: string } = {}) =>
      write(async () => {
        const res = await api.syncBranchFromScenario(branchId(), opts);
        await load();
        return res.commit;
      }),
    [write, load],
  );

  const saveSimulation = useCallback(
    (body: { failedIds: string[]; failedLinkIds: string[]; commitId?: string; name?: string }) =>
      write(async () => {
        const sim = await api.runBranchSimulation(branchId(), body);
        const [list, st] = await Promise.all([api.listBranchSimulations(branchId()), api.getBranch(branchId())]);
        setSims(list);
        applyState(st);
        return sim;
      }),
    [write, applyState],
  );

  const openSimulation = useCallback((id: string) => api.getBranchSimulation(id), []);
  const loadCommit = useCallback((id: string) => api.getCommit(id), []);

  return {
    status,
    error,
    branches,
    state,
    commits,
    commitTotal,
    sims,
    pending,
    reload,
    selectBranch,
    createBranch,
    renameBranch,
    deleteBranch,
    applyOps,
    undoPatch,
    discard,
    commit,
    restore,
    revert,
    syncMain,
    saveSimulation,
    openSimulation,
    loadCommit,
  };
}

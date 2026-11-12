import express from 'express';
import { HttpError } from '../errors.mjs';
import {
  addPatches,
  commitBranch,
  compareCommits,
  createBranch,
  createSimulation,
  deleteBranch,
  discardPending,
  listBranches,
  listCommits,
  listPatches,
  listSimulations,
  readBranchState,
  readCommit,
  readSimulation,
  restoreCommit,
  revertCommit,
  revertPatch,
  syncFromScenario,
  updateBranch,
} from './repo.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Graph Git endpoints, mounted under /api. Same conventions as the rest of the API: JSON bodies, `{ name }` envelopes,
 * `{ error, details }` on failure, 201 on create and 204 on delete.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createGraphGitRouter(db) {
  const router = express.Router();
  const h = (fn) => (req, res, next) => {
    try {
      fn(req, res);
    } catch (err) {
      next(err);
    }
  };
  const body = (req) => {
    if (req.body === undefined || req.body === null) return {};
    if (!isObj(req.body)) throw new HttpError(400, 'Body must be a JSON object.');
    return req.body;
  };
  const int = (v, name, fallback) => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} must be a non-negative integer.`);
    return n;
  };

  /* ---- branches ---- */

  router.get('/scenarios/:scenarioId/branches', h((req, res) => {
    res.json({ branches: listBranches(db, req.params.scenarioId) });
  }));

  router.post('/scenarios/:scenarioId/branches', h((req, res) => {
    res.status(201).json(createBranch(db, req.params.scenarioId, body(req)));
  }));

  router.get('/branches/:branchId', h((req, res) => {
    res.json(readBranchState(db, req.params.branchId));
  }));

  router.patch('/branches/:branchId', h((req, res) => {
    res.json(updateBranch(db, req.params.branchId, body(req)));
  }));

  router.delete('/branches/:branchId', h((req, res) => {
    deleteBranch(db, req.params.branchId);
    res.status(204).end();
  }));

  router.post('/branches/:branchId/sync-from-scenario', h((req, res) => {
    res.status(201).json(syncFromScenario(db, req.params.branchId, body(req)));
  }));

  /* ---- commits ---- */

  router.get('/branches/:branchId/commits', h((req, res) => {
    res.json(listCommits(db, req.params.branchId, { limit: int(req.query.limit, 'limit', 100), offset: int(req.query.offset, 'offset', 0) }));
  }));

  router.post('/branches/:branchId/commits', h((req, res) => {
    res.status(201).json(commitBranch(db, req.params.branchId, body(req)));
  }));

  // Registered before /commits/:commitId so "compare" is not read as an id.
  router.get('/commits/compare', h((req, res) => {
    if (typeof req.query.from !== 'string' || typeof req.query.to !== 'string') throw new HttpError(400, 'from and to commit ids are required.');
    res.json(compareCommits(db, req.query.from, req.query.to));
  }));

  router.get('/commits/:commitId', h((req, res) => {
    res.json(readCommit(db, req.params.commitId));
  }));

  router.post('/commits/:commitId/restore', h((req, res) => {
    res.status(201).json(restoreCommit(db, req.params.commitId, body(req)));
  }));

  router.post('/commits/:commitId/revert', h((req, res) => {
    res.status(201).json(revertCommit(db, req.params.commitId, body(req)));
  }));

  /* ---- patches ---- */

  router.get('/branches/:branchId/patches', h((req, res) => {
    const status = req.query.status ?? 'all';
    if (!['all', 'pending', 'committed'].includes(status)) throw new HttpError(400, 'status must be all, pending or committed.');
    res.json({ patches: listPatches(db, req.params.branchId, status) });
  }));

  router.post('/branches/:branchId/patches', h((req, res) => {
    const b = body(req);
    if (b.op !== undefined && b.ops !== undefined) throw new HttpError(400, 'Send either op or ops, not both.');
    const ops = b.ops !== undefined ? b.ops : b.op !== undefined ? [b.op] : undefined;
    const { created, state } = addPatches(db, req.params.branchId, ops, { expectedHeadCommitId: b.expectedHeadCommitId });
    // `created` are the patches this request added; `patches` is the branch's full pending list, as everywhere else.
    res.status(201).json({ ...state, created });
  }));

  router.post('/branches/:branchId/patches/:patchId/revert', h((req, res) => {
    res.status(201).json(revertPatch(db, req.params.branchId, req.params.patchId));
  }));

  router.delete('/branches/:branchId/patches', h((req, res) => {
    res.json(discardPending(db, req.params.branchId));
  }));

  /* ---- simulations ---- */

  router.get('/branches/:branchId/simulations', h((req, res) => {
    const commitId = typeof req.query.commitId === 'string' ? req.query.commitId : undefined;
    res.json({ simulations: listSimulations(db, req.params.branchId, { commitId }) });
  }));

  router.post('/branches/:branchId/simulations', h((req, res) => {
    res.status(201).json({ simulation: createSimulation(db, req.params.branchId, body(req)) });
  }));

  router.get('/simulations/:simulationId', h((req, res) => {
    res.json({ simulation: readSimulation(db, req.params.simulationId) });
  }));

  return router;
}

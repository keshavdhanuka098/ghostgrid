# Graph Git, Phase 1 report

Scope: persistent branches, commits, immutable snapshots, a structured patch engine and branch-specific simulations. Visual diffs and merge requests are Phase 2 and are not started.

## How it works

- A **commit** points to an immutable **snapshot** of the whole graph (assets, dependencies and all their properties) and to its parent commit. Snapshots are canonical JSON, de-duplicated by SHA-256, and SQLite triggers refuse any `UPDATE` of a commit or snapshot.
- A **branch** points to a head commit. Uncommitted edits are stored on the server as **pending patches** (structured operations); the branch's *working graph* is its head snapshot with those patches applied. Committing writes a new snapshot, a new commit and attaches the patches to it.
- **Restore** and **revert** never rewrite history. Both compute a graph diff, apply it as validated operations and add a new commit. Restore is verified by hash against the target snapshot; revert refuses (409, nothing saved) if later commits conflict.
- **Simulations** run on the server with the existing `src/lib/graph.ts` engine (imported, not copied). The client chooses the failure; the server computes and stores the result against one commit, plus branch, scenario, failure seed, config (`engineVersion`) and timestamp. Reading a stored simulation recomputes it and reports `reproducible`. Old simulations stay tied to their commit; the UI marks them "Older commit" and opens them on that commit's own graph.
- The live scenario (Workspace and Graph pages) is untouched by branch work. `main` starts from the scenario's graph. If the scenario is later edited elsewhere, `main` does **not** change silently; the page shows a notice and an explicit "Commit those edits to main" action (`sync-from-scenario`).

## Patch operations

Structural: `add_node`, `delete_node`, `modify_node` (name, kind, notes), `set_criticality`, `add_dependency`, `remove_dependency`, `modify_dependency` (status, relation, notes), `replace_provider`. Layout: `move_node`. Behavioural: `set_dependency_mode` (required or alternate, which changes how failures propagate).

Every operation is validated, stores its inverse and a readable description, belongs to a branch and is recorded with the commit. Results are re-checked by the shared scenario validator (`validateGraph` in `server/validate.mjs`, factored out of `validateScenario`).

Latency, availability, capacity, failure thresholds, circuit breakers and recovery parameters are **rejected with an explanation**: GhostGrid's failure model has no such settings, so adding them would be cosmetic.

## New files

`server/db.mjs` (migration v3, modified) · `server/graphgit/constants.mjs`, `patch.mjs`, `engine.mjs`, `repo.mjs`, `routes.mjs` · `server/graphgit.test.mjs` · `src/lib/graphGit.ts`, `graphGit.test.ts` · `src/state/useGraphGit.ts` · `src/components/graphgit/dialogs.tsx`, `panels.tsx`, `SimulationPanel.tsx` · `src/pages/GraphGit.tsx` · `src/styles/graphgit.css` · `docs/GRAPH_GIT_PHASE1.md`

## Modified files

`server/validate.mjs` (shared graph validator), `server/app.mjs` (mounts router), `server/repo.mjs` (new scenarios get `main`), `server/bootstrap.mjs` (backfills `main` for existing scenarios), `src/lib/graph.ts` (import path `./types.ts` so Node can load it), `src/lib/api.ts`, `src/App.tsx`, `src/nav.ts`, `src/main.tsx`, `src/components/Icon.tsx`, `tsconfig.json` (`allowImportingTsExtensions`), `package.json` (Node >= 22.18), `README.md`.

## Migration v3 (append-only)

`graph_snapshots`, `branches`, `commits`, `graph_patches`, `branch_simulations`, with foreign keys (cross references between branches and commits are deferred to the end of the transaction), cascade rules, unique `(scenario, branch name)` case-insensitive, one default branch per scenario, indexes on the lookup paths, and immutability triggers. Existing scenarios get a `main` branch with a baseline commit at startup.

## API (all under `/api`, same `{ error, details }` conventions)

| Method and path | Purpose |
| --- | --- |
| `GET /scenarios/:id/branches` | List branches (creates `main` if missing) |
| `POST /scenarios/:id/branches` | Create from `fromCommitId`, `fromBranchId` or main's head |
| `GET /branches/:id` | Branch, head commit, working graph, pending patches, `dirty` |
| `PATCH /branches/:id` | Rename / describe |
| `DELETE /branches/:id` | 409 for the default branch or when other branches build on its history |
| `GET /branches/:id/commits` | History by ancestry (`limit`, `offset`) |
| `POST /branches/:id/commits` | Commit pending patches (`message`, `body`, `author`, `expectedHeadCommitId`) |
| `GET /commits/:id`, `GET /commits/compare?from&to` | Commit with snapshot and patches; metadata and change summary |
| `POST /commits/:id/restore`, `POST /commits/:id/revert` | New commit on a branch (`discardPending` to confirm) |
| `GET|POST|DELETE /branches/:id/patches` | List, apply a batch atomically (`op` or `ops`), discard pending |
| `POST /branches/:id/patches/:patchId/revert` | Undo a pending patch by appending its inverse |
| `POST /branches/:id/sync-from-scenario` | Default branch only |
| `GET|POST /branches/:id/simulations`, `GET /simulations/:id` | Branch simulations |

## Tests and build

`npm run check` (typecheck, tests, production build): 9 files, 170 tests passing (105 before this work, none removed or weakened), build succeeds. New tests cover the patch engine (inverses, classification, rejection, diff round trip), branch creation, isolation, switching, deletion rules, historical branching, patches, commits, immutability (including SQL-level), history, restore, revert and conflicts, comparison, independent and reproducible simulations, historical simulation preservation, validation, foreign keys, rollback of failed commits, restores and branch creation, upgrade from schema v2, and persistence across restart. I also ran the real app in a browser: create `fix/auth-microservice-timeout`, add an asset, commit, restore the baseline, simulate and save, switch to main, then restarted the server and confirmed branches, commits and the saved simulation survived with main unchanged.

## Decisions and limitations

- Server imports the TypeScript engine, so Node 22.18+ is required (type stripping is on by default there).
- Simulations are saved only against committed graphs; uncommitted work can be simulated live but not saved.
- No "active merge" check exists because merges do not exist yet; deletion safety is based on shared history. Hook it into `deletionBlockers` in Phase 2.
- Branches are not copied when a scenario is duplicated; the copy starts with a fresh `main`.
- Snapshots hold assets and dependencies. Saved runs, mitigation strategies and assumptions remain on the live scenario only.
- Author is free text (the app has no sign-in).
- Dragging an asset on a branch creates a layout patch (consecutive drags of one asset are merged).
- Branch simulation UI is its own panel sharing the engine and explanation code; the existing Simulation page and what-if panel are unchanged and still use the live scenario.
- Not covered by automated tests: React components (verified by the manual browser walkthrough only).

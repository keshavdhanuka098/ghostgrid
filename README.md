# Ghostgrid

Infrastructure dependency explorer and Graph-Git simulation platform. Map how assets depend on each other, version the graph like code, run what-if failure simulations, and extract graph features for machine learning.

> Prototype decision-support tool, not a certified safety system. The bundled data is invented.

## Monorepo layout

```
frontend/   React 19 + TypeScript + Vite + Tailwind CSS 4 (the "atelier" theme, splash loader, all pages)
backend/
  server/     Node API: Express 5 + SQLite (node:sqlite), Graph-Git, feature-extraction bridge
  engine/     the one cascade engine (pure TypeScript); the API runs it in Node, the browser imports the same files
  ml/         Python ML modules: dataset handling, graph feature extraction, training and evaluation pipeline
  scripts/ datasets/ tests/   Python tooling and tests
```

## Run it

Requires Node 22.18+ and, for graph features, Python 3.10+ (standard library only).

```bash
npm install
npm run dev        # web http://localhost:5173, API http://127.0.0.1:8787
npm run build && npm start   # one server on http://127.0.0.1:8787
npm test           # backend + engine, frontend, Python
```

## Graph feature extraction

`POST /api/scenarios/:id/features` runs `backend/ml/feature_engineering` (Python) and returns whole-graph and per-asset
features: fan-in/out, dependency depth, cascade reach, hidden-dependency reach, reliance rank, redundancy ratio and more.
The same extractor is available offline: `python3 -m ml.feature_engineering.cli --input scenario.json` from `backend/`.
Set `GHOSTGRID_PYTHON` to use a specific interpreter.

## External integrations (optional)

Gemini and Groq (AI explanations with automatic fallback), Hugging Face and Kaggle (dataset discovery and safe, user-initiated import with provenance), and Weights & Biases (experiment tracking) can be switched on with keys in `backend/.env`. None is required; Google Maps is intentionally not implemented because assets have no coordinates. See [`backend/docs/INTEGRATIONS.md`](backend/docs/INTEGRATIONS.md) for setup, behaviour, endpoints and a local verification checklist.

## Startup splash

`frontend/src/components/SplashLoader.tsx`. Progress is tied to three real milestones (engine and fonts ready, Graph-Git
repository answers `/api/health`, scenarios loaded), with a minimum duration, a failsafe, Skip / Esc and a reduced-motion mode.
Shown once per browser tab session; replay it from Settings.

## Features

| Area | What it does |
| --- | --- |
| **Scenario workspace** | Create, edit, duplicate and delete scenarios; manage assets, dependencies (required or alternate; confirmed, inferred or unknown) and assumptions. |
| **Dependency graph** | Pan, zoom, drag, connect mode, filters by status and kind, upstream and downstream tracing. Confirmed links are solid with ✓, inferred dashed with ~, unknown dotted with ?, so status never relies on colour alone. |
| **Investigation** | Two views. *Dependency trace*: choose an asset and see upstream and downstream paths (with the weakest evidence on each path), assets shared with another asset, and findings (single points of failure, possible single points of failure, shared dependencies) with explanations, affected services, supporting links and how to verify unconfirmed ones. *Hidden shared dependencies*: ranks assets whose failure reaches others that never list them as a dependency. |
| **Simulation** | Fail assets and/or dependency links. Play, Pause, Previous/Next, a round slider and Reset step through the cascade; each round explains why every asset fails and how certain that is. Runs can be saved. **Compare mitigations** opens the Mitigation page with the same failure. |
| **Mitigation** | Options: add a backup provider, or remove a dependency. Choose a priority (impact, effort or cost), edit cost and effort estimates inline, see a ranking with a sentence explaining each position, and compare the dependency graph and affected services before and after any option. |
| **What-if panel** | On Investigation, Simulation and Mitigation. Hypothetically remove assets, change criticality, add assets, remove dependencies, switch required/alternate, or add dependencies. Findings, simulations and rankings recalculate, and the panel shows original versus hypothetical results with the change that caused each difference. |
| **Graph Git** | Version control for the dependency graph. Every scenario has a `main` branch; create branches (also from historical commits), edit assets and dependencies on a branch only, commit, view history, restore or revert (always as new commits), and run the cascade simulation on a branch. Simulations are saved against the exact commit. |
| **Reports** | Saved report snapshots per scenario (always built from the saved scenario). |

### How what-if works

- Hypothetical changes live in the **browser only** (`localStorage`, key `ghostgrid.whatif.v1`, per scenario). They are never sent to the server or written into the scenario.
- The Investigation, Simulation and Mitigation pages use the hypothetical model only while changes are applied; a banner says so. The graph page, dashboard and reports always use the saved scenario.
- **Reset** reverts every change to the saved model and stays in what-if mode. **Discard** ends the what-if (asks first when changes exist). **Undo** removes a single change. Unticking *Apply hypothetical changes to results* pauses them without losing them.
- Changes that contradict a link marked *confirmed* are flagged. Hypothetical assets and links cannot be saved into runs or mitigation options; those stay anchored to the real model.

### Failure model

- **Required** dependency: the dependent fails when its provider fails.
- **Alternate** dependency: the dependent fails only when *all* its alternate providers fail.
- A **failed link** stops one provider serving one dependent; the provider itself stays up.
- Confirmed, inferred and unknown links are all treated as live (cautious). Each finding and cascade step reports the weakest evidence it rests on.
- A hidden shared dependency is an asset whose failure reaches 2+ assets that do not list it as a direct provider.

## Technology stack

- React 19, TypeScript, Vite, React Router, plain CSS design tokens (no UI framework).
- Express 5 JSON API over SQLite using Node's built-in `node:sqlite` (no database server, no native build step).
- Vitest for unit and API tests.

## Project layout

```
backend/
  server/            Express app and SQLite layer
    index.mjs          entry point (env, startup, seeding)
    app.mjs            routes, security and cache headers, static serving
    db.mjs             schema and ordered migrations (PRAGMA user_version)
    repo.mjs           queries; validate.mjs input validation; samples.mjs seeding
    features.mjs       bridge to the Python feature extractor (concurrency-limited)
    graphgit/          Graph Git routes, repository, patches and engine adapter
  engine/            cascade engine and analysis in pure TypeScript, shared with the browser
  shared/samples.json  the bundled simulated scenarios
frontend/src/
  lib/               pure logic (no React): propagation and tracing, investigation and explanations,
                     mitigation options and ranking, what-if changes, reports, plus *.test.ts
  state/             ScenarioContext (server data), WhatIfContext (browser-side what-if), Settings, Toast
  components/        GraphView, WhatIfPanel, DependencyTrace, editors, ErrorBoundary, UI kit
  pages/             Landing, Dashboard, Workspace, GraphPage, GraphGit, Investigation, Simulation,
                     Features, Mitigation, Reports, Settings (all app pages are code-split)
```

## Environment variables

Optional. Copy `.env.example` to `.env` (git-ignored; the server loads it, and real environment variables win). No API keys or paid services are needed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT`, `HOST` | `8787`, `127.0.0.1` | API / production server address |
| `GHOSTGRID_DB` | `data/ghostgrid.db` | SQLite file (created on first start) |
| `GHOSTGRID_SEED_SAMPLES` | `true` | Add the simulated samples once, on an empty database |
| `GHOSTGRID_LEGACY_JSON` | `data/db.json` | Part 1 JSON data, imported once if present and the database is empty |
| `GHOSTGRID_PYTHON` | `python3` | Interpreter used for graph feature extraction |
| `GHOSTGRID_FEATURE_CONCURRENCY` | `2` | Most feature extractions run at once; extra requests wait their turn |
| `GHOSTGRID_API` | `http://127.0.0.1:8787` | Dev only: where Vite proxies `/api` |

## Database

One SQLite file in WAL mode. Back it up by copying `data/ghostgrid.db`; delete it to start fresh. Migrations are ordered and append-only (currently schema version 3), run automatically on start, and a database from a newer version is refused rather than modified.

Tables: `scenarios`, `nodes` (assets), `links` (dependent to provider, with `mode`, `status`, `relation`), `assumptions`, `mitigations` (kind, cost and effort levels), `simulation_runs` with `run_failed_nodes` and `run_failed_links`, `reports`, `meta`, and for Graph Git `branches`, `commits`, `graph_snapshots`, `graph_patches`, `branch_simulations`. Child rows cascade on delete; names are unique per scenario, case-insensitive.

## Datasets

Three invented, clearly labelled **Simulated sample** scenarios in `shared/samples.json`, added on first run:

| Scenario | Assets | Dependencies |
| --- | --- | --- |
| Metro corridor | 13 | 16 |
| Harbour water and telecom | 15 | 23 |
| Hospital campus continuity | 17 | 24 |

They include saved asset-failure and link-failure runs and mitigation options with cost and effort estimates. They are not real infrastructure. If deleted, **Restore simulated samples** in the workspace brings them back.

## API

`GET /api/health` · `GET|POST /api/scenarios` · `GET|PUT|DELETE /api/scenarios/:id` · `POST /api/scenarios/:id/duplicate` · `DELETE /api/scenarios` · `POST /api/samples/restore` · `GET|POST /api/scenarios/:id/reports` · `GET|DELETE /api/scenarios/:id/reports/:rid`

A scenario is saved whole (assets, dependencies, assumptions, runs, strategies) in one transaction. Payloads are validated on the server; errors return `{ error, details }` with 400, 404, 409 or 413. What-if state is not part of the API.

Graph Git: `GET|POST /api/scenarios/:id/branches` · `GET|PATCH|DELETE /api/branches/:id` · `GET|POST /api/branches/:id/commits` · `GET /api/commits/:id` · `GET /api/commits/compare?from&to` · `POST /api/commits/:id/restore|revert` · `GET|POST|DELETE /api/branches/:id/patches` · `POST /api/branches/:id/patches/:patchId/revert` · `POST /api/branches/:id/sync-from-scenario` · `GET|POST /api/branches/:id/simulations` · `GET /api/simulations/:id`. Details in `docs/GRAPH_GIT_PHASE1.md`.

## Testing

```bash
npm test             # backend + engine (vitest), frontend logic (vitest), Python (unittest)
npm run typecheck    # tsc --noEmit
npm run check        # typecheck + tests + production build
```

Logic tests cover propagation, investigation, mitigation ranking and explanations, what-if changes and attribution, trace paths, Graph Git, the API (including headers and caching) and the Python feature and ML modules. GitHub Actions runs `npm run check` on every push and pull request (`.github/workflows/ci.yml`).

## Limitations

No authentication or multi-user conflict handling (last write wins); intended for local, single-user use. Cost and effort are your own low/medium/high estimates and are never converted to money or time. Analysis covers only what is mapped.

## Optional ML and dataset workspace

GhostGrid includes a separate Python-based ML workspace under `datasets/`, `ml/` and `scripts/`. It is intentionally independent of the Express API and deterministic graph simulation engine. It provides JSON/JSONL/NDJSON/CSV ingestion, graph/reference validation, reproducible graph/scenario-level train/validation/test splitting, pluggable model adapters, experiment metadata, unique checkpoints and held-out test evaluation. It does **not** ship a trained model or real-world training dataset.

See [`datasets/README.md`](datasets/README.md) and [`ml/README.md`](ml/README.md) for the workflow. Dataset validation and splitting use Python's standard library. The optional scikit-learn adapter requires `pip install -r requirements-ml.txt`.

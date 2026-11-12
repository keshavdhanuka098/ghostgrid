# External integrations

Everything here is **optional**. With no keys at all GhostGrid behaves exactly as before. All provider calls are made by the Express server; the browser only ever talks to `/api/integrations/*`, and no response contains a credential.

## Where things live

| Area | Location |
| --- | --- |
| Provider modules, services, health, routes | `backend/server/integrations/` (plain `.mjs`, matching the existing server) |
| Provider-agnostic LLM service + Gemini/Groq providers | `integrations/ai/` |
| Hugging Face / Kaggle / W&B / Maps | `integrations/huggingface`, `kaggle`, `wandb`, `google-maps` |
| Shared import manager (download → safe extract → validate → register) | `integrations/dataset-import.mjs` |
| Health system and registry | `integration-health.service.mjs`, `integration-registry.mjs` |
| Python helpers | `ml/safe_extract.py`, `ml/profile.py`, `ml/tracking/wandb_tracker.py`, `scripts/{safe_extract,profile_dataset,sync_wandb}.py` |
| Database | migration **v4** (additive): `integration_settings`, `integration_health`, `external_datasets`, `model_references`, `wandb_syncs` |
| UI | `/app/integrations`, a summary in Settings, "Explain with AI" on Simulation and Graph features |

## Getting each key

| Service | Where | Put in `backend/.env` |
| --- | --- | --- |
| Gemini | Google AI Studio → *Get API key* (aistudio.google.com/apikey) | `GEMINI_API_KEY=` |
| Groq | console.groq.com → *API Keys* → *Create API Key* | `GROQ_API_KEY=` |
| Hugging Face | huggingface.co/settings/tokens → new token, type **Read**. For gated datasets also accept the terms on the dataset page with the same account. Optional: public search works without it. | `HF_TOKEN=` |
| Kaggle | kaggle.com → profile → *Settings* → *API* → *Create New Token*; the downloaded `kaggle.json` holds both values | `KAGGLE_USERNAME=` and `KAGGLE_KEY=` |
| Weights & Biases | wandb.ai/authorize (or *User settings → API keys*), then `pip install -r backend/requirements-tracking.txt` | `WANDB_API_KEY=` (optional `WANDB_PROJECT`, `WANDB_ENTITY`) |
| Google Maps | not used (see below) | leave empty |

Copy `backend/.env.example` to `backend/.env` (git-ignored), fill in only what you want, restart the server.

## What each integration does

**AI (Gemini, Groq).** Tasks: `infrastructure_analysis` (analysis or recommendations), `simulation_explanation` (explain or root cause), `model_evaluation`, `dataset_quality`, `training_recommendations`, `experiment_summary`. The server gathers the data itself (it re-runs the cascade engine, reads recorded experiments, profiles dataset files with Python); the client cannot supply results. Answers share one JSON shape, are validated, have invented asset ids stripped, and are returned as `aiGenerated: true, kind: "ai_interpretation"` with the provider, model, what the AI was given, and caveats. Fallback to the second provider happens only for rate limit/quota, timeout or outage, never for bad keys, rejected requests, blocked content or unusable output, and the response says when it happened. Identical requests are cached for 10 minutes and concurrent duplicates share one call.

**Hugging Face.** Search datasets/models, metadata, licence triage (permissive / conditions / restricted / unknown), gated/private flags, sizes. Import supports JSON, JSONL, CSV and one ZIP; nothing downloads without an explicit confirmation, a non-permissive licence needs a second acknowledgement, and the size cap is `GHOSTGRID_IMPORT_MAX_MB` (default 250). Model repositories can be linked to a local experiment (a reference only).

**Kaggle.** Search, metadata, user-initiated download of the dataset ZIP with progress, then the same safe pipeline.

**Import pipeline (both).** Files land in `datasets/external/<source>/<id>-<revision>/files/`, never overwriting (a second import of the same revision is refused). ZIPs go through `ml/safe_extract.py`: no absolute or `..` paths, no symlinks/special files, no encrypted entries, only data/doc extensions, bounded file count, size and compression ratio. Each import records source URL, revision, licence, SHA-256 of every file and the result of GhostGrid's own `validate_dataset.py` in `provenance.json` and the database. **Registering** into `datasets/manifests/datasets.json` goes through the existing `register_dataset.py` and is only offered for files that pass validation. Third-party data is rarely in GhostGrid's record format (`record_id`, `features`, `target`), so expect to convert it before it can be registered.

**Weights & Biases.** Optional and off by default. Two ways in: set `"tracking": {"wandb": {"enabled": true, "project": "ghostgrid"}}` in a training config (logged after training; any failure is recorded in the experiment and never fails training), or press *Sync* in the Experiments tab. It logs config, hyperparameters, validation/test metrics (accuracy, precision, recall, F1, ROC-AUC, MAE/RMSE, whatever the experiment actually recorded), duration, dataset version and fingerprint, and per-epoch history only if the model adapter produced `history`. Loss is therefore absent for the bundled scikit-learn adapter; nothing is invented. Dataset files are never uploaded. The checkpoint is uploaded only with an option **and** an explicit consent box. The W&B run id is `gg-<experiment id>`, created with `resume="never"`, plus a database primary key, so an experiment cannot be logged twice.

**Google Maps — not implemented, by design.** GhostGrid assets have no coordinates (only optional `x`/`y` diagram positions); a map would mean inventing locations. The integration list shows it as disabled with that reason. To add it later, first give assets user-entered latitude/longitude.

## Health and states

`GET /api/integrations` returns status with **no** provider calls. `POST /api/integrations/health` runs real, read-only checks (list models / whoami / one-item search / GraphQL viewer), cached 5 min on success and 1 min on failure; a forced refresh is limited to once per 10 s per service. States: *Connected* (a check succeeded), *Not configured*, *Disabled*, *Rate limited*, *Connection failed* (with a reason such as invalid credentials), *Synchronization pending* (configured but not yet verified, or a W&B sync running). Disabling is per integration and persisted.

## Endpoints (all under `/api/integrations`)

`GET /` · `POST /health` · `PATCH /:id` · `GET /ai/status` · `PUT /ai/preferences` · `POST /ai/analyze` · `GET /huggingface/{datasets,models,dataset,model}` · `POST /huggingface/imports` · `GET /kaggle/{datasets,dataset}` · `POST /kaggle/imports` · `GET /imports[/:id]` · `POST /imports/:id/{cancel,register}` · `DELETE /imports/:id` · `GET|POST /model-references` · `DELETE /model-references/:id` · `GET /ml/{datasets,experiments}` · `POST /wandb/{sync,compare}`

## Local verification checklist (not possible in the build sandbox)

1. `npm install && npm run check` (typecheck, backend + frontend + Python tests, build).
2. Start with an empty `.env`: `npm run dev`; open **Integrations** — every service reads *Not configured*, Hugging Face notes public access, the rest of the app works.
3. Add `GEMINI_API_KEY`; press *Check connections now* → Gemini **Connected**. Run Simulation → *Explain this result*.
4. Add `GROQ_API_KEY`; set `GEMINI_MODEL=nonexistent-model` temporarily — the explanation request should fail with a clear (non-fallback) error; restore it. To see fallback, exhaust quota or block `generativelanguage.googleapis.com` and retry: the answer should name Groq and say a fallback happened.
5. Hugging Face: search, open a small dataset, import one JSONL, confirm progress and the `provenance.json`.
6. Kaggle: set both values, search, import a small dataset.
7. `pip install -r backend/requirements-tracking.txt`, set `WANDB_API_KEY`, train with `python scripts/train_model.py`, press *Sync*; confirm one run in W&B and that a second *Sync* is refused.
8. `grep -r "<your key fragment>" frontend/dist` returns nothing.

## Known limitations

* Provider response shapes (Kaggle fields, the W&B GraphQL viewer query, Gemini/Groq default model names `gemini-2.5-flash` / `llama-3.3-70b-versatile`) follow the providers' public documentation as I know it; model names are configurable because providers retire them. None was exercised against a live service while building.
* Kaggle's newer token formats may not work with the username/key Basic auth used here.
* No streaming of AI answers; one request, one JSON answer. AI never runs automatically.
* Only completed experiments sync to W&B, as a snapshot; *update* mode (to add test metrics later) exists in the service and Python script but has no button yet.
* Parquet-only Hugging Face datasets cannot be imported.

# GhostGrid ML workspace

This is an **optional, standalone Python workspace**. It does not run inside the Express server and does not alter the deterministic GhostGrid simulation engine. No trained model or real-world dataset is included.

## Install

The data validation/splitting tools use only the Python standard library (Python 3.10+). From the repository root:

```powershell
python --version
python scripts/validate_dataset.py path\to\records.jsonl
```

Training requires your own model adapter. An adapter implements `fit(features, targets, validation=...)`, `predict(features)`, and `save(path)`; test evaluation also requires `load(path)`. Configure its import path in `ml/configs/example.json`. For classification tasks, set optional `allowed_labels` in the config to reject unexpected target classes during both training and test evaluation. Keep framework-specific dependencies in a separate environment or optional requirements file.

## Record format

Supervised records are JSON objects with a unique `record_id`, a `features` object, a `target`, and preferably a stable `graph_id` (or `scenario_id`). Graph-bearing records can include a `graph` object with `assets` and `dependencies`. See `datasets/schemas/`.

```json
{"record_id":"sample-001","graph_id":"graph-001","features":{"asset_count":12,"dependency_count":18},"target":"REFUTED"}
```

Do not use this illustrative structure as real training data. Targets must come from documented observations or a defensible labelling process. Include provenance and licensing in dataset metadata.

## Workflow

1. Put original files under `datasets/raw/<category>/` or `datasets/external/`.
2. Validate: `python scripts/validate_dataset.py datasets/raw/failure_scenarios/my-data.jsonl --require-target`
3. Normalize to JSONL: `python scripts/prepare_dataset.py datasets/raw/failure_scenarios/my-data.jsonl --require-target`
4. Split by graph/scenario group: `python scripts/split_dataset.py datasets/processed/all.jsonl --seed 42`
5. Implement and configure a model adapter in `ml/configs/example.json`. Optional `preprocessor_factory` adapters must implement `fit(records)`, `transform(records)`, `save(path)` and `load(path)`; they are fitted only on training records and their state is checkpointed. Optional `feature_extractor_factory` adapters implement `extract(record)`. A built-in graph feature extractor is available as `ml.feature_engineering.graph_features:create_extractor` and derives numeric counts from mapped assets and dependencies only.
6. Train: `python scripts/train_model.py --config ml/configs/example.json`
7. Evaluate a registered run on the held-out test split: `python scripts/evaluate_model.py <experiment_id> --config ml/configs/example.json`

Run the Python unit tests with `python -m unittest discover -s tests -v`. The default split is 70/15/15. Splits require at least three independent graph/scenario groups; all records from the same graph/scenario remain together to reduce leakage. Split ratios and seed are configurable.

## Artifacts and registry

Each run writes a unique checkpoint folder under `ml/models/checkpoints/`, a JSON registry entry under `ml/models/registry/`, and an experiment record under `ml/experiments/`. Existing checkpoints are never overwritten. Test metrics are absent until test evaluation is explicitly run. Evaluation does not automatically mark a model production-ready.

## Safety and interpretation

- Never put credentials, personal data, or confidential infrastructure details into datasets without authorization.
- Validate provenance, consent, licensing and representativeness before training.
- Do not mix simulated samples with real observations without an explicit source field and documented policy.
- ML predictions are estimates and must remain distinct from deterministic simulation output.
- Do not use pickle-based checkpoints from untrusted sources. The adapter owns its serialization format.
- A model must not be deployed merely because training completed; review held-out metrics, calibration, failure modes and domain suitability first.

## Platform commands

Windows PowerShell:

```powershell
python scripts/validate_dataset.py datasets/raw/failure_scenarios/my-data.jsonl --require-target
python scripts/prepare_dataset.py datasets/raw/failure_scenarios/my-data.jsonl --require-target
python scripts/split_dataset.py datasets/processed/all.jsonl --seed 42
python scripts/train_model.py --config ml/configs/example.json
python scripts/evaluate_model.py <experiment_id> --config ml/configs/example.json
```

Linux/macOS: use `python3` instead of `python` if that is the installed interpreter name.

To register source and licensing metadata after validation:

```powershell
python scripts/register_dataset.py datasets/raw/failure_scenarios/my-data.jsonl --name "My Failure Dataset" --version "1.0.0" --description "Documented scenario observations" --source "Internal lab collection" --license "Internal use only"
```

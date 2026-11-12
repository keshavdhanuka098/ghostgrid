# GhostGrid datasets

Store source data under `raw/` (organised by category) and external datasets under `external/`. Do not edit original source files in place. Processed train/validation/test splits belong under `processed/` and should be reproducible from raw data, a versioned preparation process and a fixed random seed.

Supported input formats: JSON (array or `{ "records": [...] }`), JSONL/NDJSON (one record per line), and CSV. Supervised training records require `record_id`, `features` (object) and `target`. Use a stable `graph_id` or `scenario_id` to keep related records in one split. Graphs use `assets` and `dependencies`; dependency endpoints must refer to known asset IDs.

Record dataset provenance, license, source, collection method, label definitions, schema version, record count and checksum in a metadata file. Update `manifests/datasets.json` only after validation. No external or real-world datasets are bundled by default.

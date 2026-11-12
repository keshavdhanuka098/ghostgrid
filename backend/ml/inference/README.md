# Future inference boundary

No inference HTTP endpoint is implemented in this phase. When a model is integrated, expose it behind an adapter/service boundary rather than importing ML frameworks into the Express process.

Recommended response envelope:

```json
{
  "result_type": "ml_prediction",
  "model_name": "example-model",
  "model_version": "1.2.0",
  "experiment_id": "exp_...",
  "dataset_version": "dataset-version",
  "prediction": "example-label",
  "probabilities": null,
  "limitations": ["Model-specific limitations and input coverage"]
}
```

Only include `probabilities` when the model actually produces them and they have been validated/calibrated for the task. Do not label deterministic simulation output as an ML prediction or vice versa. Missing/unsupported inputs should return an explicit unknown/insufficient-data result, not a fabricated prediction.

// Shared helpers for the integration tests. No network is ever touched: every service takes an injected fetch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db.mjs';

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fake fetch that records every call. `handler(url, init)` returns a Response (or throws to simulate a network error). */
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

export const noSleep = async () => {};
export const quiet = () => {};
export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gg-int-'));
export const memDb = () => openDatabase(':memory:');
export { DatabaseSync };

export const KEYS = { GEMINI_API_KEY: 'gem-SECRET-1234567890', GROQ_API_KEY: 'groq-SECRET-1234567890', HF_TOKEN: 'hf_SECRET1234567890', WANDB_API_KEY: 'wandb-SECRET-1234567890', KAGGLE_USERNAME: 'kuser', KAGGLE_KEY: 'kaggle-SECRET-1234567890' };

export const goodAnswer = (extra = {}) => ({ summary: 'A short summary.', findings: [{ title: 'F1', detail: 'd', severity: 'notable', evidence: ['x'], assetIds: [] }], recommendations: [{ title: 'R1', rationale: 'why', effort: 'low', basedOn: ['x'] }], caveats: [], ...extra });
export const geminiReply = (obj) => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
export const groqReply = (obj) => json({ choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

/** Writes a completed experiment record like ml/pipeline.py does. */
export function writeExperiment(backendRoot, id, extra = {}) {
  const dir = path.join(backendRoot, 'ml', 'experiments');
  fs.mkdirSync(dir, { recursive: true });
  const rec = { experiment_id: id, status: 'completed', task: 'classification', model_name: 'm', model_version: '1', dataset_version: 'v1', dataset_fingerprint: 'fp1', hyperparameters: { n: 3 }, started_at: '2026-01-01T00:00:00+00:00', completed_at: '2026-01-01T00:00:10+00:00', train_records: 10, validation_records: 4, validation_metrics: { task: 'classification', accuracy: 0.9, macro_f1: 0.8 }, test_metrics: null, checkpoint: `ml/models/checkpoints/${id}`, production_ready: false, ...extra };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec));
  return rec;
}

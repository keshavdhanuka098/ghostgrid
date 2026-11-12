import tempfile, unittest
from pathlib import Path
from ml.tracking.wandb_tracker import DuplicateRun, TrackingError, WandbNotInstalled, build_payload, flatten_metrics, run_id_for, sync_record

class FakeRun:
    def __init__(self): self.summary = {}; self.logged = []; self.artifacts = []; self.finished = False; self.url = 'https://wandb.ai/me/p/runs/x'; self.entity = 'me'; self.project = 'p'
    def log(self, data, step=None): self.logged.append((step, data))
    def log_artifact(self, a): self.artifacts.append(a)
    def finish(self): self.finished = True
class FakeArtifact:
    def __init__(self, name, type=None, metadata=None): self.name = name; self.dirs = []
    def add_dir(self, d): self.dirs.append(d)
class FakeWandb:
    Artifact = FakeArtifact
    def __init__(self, existing=()): self.existing = set(existing); self.calls = []; self.run = FakeRun()
    def init(self, **kw):
        self.calls.append(kw)
        if kw['resume'] == 'never' and kw['id'] in self.existing: raise RuntimeError('run already exists')
        return self.run

def record(**extra):
    r = {'experiment_id': 'exp_20260101T000000Z_abcd1234', 'status': 'completed', 'task': 'classification', 'model_name': 'm', 'model_version': '1',
         'dataset_version': 'v1', 'dataset_fingerprint': 'fp', 'hyperparameters': {'n': 3}, 'train_records': 10, 'validation_records': 4,
         'started_at': '2026-01-01T00:00:00+00:00', 'completed_at': '2026-01-01T00:00:12+00:00',
         'validation_metrics': {'task': 'classification', 'accuracy': 0.9, 'macro_precision': 0.8, 'macro_recall': 0.7, 'macro_f1': 0.75,
                                'confusion_matrix': [[1]], 'labels': ['a'], 'per_class': {'a': {'precision': 1.0, 'recall': 1.0, 'f1': 1.0}}},
         'checkpoint': 'ml/models/checkpoints/exp_x'}
    r.update(extra); return r

class TrackerTests(unittest.TestCase):
    def test_payload_uses_only_real_values(self):
        p = build_payload(record())
        self.assertEqual(p['summary']['validation/accuracy'], 0.9); self.assertEqual(p['summary']['validation/f1'], 0.75)
        self.assertEqual(p['summary']['duration_seconds'], 12.0); self.assertNotIn('test/accuracy', p['summary'])
        self.assertNotIn('validation/confusion_matrix', p['summary']); self.assertEqual(p['config']['dataset_fingerprint'], 'fp')
        self.assertNotIn('validation/loss', p['summary'])  # never invent metrics the adapter did not produce

    def test_sync_logs_and_finishes_run_without_uploading_checkpoint_by_default(self):
        w = FakeWandb(); out = sync_record(record(), project='gg', wandb_module=w)
        self.assertEqual(out['run_id'], 'gg-exp_20260101T000000Z_abcd1234'); self.assertTrue(w.run.finished)
        self.assertEqual(w.calls[0]['resume'], 'never'); self.assertEqual(w.run.artifacts, []); self.assertFalse(out['uploaded_checkpoint'])
        self.assertEqual(w.run.summary['validation/accuracy'], 0.9)

    def test_history_is_logged_stepwise_only_when_adapter_supplied_it(self):
        w = FakeWandb(); sync_record(record(history=[{'epoch': 0, 'loss': 1.0}, {'epoch': 1, 'loss': 0.5}]), project='gg', wandb_module=w)
        self.assertEqual([s for s, _ in w.run.logged], [0, 1])

    def test_duplicate_run_is_refused(self):
        w = FakeWandb(existing={run_id_for('exp_20260101T000000Z_abcd1234')})
        with self.assertRaises(DuplicateRun): sync_record(record(), project='gg', wandb_module=w)

    def test_checkpoint_upload_requires_explicit_flag_and_stays_inside_backend(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t); (root / 'ml/models/checkpoints/exp_x').mkdir(parents=True)
            w = FakeWandb(); out = sync_record(record(), project='gg', backend_root=root, upload_checkpoint=True, wandb_module=w)
            self.assertTrue(out['uploaded_checkpoint'])
            w2 = FakeWandb(); out2 = sync_record(record(checkpoint='../../outside'), project='gg', backend_root=root, upload_checkpoint=True, wandb_module=w2)
            self.assertFalse(out2['uploaded_checkpoint'])

    def test_rejects_incomplete_runs_bad_ids_and_missing_package(self):
        with self.assertRaises(TrackingError): sync_record(record(status='failed'), project='gg', wandb_module=FakeWandb())
        with self.assertRaises(TrackingError): run_id_for('../etc/passwd')
        with self.assertRaises(TrackingError): sync_record(record(), project='bad project!', wandb_module=FakeWandb())
        import sys; sys.modules['wandb'] = None  # simulates "not installed"
        try:
            with self.assertRaises(WandbNotInstalled): sync_record(record(), project='gg')
        finally: sys.modules.pop('wandb', None)

    def test_flatten_ignores_non_numeric(self):
        self.assertEqual(flatten_metrics('t', {'accuracy': 1, 'labels': ['a'], 'x': 'nope', 'ok': True}), {'t/accuracy': 1.0})

if __name__ == '__main__': unittest.main()


class PipelineHookTests(unittest.TestCase):
    """Tracking is optional and must never break or alter local training."""
    def test_disabled_by_default_and_leaves_record_untouched(self):
        from ml.pipeline import _maybe_track
        rec = record(); _maybe_track(rec, {}, Path('.')); self.assertNotIn('tracking', rec)
        _maybe_track(rec, {'tracking': {'wandb': {'enabled': False}}}, Path('.')); self.assertNotIn('tracking', rec)

    def test_enabled_without_key_records_failure_but_does_not_raise(self):
        import os
        from ml.pipeline import _maybe_track
        os.environ.pop('WANDB_API_KEY', None)
        rec = record(); _maybe_track(rec, {'tracking': {'wandb': {'enabled': True}}}, Path('.'))
        self.assertEqual(rec['tracking']['wandb']['status'], 'failed'); self.assertIn('WANDB_API_KEY', rec['tracking']['wandb']['error'])

    def test_full_training_succeeds_with_tracking_enabled_and_no_network_or_key(self):
        import json, os, sys, types
        from ml.dataset import write_jsonl
        from ml.pipeline import train
        os.environ.pop('WANDB_API_KEY', None)
        mod = types.ModuleType('hook_adapter')
        class A:
            def fit(self, f, t, validation=None): self.l = t[0]
            def predict(self, f): return [self.l for _ in f]
            def save(self, p): Path(p + '.json').write_text('{}')
        mod.create_model = lambda task=None, **k: A(); sys.modules['hook_adapter'] = mod
        try:
            with tempfile.TemporaryDirectory() as t:
                root = Path(t); (root / 'ml' / 'configs').mkdir(parents=True); d = root / 'datasets' / 'processed'
                write_jsonl(d / 'train' / 'train.jsonl', [{'record_id': 'a', 'graph_id': 'g1', 'features': {'x': 1}, 'target': 'u'}])
                write_jsonl(d / 'validation' / 'validation.jsonl', [{'record_id': 'b', 'graph_id': 'g2', 'features': {'x': 2}, 'target': 'u'}])
                cfg = root / 'ml' / 'configs' / 'c.json'
                cfg.write_text(json.dumps({'task': 'classification', 'model_factory': 'hook_adapter:create_model', 'tracking': {'wandb': {'enabled': True}}}))
                out = train(cfg)
                self.assertEqual(out['status'], 'completed'); self.assertEqual(out['tracking']['wandb']['status'], 'failed')
                saved = json.loads((root / 'ml' / 'experiments' / f"{out['experiment_id']}.json").read_text())
                self.assertEqual(saved['status'], 'completed'); self.assertTrue((root / out['checkpoint'] / 'model.json').exists())
        finally: sys.modules.pop('hook_adapter', None)

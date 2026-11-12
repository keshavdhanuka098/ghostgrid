import json, tempfile, unittest
from pathlib import Path
from ml.profile import profile

class ProfileTests(unittest.TestCase):
    def test_profile_reports_real_counts(self):
        rows = [{'record_id': f'r{i}', 'graph_id': f'g{i % 4}', 'features': {'x': i, 'y': None if i == 0 else 1}, 'target': 'a' if i < 6 else 'b'} for i in range(8)]
        rows.append({'record_id': 'r0', 'graph_id': 'g0', 'features': {'x': 1}, 'target': 'a'})
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / 'd.jsonl'; p.write_text('\n'.join(json.dumps(r) for r in rows))
            out = profile(p)
        self.assertEqual(out['record_count'], 9); self.assertEqual(out['label_counts'], {'a': 7, 'b': 2})
        self.assertEqual(out['duplicate_record_ids'], 1); self.assertEqual(out['group_count'], 4)
        self.assertTrue(out['can_split_without_leakage']); self.assertEqual(out['features_with_missing_values'], {'y': 1})
        self.assertEqual(out['features_partially_present'], {'y': 8})

if __name__ == '__main__': unittest.main()

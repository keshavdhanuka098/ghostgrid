import tempfile
import unittest
from pathlib import Path
from ml.dataset import DatasetError, load_records, split_records, validate_records, write_jsonl
from ml.evaluation.metrics import evaluate
from ml.feature_engineering.graph_features import GraphFeatureExtractor

class DatasetTests(unittest.TestCase):
    def test_load_and_validate_jsonl(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'records.jsonl'
            records = [{'record_id':'r1','graph_id':'g1','features':{'n':1},'target':'up'}]
            write_jsonl(path, records)
            self.assertEqual(load_records(path), records)
            self.assertEqual(validate_records(records, require_target=True), [])

    def test_duplicate_ids_and_missing_target_are_reported(self):
        rows = [{'record_id':'same'}, {'record_id':'same'}]
        errors = validate_records(rows, require_target=True)
        self.assertTrue(any('duplicate record_id' in e for e in errors))
        self.assertTrue(any('target is required' in e for e in errors))

    def test_csv_feature_columns_are_loaded_as_numeric_features(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'records.csv'
            path.write_text('record_id,graph_id,feature__asset_count,target\nr1,g1,4,up\n',encoding='utf-8')
            row=load_records(path)[0]
            self.assertEqual(row['features'], {'asset_count':4})

    def test_graph_references_must_exist(self):
        rows = [{'record_id':'r1','graph':{'assets':[{'id':'a'}], 'dependencies':[{'id':'d','dependentId':'a','providerId':'missing'}]}}]
        errors = validate_records(rows)
        self.assertTrue(any('missing providerId' in e for e in errors))

    def test_split_keeps_graph_groups_together_and_is_reproducible(self):
        rows=[]
        for i in range(10):
            rows.append({'record_id':f'r{i}a','graph_id':f'g{i}','features':{'x':i},'target':i%2})
            rows.append({'record_id':f'r{i}b','graph_id':f'g{i}','features':{'x':i+1},'target':i%2})
        first=split_records(rows,seed=9); second=split_records(rows,seed=9)
        self.assertEqual(first, second)
        group_split={r['graph_id']: split for split, items in first.items() for r in items}
        self.assertEqual(len(group_split), 10)
        for split, items in first.items():
            self.assertEqual(len({r['graph_id'] for r in items}), len(items)//2)

    def test_graph_feature_extractor_uses_mapped_graph_only(self):
        row={'record_id':'r1','graph':{'assets':[{'id':'a','kind':'power','criticality':'critical'},{'id':'b','kind':'service','criticality':'low'}], 'dependencies':[{'id':'d','dependentId':'b','providerId':'a','mode':'required','status':'unknown'}]}}
        features=GraphFeatureExtractor().extract(row)
        self.assertEqual(features['asset_count'],2.0)
        self.assertEqual(features['dependency_count'],1.0)
        self.assertEqual(features['criticality_weight_sum'],9.0)
        self.assertEqual(features['unknown_dependency_count'],1.0)

    def test_invalid_target_labels_are_reported(self):
        rows=[{'record_id':'r1','target':'UNKNOWN'}]
        errors=validate_records(rows, allowed_labels={'SUPPORTED','REFUTED'})
        self.assertTrue(any('invalid target label' in e for e in errors))

    def test_binary_roc_auc_is_computed_only_with_probabilities(self):
        metrics=evaluate('classification',['no','yes','no','yes'],['no','yes','yes','yes'],[[.9,.1],[.2,.8],[.4,.6],[.1,.9]],['no','yes'])
        self.assertAlmostEqual(metrics['roc_auc'],1.0)

    def test_invalid_split_ratios_fail(self):
        with self.assertRaises(DatasetError): split_records([], .7, .2, .2)

    def test_classification_and_regression_metrics(self):
        self.assertAlmostEqual(evaluate('classification',['a','b'],['a','a'])['accuracy'], .5)
        metrics=evaluate('regression',[1,3],[2,3])
        self.assertAlmostEqual(metrics['mae'], .5)
        self.assertAlmostEqual(metrics['rmse'], (0.5)**.5)

if __name__ == '__main__': unittest.main()

import json, sys, tempfile, types, unittest
from pathlib import Path
from ml.dataset import write_jsonl
from ml.pipeline import train, evaluate_checkpoint

class TinyAdapter:
    def fit(self, features, targets, validation=None):
        self.label = max(set(targets), key=targets.count)
    def predict(self, features):
        return [self.label for _ in features]
    def save(self, path):
        Path(path + '.json').write_text(json.dumps({'label': self.label}), encoding='utf-8')
    def load(self, path):
        self.label = json.loads(Path(path + '.json').read_text(encoding='utf-8'))['label']

def create_model(task=None, **kwargs): return TinyAdapter()

class TinyProcessor:
    def fit(self, records): self.offset = 1
    def transform(self, records): return [{**row, 'features': {k: v + self.offset for k, v in row['features'].items()}} for row in records]
    def save(self, path): Path(path + '.json').write_text(json.dumps({'offset': self.offset}), encoding='utf-8')
    def load(self, path): self.offset = json.loads(Path(path + '.json').read_text(encoding='utf-8'))['offset']

def create_processor(): return TinyProcessor()

class PipelineTests(unittest.TestCase):
    def test_training_checkpoint_registry_and_test_evaluation(self):
        module = types.ModuleType('test_adapter'); module.create_model = create_model; module.create_processor = create_processor
        sys.modules['test_adapter'] = module
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); cfg_dir = root/'ml'/'configs'; cfg_dir.mkdir(parents=True)
                data = root/'datasets'/'processed'
                write_jsonl(data/'train'/'train.jsonl', [
                    {'record_id':'tr1','graph_id':'g-tr1','features':{'x':1},'target':'up'},
                    {'record_id':'tr2','graph_id':'g-tr2','features':{'x':2},'target':'up'}])
                write_jsonl(data/'validation'/'validation.jsonl', [{'record_id':'va1','graph_id':'g-va1','features':{'x':3},'target':'up'}])
                write_jsonl(data/'test'/'test.jsonl', [{'record_id':'te1','graph_id':'g-te1','features':{'x':4},'target':'up'}])
                config={'task':'classification','model_factory':'test_adapter:create_model','preprocessor_factory':'test_adapter:create_processor','model_name':'tiny','model_version':'0.0.1','data_root':'datasets/processed','models_root':'ml/models'}
                config_path=cfg_dir/'test.json'; config_path.write_text(json.dumps(config),encoding='utf-8')
                trained=train(config_path)
                self.assertEqual(trained['status'],'completed')
                self.assertFalse(trained['production_ready'])
                self.assertTrue((root/trained['checkpoint']/'model.json').exists())
                self.assertTrue((root/trained['checkpoint']/'preprocessor.json').exists())
                registry=root/'ml'/'models'/'registry'/f"{trained['experiment_id']}.json"
                self.assertTrue(registry.exists())
                evaluated=evaluate_checkpoint(config_path, trained['experiment_id'])
                self.assertIn('accuracy', evaluated['test_metrics'])
                self.assertEqual(evaluated['test_records'],1)
        finally:
            sys.modules.pop('test_adapter',None)

if __name__ == '__main__': unittest.main()

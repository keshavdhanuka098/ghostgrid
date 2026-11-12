"""Optional scikit-learn adapter. Install requirements-ml.txt before using it."""
from __future__ import annotations
from pathlib import Path
from typing import Any

class SklearnAdapter:
    def __init__(self, task: str = 'classification', **kwargs: Any):
        try:
            from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
        except ImportError as exc:
            raise RuntimeError('scikit-learn is optional; install it with: pip install -r requirements-ml.txt') from exc
        self.task = task
        estimator = RandomForestClassifier if task == 'classification' else RandomForestRegressor if task == 'regression' else None
        if estimator is None: raise ValueError("task must be 'classification' or 'regression'")
        self.estimator = estimator(**kwargs)
        self.feature_names: list[str] = []

    def _matrix(self, features: list[dict[str, Any]]):
        if not features: return []
        names = self.feature_names or sorted({key for row in features for key in row})
        matrix=[]
        for row in features:
            values=[]
            for name in names:
                value=row.get(name, 0)
                if isinstance(value, bool): value=int(value)
                if not isinstance(value, (int, float)): raise ValueError(f'Feature {name!r} must be numeric; encode categorical values in preprocessing')
                values.append(float(value))
            matrix.append(values)
        return matrix

    def fit(self, features, targets, validation=None):
        self.feature_names=sorted({key for row in features for key in row})
        self.estimator.fit(self._matrix(features), targets)

    def predict(self, features): return self.estimator.predict(self._matrix(features)).tolist()

    @property
    def classes_(self): return getattr(self.estimator, 'classes_', [])

    def predict_proba(self, features):
        if not hasattr(self.estimator, 'predict_proba'): raise AttributeError('This estimator does not expose predict_proba')
        return self.estimator.predict_proba(self._matrix(features)).tolist()

    def save(self, path: str):
        try: import joblib
        except ImportError as exc: raise RuntimeError('joblib is required; install requirements-ml.txt') from exc
        joblib.dump({'estimator':self.estimator,'feature_names':self.feature_names,'task':self.task}, Path(path).with_suffix('.joblib'))

    def load(self, path: str):
        try: import joblib
        except ImportError as exc: raise RuntimeError('joblib is required; install requirements-ml.txt') from exc
        state=joblib.load(Path(path).with_suffix('.joblib'))
        self.estimator=state['estimator']; self.feature_names=state['feature_names']; self.task=state['task']

def create_model(task: str = 'classification', **kwargs: Any) -> SklearnAdapter:
    return SklearnAdapter(task=task, **kwargs)

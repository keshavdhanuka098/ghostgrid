from __future__ import annotations
from typing import Any

def evaluate(task: str, actual: list[Any], predicted: list[Any], probabilities: list[list[float]] | None = None, classes: list[Any] | None = None) -> dict[str, Any]:
    if len(actual) != len(predicted): raise ValueError('Prediction count does not match target count')
    if not actual: raise ValueError('Cannot evaluate an empty split')
    if task == 'classification':
        labels = sorted({str(x) for x in actual} | {str(x) for x in predicted})
        correct = sum(str(a) == str(p) for a, p in zip(actual, predicted))
        per_class = {}
        f1s = []
        for label in labels:
            tp = sum(str(a) == label and str(p) == label for a, p in zip(actual, predicted))
            fp = sum(str(a) != label and str(p) == label for a, p in zip(actual, predicted))
            fn = sum(str(a) == label and str(p) != label for a, p in zip(actual, predicted))
            precision = tp / (tp + fp) if tp + fp else 0.0
            recall = tp / (tp + fn) if tp + fn else 0.0
            f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
            per_class[label] = {'precision': precision, 'recall': recall, 'f1': f1}
            f1s.append(f1)
        result = {'task': task, 'accuracy': correct / len(actual), 'macro_precision': sum(x['precision'] for x in per_class.values()) / len(labels), 'macro_recall': sum(x['recall'] for x in per_class.values()) / len(labels), 'macro_f1': sum(f1s) / len(f1s), 'confusion_matrix': [[sum(str(a) == actual_label and str(p) == pred_label for a,p in zip(actual,predicted)) for pred_label in labels] for actual_label in labels], 'labels': labels, 'per_class': per_class}
        # Binary ROC-AUC is included only when the adapter supplies class probabilities.
        if probabilities is not None and classes is not None and len(classes) == 2:
            positive = classes[1]
            positive_scores = [float(row[1]) for row in probabilities]
            positives = [score for label, score in zip(actual, positive_scores) if str(label) == str(positive)]
            negatives = [score for label, score in zip(actual, positive_scores) if str(label) != str(positive)]
            if positives and negatives:
                wins = sum(1.0 if p > n else 0.5 if p == n else 0.0 for p in positives for n in negatives)
                result['roc_auc'] = wins / (len(positives) * len(negatives))
        return result
    if task == 'regression':
        pairs = [(float(a), float(p)) for a,p in zip(actual,predicted)]
        mae = sum(abs(a-p) for a,p in pairs) / len(pairs)
        rmse = (sum((a-p)**2 for a,p in pairs) / len(pairs)) ** .5
        return {'task': task, 'mae': mae, 'rmse': rmse}
    raise ValueError("task must be 'classification' or 'regression'")

"""Feature extractor adapter contract."""
from typing import Any, Protocol
class FeatureExtractor(Protocol):
    def extract(self, record: dict[str, Any]) -> dict[str, float]: ...

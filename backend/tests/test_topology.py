import unittest
from ml.feature_engineering.topology import extract_graph_features

def g():
    a = lambda i, c='medium': {'id': i, 'name': i, 'kind': 'service', 'criticality': c}
    d = lambda x, y, m='required': {'dependentId': x, 'providerId': y, 'mode': m, 'status': 'confirmed'}
    return {'assets': [a('feed'), a('fibre'), a('cloud'), a('dispatch', 'critical'), a('pay', 'high')],
            'dependencies': [d('fibre', 'feed'), d('cloud', 'feed'), d('dispatch', 'fibre'), d('pay', 'cloud')]}

class TopologyTests(unittest.TestCase):
    def test_hidden_shared_dependency_is_found(self):
        out = extract_graph_features(g())
        feed = next(n for n in out['assets'] if n['id'] == 'feed')['features']
        self.assertEqual(feed['cascade_reach'], 4)
        self.assertEqual(feed['hidden_reach'], 2)
        self.assertTrue(feed['is_hidden_shared_dependency'])
        self.assertEqual(out['graph']['max_dependency_depth'], 2.0)
        self.assertEqual(out['assets'][0]['id'], 'feed')

    def test_alternate_providers_need_all_to_fail(self):
        gr = g()
        gr['assets'].append({'id': 'bak', 'name': 'bak', 'kind': 'power', 'criticality': 'low'})
        gr['dependencies'] = [{'dependentId': 'fibre', 'providerId': 'feed', 'mode': 'alternate', 'status': 'inferred'},
                              {'dependentId': 'fibre', 'providerId': 'bak', 'mode': 'alternate', 'status': 'confirmed'}]
        feed = next(n for n in extract_graph_features(gr)['assets'] if n['id'] == 'feed')['features']
        self.assertEqual(feed['cascade_reach'], 0)

    def test_empty_graph(self):
        self.assertEqual(extract_graph_features({})['graph']['asset_count'], 0.0)

if __name__ == '__main__':
    unittest.main()

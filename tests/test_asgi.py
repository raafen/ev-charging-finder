import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from ev_charging_finder.main import app
from ev_charging_finder.app import limiter


class DocumentedAPITests(unittest.TestCase):
    def setUp(self):
        limiter.entries.clear()
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    @patch("ev_charging_finder.app.lookup_zip", return_value=(42.06, -72.61, "01001 — Agawam, MA"))
    @patch("ev_charging_finder.finder.OpenChargeMapProvider")
    def test_openapi_search_executes_against_mounted_backend(self, factory, lookup):
        factory.return_value.search.return_value = [{"ID": 1, "AddressInfo": {"Title": "Test record", "Latitude": 42.06, "Longitude": -72.61}}]
        schema = self.client.get('/openapi.json').json()
        operation = schema['paths']['/api/search']['post']
        self.assertEqual(operation['requestBody']['content']['application/json']['schema']['$ref'], '#/components/schemas/SearchRequest')
        response = self.client.post('/api/search', json={'location_mode': 'zip', 'zip_code': '01001', 'radius': 10})
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual([station['id'] for station in result['stations']], [1])
        self.assertEqual(result['stations'][0]['name'], 'Test record')
        self.assertEqual(result['location'], "01001 — Agawam, MA")
        self.assertNotIn('demo', result)
        self.assertNotIn('fictional', result['stations'][0])
        self.assertTrue(response.headers['x-request-id'])
        self.assertEqual(self.client.post('/api/search', json={'location_mode': 'coordinates', 'latitude': 91, 'longitude': 0}).status_code, 400)

    def test_estimate_requires_vehicle_power_and_keeps_missing_fees_unknown(self):
        payload = {'vehicle': {'battery_kwh': 80}, 'start_percent': 20, 'target_percent': 80,
                   'station_power_kw': 150, 'current_type': 'DC', 'efficiency_percent': 80}
        self.assertEqual(self.client.post('/api/estimate', json=payload).status_code, 400)
        payload['vehicle']['max_dc_kw'] = 100
        response = self.client.post('/api/estimate', json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['minutes'], 36)
        self.assertEqual(response.json()['effective_power_kw'], 100)
        self.assertIsNone(response.json()['total'])
        self.assertFalse(response.json()['pricing_complete'])


if __name__ == '__main__':
    unittest.main()

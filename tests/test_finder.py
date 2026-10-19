import unittest
from unittest.mock import patch, Mock
import requests
from finder import search, distance_km, FinderError, lookup_zip, normalize
from app import app
from providers import station_cache, reference_cache, zip_cache
from app import limiter

class FinderTests(unittest.TestCase):
    def setUp(self):
        station_cache.clear()
        reference_cache.clear()
        zip_cache.clear()
        limiter.entries.clear()

    def test_distance(self):
        self.assertAlmostEqual(distance_km(0, 0, 0, 1), 111.195, places=2)

    def test_demo_sort_and_filter(self):
        stations = search(40.758, -73.9855, demo=True)
        self.assertEqual(len(stations), 8)
        self.assertEqual([s["distance_miles"] for s in stations], sorted(s["distance_miles"] for s in stations))
        self.assertEqual(len({s["id"] for s in stations}), 8)
        self.assertTrue(all(s["fictional"] for s in stations))
        self.assertEqual(len(search(40.758, -73.9855, demo=True, operational_only=True)), 6)
        self.assertEqual(search(0, 0, demo=True), [])

    def test_validation(self):
        for lat, lon, radius, limit in [(91,0,10,20),(0,181,10,20),(float('nan'),0,10,20),(0,0,0,20),(0,0,10,101)]:
            with self.assertRaises(ValueError):
                search(lat, lon, radius, limit, demo=True)

    @patch.dict('os.environ', {'OCM_API_KEY': 'test-key'})
    @patch('finder.requests.get')
    def test_api_request_and_missing_coordinates(self, get):
        get.return_value = Mock(json=Mock(return_value=[{'AddressInfo': {}}]))
        self.assertEqual(search(0,0), [])
        self.assertEqual(get.call_args.kwargs['headers']['X-API-Key'], 'test-key')
        self.assertEqual(get.call_args.kwargs['params']['distanceunit'], 'miles')
        self.assertEqual(get.call_args.kwargs['timeout'], (5,20))

    @patch.dict('os.environ', {'OCM_API_KEY': 'test-key'})
    @patch('finder.requests.get')
    def test_timeout_and_invalid_response(self, get):
        get.side_effect = requests.Timeout()
        with self.assertRaises(FinderError):
            search(0,0)
        get.side_effect = None
        get.return_value = Mock(json=Mock(return_value={}))
        with self.assertRaises(FinderError):
            search(0,0)
        get.return_value.json.side_effect = ValueError()
        with self.assertRaises(FinderError):
            search(0,0)

    def test_miles_boundary(self):
        records = [{"AddressInfo": {"Latitude": 0, "Longitude": 1}}]
        self.assertEqual(normalize(records, 0, 0, 69, 20, False), [])
        stations = normalize(records, 0, 0, 70, 20, False)
        self.assertAlmostEqual(stations[0]['distance_miles'], 69.0934, places=3)

    @patch('finder.requests.get')
    def test_zip_lookup(self, get):
        get.return_value = Mock(status_code=200, json=Mock(return_value={"places": [{"latitude": "42.06", "longitude": "-72.61", "place name": "Agawam", "state abbreviation": "MA"}]}))
        self.assertEqual(lookup_zip('01001')[:2], (42.06, -72.61))
        self.assertEqual(get.call_args.args[0], 'https://api.zippopotam.us/us/01001')
        get.return_value.status_code = 404
        with self.assertRaises(FinderError):
            lookup_zip('00000')
        get.side_effect = requests.Timeout()
        with self.assertRaises(FinderError):
            lookup_zip('10036')
        with self.assertRaises(ValueError):
            lookup_zip('1234')

    def test_web_zip_demo(self):
        client = app.test_client()
        response = client.post('/', data={'location_mode':'zip','zip_code':'10036','radius':'10','limit':'20','demo':'on'})
        self.assertIn(b'Demo Central Garage', response.data)
        self.assertIn(b'miles', response.data)
        response = client.post('/', data={'location_mode':'zip','zip_code':'abc','radius':'10','limit':'20','demo':'on'})
        self.assertIn(b'five-digit US ZIP', response.data)

    def test_web_demo_and_bad_input(self):
        client = app.test_client()
        self.assertEqual(client.get('/').status_code, 200)
        response = client.post('/', data={'latitude':'40.758','longitude':'-73.9855','radius':'10','limit':'20','demo':'on'})
        self.assertIn(b'Demo Central Garage', response.data)
        response = client.post('/', data={'latitude':'91','longitude':'0','radius':'10','limit':'20','demo':'on'})
        self.assertIn(b'Latitude must be', response.data)

if __name__ == '__main__':
    unittest.main()

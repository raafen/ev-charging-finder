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

    @patch("finder.OpenChargeMapProvider")
    def test_upstream_sort_and_filter(self, factory):
        factory.return_value.search.return_value = [
            {"ID": 2, "AddressInfo": {"Title": "Test record", "Latitude": 0, "Longitude": .02}, "StatusType": {"IsOperational": False}},
            {"ID": 1, "AddressInfo": {"Title": "Test record", "Latitude": 0, "Longitude": .01}, "StatusType": {"IsOperational": True}},
        ]
        stations = search(0, 0)
        self.assertEqual([s["id"] for s in stations], [1, 2])
        self.assertEqual([s["name"] for s in stations], ["Test record", "Test record"])
        self.assertEqual([s["id"] for s in search(0, 0, operational_only=True)], [1])
        self.assertNotIn("fictional", stations[0])

    def test_validation(self):
        for lat, lon, radius, limit in [(91,0,10,20),(0,181,10,20),(float('nan'),0,10,20),(0,0,0,20),(0,0,10,101)]:
            with self.assertRaises(ValueError):
                search(lat, lon, radius, limit)

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

    @patch("app.search")
    @patch("app.lookup_zip")
    def test_web_zip_results_and_error(self, lookup, search_mock):
        lookup.return_value = (42.06, -72.61, "01001 — Agawam, MA")
        search_mock.return_value = []
        client = app.test_client()
        response = client.post('/', data={'zip_code':'01001','radius':'10','limit':'100'})
        self.assertEqual(response.status_code, 200)
        search_mock.assert_called_once_with(42.06, -72.61, 10, 100, operational_only=False)
        lookup.side_effect = ValueError("Enter a five-digit US ZIP code.")
        response = client.post('/', data={'zip_code':'abc'})
        self.assertEqual(response.status_code, 400)
        self.assertIn(b'five-digit US ZIP', response.data)

    @patch("app.lookup_zip")
    @patch("app.search")
    @patch("app.render_template", return_value="empty")
    def test_initial_page_has_no_network_or_results(self, render, search_mock, lookup):
        self.assertEqual(app.test_client().get('/').status_code, 200)
        search_mock.assert_not_called()
        lookup.assert_not_called()
        self.assertEqual(render.call_args.kwargs["initial_data"]["stations"], [])
        self.assertIsNone(render.call_args.kwargs["initial_data"]["error"])
        self.assertEqual(render.call_args.kwargs["values"], {"zip_code": "", "radius": "10", "limit": "100"})

    @patch("app.render_template", return_value="results")
    @patch("app.lookup_zip", return_value=(42.06, -72.61, "01001 — Agawam, MA"))
    @patch("app.search", return_value=[])
    def test_html_post_boot_retains_resolved_location(self, search_mock, lookup, render):
        response = app.test_client().post("/", data={"zip_code": "01001"})
        self.assertEqual(response.status_code, 200)
        boot = render.call_args.kwargs["initial_data"]
        self.assertEqual(boot["center"], [42.06, -72.61])
        self.assertEqual(boot["location"], "01001 — Agawam, MA")
        self.assertTrue(boot["retrieved_at"])

if __name__ == '__main__':
    unittest.main()

import json
import threading
import unittest
from unittest.mock import Mock, patch
import requests
from app import app, limiter, RateLimiter
from finder import normalize, route_search, get_station
from providers import FinderError, TTLCache, request_json, OSRMProvider, OpenChargeMapProvider, station_cache, reference_cache, zip_cache


class CacheTests(unittest.TestCase):
    def test_expiry_eviction_and_mutation_isolation(self):
        now = [0]
        cache = TTLCache(2, 10, clock=lambda: now[0])
        cache.put("a", {"items": [1]})
        cached = cache.get("a")
        cached["items"].append(2)
        self.assertEqual(cache.get("a"), {"items": [1]})
        cache.put("b", 2)
        cache.get("a")
        cache.put("c", 3)
        self.assertIsNone(cache.get("b"))
        now[0] = 10
        self.assertIsNone(cache.get("a"))

    def test_parallel_access_stays_bounded(self):
        cache = TTLCache(4, 60)
        threads = [threading.Thread(target=lambda n=n: [cache.put((n, i), i) for i in range(20)]) for n in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertLessEqual(len(cache._items), 4)

    def test_rate_limit_window_and_capacity(self):
        now = [0]
        rate = RateLimiter(2, clock=lambda: now[0])
        self.assertTrue(rate.allow("one", 1)[0])
        self.assertFalse(rate.allow("one", 1)[0])
        now[0] = 60
        self.assertTrue(rate.allow("one", 1)[0])
        rate.allow("two", 1)
        rate.allow("three", 1)
        self.assertEqual(len(rate.entries), 2)


class ProviderTests(unittest.TestCase):
    def setUp(self):
        station_cache.clear()
        reference_cache.clear()
        zip_cache.clear()
        limiter.entries.clear()
        self.client = app.test_client()

    @patch("providers.time.sleep")
    @patch("providers.requests.get")
    def test_transient_retry_only(self, get, sleep):
        get.side_effect = [Mock(status_code=503), Mock(status_code=200, json=Mock(return_value=[]))]
        self.assertEqual(request_json("https://example.invalid"), [])
        self.assertEqual(get.call_count, 2)
        get.reset_mock()
        response = Mock(status_code=401)
        response.raise_for_status.side_effect = requests.HTTPError()
        get.side_effect = None
        get.return_value = response
        with self.assertRaises(FinderError) as caught:
            request_json("https://example.invalid")
        self.assertEqual(caught.exception.status, 502)
        self.assertEqual(get.call_count, 1)

    def test_nested_malformed_data_is_safe_and_raw_free(self):
        record = {"ID": 123, "AddressInfo": {"Latitude": 40.758, "Longitude": -73.9855},
                  "StatusType": ["broken"], "DataProvider": "broken", "OperatorInfo": 7,
                  "Connections": [None, "bad", {"ConnectionType": {"ID": [], "Title": "CCS (Type 1)"}, "CurrentType": [], "PowerKW": "nan", "Voltage": {}, "Amps": True, "Quantity": "many"}],
                  "Secret": "private", "UsageCost": {"bad": "data"}}
        station = normalize([None, {"AddressInfo": []}, record], 40.758, -73.9855, 1, 10, False)[0]
        self.assertEqual(station["connectors"], ["CCS1"])
        self.assertIsNone(station["max_power_kw"])
        self.assertIsNone(station["operational"])
        self.assertNotIn("Secret", station)
        self.assertNotIn("AddressInfo", station)
        self.assertEqual(station["pricing"], "Price not provided")
        self.assertEqual(normalize([record], 40.758, -73.9855, 1, 10, True), [])

    def test_reference_data_and_operator_are_distinct_from_host(self):
        record = {"ID": 9, "AddressInfo": {"Latitude": 0, "Longitude": 0, "Title": "Host parking"},
                  "OperatorID": 5, "StatusTypeID": 50, "Connections": [{"ConnectionTypeID": 32, "CurrentTypeID": 30, "PowerKW": "150", "Quantity": "2", "Voltage": 400, "Amps": 375}]}
        refs = {"Operators": [{"ID": 5, "Title": "Network operator"}], "StatusTypes": [{"ID": 50, "IsOperational": True, "Title": "Operational"}]}
        station = normalize([record], 0, 0, 1, 10, True, refs)[0]
        self.assertEqual(station["network"], "Network operator")
        self.assertIsNone(station["host"])
        self.assertEqual(station["connections"][0]["current_type"], "DC")
        self.assertEqual(station["connections"][0]["quantity"], 2)
        self.assertEqual(station["max_power_kw"], 150)
        self.assertEqual(station["availability"], "unknown")

    @patch("providers.request_json")
    def test_reference_cache(self, fetch):
        fetch.return_value = {"ConnectionTypes": []}
        provider = OpenChargeMapProvider("test-key")
        provider.references()
        provider.references()
        self.assertEqual(fetch.call_count, 1)

    @patch.dict("os.environ", {"OCM_API_KEY": "private-secret", "ROUTING_BASE_URL": "https://private:password@routing.invalid"})
    def test_config_health_and_boot_never_expose_secrets(self):
        response = self.client.get("/api/config")
        self.assertTrue(response.json["live_search"])
        self.assertTrue(response.json["routing"])
        self.assertNotIn(b"private-secret", response.data)
        self.assertNotIn(b"password", response.data)
        self.assertEqual(self.client.get("/healthz").json, {"status": "ok"})
        self.assertEqual(self.client.get("/readyz").status_code, 200)
        page = self.client.get("/")
        self.assertNotIn(b"private-secret", page.data)
        self.assertIn(b"demo-8", page.data)

    def test_search_validation_and_stable_demo_sharing(self):
        for body in ([], None, {"latitude": True}, {"radius": "nan"}, {"limit": 1.5}):
            with self.subTest(body=body):
                response = self.client.post("/api/search", json=body)
                self.assertEqual(response.status_code, 400)
                self.assertIn("request_id", response.json)
        response = self.client.post("/api/search", json={"demo": True})
        self.assertEqual(response.status_code, 200)
        self.assertIn("retrieved_at", response.json)
        station = self.client.get("/api/station/demo-1")
        self.assertTrue(station.json["demo"])
        self.assertEqual(station.json["station"]["id"], "demo-1")
        self.assertEqual(self.client.get("/api/station/demo-999").status_code, 404)

    @patch.dict("os.environ", {"OCM_API_KEY": "", "ROUTING_BASE_URL": ""})
    def test_unconfigured_live_and_route_have_useful_status(self):
        self.assertEqual(self.client.post("/api/search", json={}).status_code, 503)
        response = self.client.post("/api/route", json={"origin": [40, -73], "destination": [41, -74]})
        self.assertEqual(response.status_code, 503)
        self.assertIn("not configured", response.json["error"])

    @patch.dict("os.environ", {"RATE_LIMIT_PER_MINUTE": "1"})
    def test_rate_limit_response(self):
        self.assertEqual(self.client.get("/api/config").status_code, 200)
        response = self.client.get("/api/config")
        self.assertEqual(response.status_code, 429)
        self.assertIn("Retry-After", response.headers)
        self.assertIn("X-Request-ID", response.headers)

    def test_request_log_excludes_private_inputs(self):
        with patch.object(app.logger, "info") as log:
            response = self.client.post("/api/search", json={"demo": True, "latitude": 41.123456, "longitude": -73.654321})
        record = json.loads(log.call_args.args[0])
        self.assertEqual(record["request_id"], response.headers["X-Request-ID"])
        self.assertEqual(set(record), {"event", "request_id", "method", "endpoint", "status", "duration_ms"})


class RouteTests(unittest.TestCase):
    def setUp(self):
        limiter.entries.clear()
        self.client = app.test_client()

    def test_route_input_validation_precedes_provider(self):
        for origin in (None, [91, 0], [True, 0], [float("nan"), 0], [0], "40,-73"):
            response = self.client.post("/api/route", json={"origin": origin, "destination": [40, -73]})
            self.assertEqual(response.status_code, 400)
        response = self.client.post("/api/route", json={"origin": [40, -73], "destination": [41, -74], "range_miles": 20, "reserve_miles": 20})
        self.assertEqual(response.status_code, 400)

    @patch("providers.request_json")
    def test_osrm_coordinates_units_and_provider_errors(self, fetch):
        fetch.return_value = {"code": "Ok", "routes": [{"distance": 1609.344, "duration": 120, "geometry": {"type": "LineString", "coordinates": [[-73, 40], [-74, 41]]}}]}
        provider = OSRMProvider("https://router.invalid")
        result = provider.route([[40, -73], [41, -74]])
        self.assertEqual(result["distance_miles"], 1)
        self.assertEqual(result["duration_minutes"], 2)
        self.assertIn("-73.000000,40.000000;-74.000000,41.000000", fetch.call_args.args[0])
        fetch.return_value = {"code": "NoRoute"}
        with self.assertRaises(FinderError) as caught:
            provider.route([[40, -73], [41, -74]])
        self.assertEqual(caught.exception.status, 422)
        fetch.return_value = {"code": "Ok", "routes": [{"distance": "nan", "duration": 12, "geometry": {}}]}
        with self.assertRaises(FinderError) as caught:
            provider.route([[40, -73], [41, -74]])
        self.assertEqual(caught.exception.status, 502)

    @patch("finder.search")
    def test_detours_and_stop_legs_use_provider_not_aerial_distance(self, search):
        search.return_value = [{"id": 1, "latitude": 0, "longitude": .5, "operational": True, "connections": [{"connector": "CCS1", "current_type": "DC"}]}]
        class RouteProvider:
            calls = []
            def route(self, points):
                self.calls.append(points)
                miles = 90 if points == [[0.0, 0.0], [0.0, 1.0]] else 55
                return {"distance_miles": miles, "duration_minutes": miles, "geometry": {"type": "LineString", "coordinates": [[0, 0], [.5, 0], [1, 0]]}}
        provider = RouteProvider()
        result = route_search({"origin": [0, 0], "destination": [0, 1], "range_miles": 70, "reserve_miles": 10,
                               "vehicle": {"connectors": ["CCS1"]}, "manual_station_costs": {"1": 12}}, provider)
        self.assertEqual(result["stations"][0]["route"]["detour_miles"], 20)
        self.assertEqual(result["stations"][0]["route"]["detour_minutes"], 20)
        self.assertEqual(result["stop_plan"]["status"], "conditional")
        self.assertEqual(result["stop_plan"]["stops"][0]["leg_miles"], 55)
        self.assertEqual(result["alternatives"]["cheap"], [{"id": 1, "assumed_session_cost": 12}])
        self.assertFalse(result["coverage"]["complete"])
        self.assertGreaterEqual(len(provider.calls), 5)

    @patch("finder.OSRMProvider")
    def test_route_provider_error_status_propagates(self, factory):
        factory.return_value.route.side_effect = FinderError("Routing provider timed out.", 504)
        response = self.client.post("/api/route", json={"origin": [0, 0], "destination": [0, 1]})
        self.assertEqual(response.status_code, 504)


if __name__ == "__main__":
    unittest.main()

"""Behavioral Chromium tests with test-only provider responses, never shipped data."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect
from werkzeug.serving import make_server

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from ev_charging_finder.app import app
from scripts.build_pages import build, DEFAULT_API_BASE


# Invented records belong only to this test fixture, not the application export.
TEST_STATIONS = [
    {"id": 901001, "name": "Test Riverside Charging", "network": "Test North Network",
     "address": "Test address A", "latitude": 40.759, "longitude": -73.986,
     "distance_miles": 0.2, "max_power_kw": 250, "points": 4,
     "connectors": ["NACS"], "operational": True,
     "connections": [{"connector": "NACS", "current_type": "DC", "power_kw": 250, "quantity": 4}],
     "provider": "Browser test fixture", "retrieved_at": "2026-10-18T12:00:00+00:00"},
    {"id": 901002, "name": "Test Library Charging", "network": "Test South Network",
     "address": "Test address B", "latitude": 40.760, "longitude": -73.987,
     "distance_miles": 0.6, "max_power_kw": 11, "points": 2,
     "connectors": ["J1772"], "operational": None,
     "connections": [{"connector": "J1772", "current_type": "AC", "power_kw": 11, "quantity": 2}],
     "provider": "Browser test fixture", "retrieved_at": "2026-10-18T12:00:00+00:00"},
    {"id": 901003, "name": "Test Market Charging", "network": "Test South Network",
     "address": "Test address C", "latitude": 40.761, "longitude": -73.988,
     "distance_miles": 1.1, "max_power_kw": 150, "points": 3,
     "connectors": ["CCS1"], "operational": False,
     "connections": [{"connector": "CCS1", "current_type": "DC", "power_kw": 150, "quantity": 3}],
     "provider": "Browser test fixture", "retrieved_at": "2026-10-18T12:00:00+00:00"},
]


class WorkspaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        project = Path(cls.temporary.name) / "ev-charging-finder"
        # Exercise production API-base resolution even when the shell is local.
        with patch.dict("os.environ", {"API_BASE_URL": DEFAULT_API_BASE}):
            build(project)
        cls.flask = make_server("127.0.0.1", 0, app, threaded=True)
        # Only capability metadata is patched server-side. Station/search responses
        # are supplied exclusively by the per-context Playwright route below.
        capabilities = patch("ev_charging_finder.app.public_config", return_value={
            "mode": "server", "live_search": True, "routing": False,
            "vehicle_provider": "manual", "availability": False,
        })
        capabilities.start()
        cls.addClassCleanup(capabilities.stop)
        handler = partial(SimpleHTTPRequestHandler, directory=cls.temporary.name)
        cls.pages = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.servers = [cls.flask, cls.pages]
        cls.threads = []
        for server in cls.servers:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            cls.threads.append(thread)
        cls.urls = {
            "flask": f"http://127.0.0.1:{cls.flask.server_port}/",
            "pages": f"http://127.0.0.1:{cls.pages.server_port}/ev-charging-finder/",
        }
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        for server in cls.servers:
            server.shutdown()
            server.server_close()
        for thread in cls.threads:
            thread.join()
        cls.temporary.cleanup()

    def open_workspace(self, mode, mobile=False):
        context = self.browser.new_context(
            viewport={"width": 390 if mobile else 1440, "height": 844 if mobile else 1000},
            service_workers="block", permissions=["geolocation"],
            geolocation={"latitude": 40.758, "longitude": -73.9855},
        )
        self.addCleanup(context.close)
        endpoint = (DEFAULT_API_BASE if mode == "pages" else self.urls[mode]) + "api/"
        requests = []
        behavior = {"search": "success"}
        public_config = {"mode": "server", "live_search": True, "routing": False}

        def provider_fixture(route):
            request = route.request
            if request.url.startswith(endpoint):
                headers = {
                    "Access-Control-Allow-Origin": f"{urlsplit(self.urls[mode]).scheme}://{urlsplit(self.urls[mode]).netloc}",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Content-Type": "application/json",
                }
                if request.method == "OPTIONS":
                    route.fulfill(status=204, headers=headers)
                    return
                payload = request.post_data_json if request.post_data else None
                requests.append({"url": request.url, "method": request.method, "data": payload})
                path = urlsplit(request.url).path
                status = 200
                if path == "/api/config":
                    response = public_config
                elif path == "/api/search" and request.method == "POST":
                    if behavior["search"] == "failure":
                        status, response = 503, {"error": "Test provider temporarily unavailable.", "request_id": "browser-test"}
                    else:
                        response = {
                            "stations": [] if behavior["search"] == "empty" else TEST_STATIONS,
                            "center": [40.758, -73.9855], "location": "Test ZIP search area",
                            "retrieved_at": "2026-10-18T12:00:00+00:00",
                        }
                elif path.startswith("/api/station/"):
                    station_id = path.rsplit("/", 1)[-1]
                    response = next((station for station in TEST_STATIONS if str(station["id"]) == station_id), None)
                    if response is None:
                        status, response = 404, {"error": "Test station not found."}
                else:
                    status, response = 404, {"error": "Unexpected test endpoint."}
                route.fulfill(status=status, headers=headers, body=json.dumps(response))
            elif request.url.startswith(self.urls[mode]) and "/api/" not in request.url:
                route.continue_()
            else:
                # Deliberately fail map/CDN resources; the owned search UI must work.
                route.abort()

        context.route("**/*", provider_fixture)
        page = context.new_page()
        attempted_api_urls = []
        page.on("request", lambda request: attempted_api_urls.append(request.url) if "/api/" in request.url else None)
        page.goto(self.urls[mode], wait_until="domcontentloaded")
        page.locator("#zip").wait_for(state="visible")
        expect(page.locator("#results .station-card")).to_have_count(0)
        expect(page.locator("#zip")).to_have_value("")
        boot = json.loads(page.locator("#initial-data").text_content())
        self.assertEqual(boot["stations"], [])
        if mode == "pages":
            self.assertEqual(boot["config"]["api_base"], DEFAULT_API_BASE)
            self.assertTrue(boot["config"]["live_search"])
        self.assertFalse(any(item["url"].endswith("/search") for item in requests))
        self.addCleanup(lambda: self.assertTrue(all(url.startswith(endpoint) for url in attempted_api_urls), attempted_api_urls))
        return page, requests, behavior, endpoint

    def search_zip(self, page, endpoint, zip_code="10036", keyboard=False):
        page.locator("#zip").fill(zip_code)
        with page.expect_response(lambda response: response.url == endpoint + "search" and response.request.method == "POST"):
            if keyboard:
                page.locator("#zip").press("Enter")
            else:
                page.locator("#submit").click()
        expect(page.locator("#submit")).to_be_enabled()
        expect(page.locator("#results")).not_to_have_attribute("aria-busy", "true")

    def test_live_zip_radius_and_location_search(self):
        for mode in self.urls:
            with self.subTest(mode=mode):
                page, requests, _, endpoint = self.open_workspace(mode)
                self.search_zip(page, endpoint)
                expect(page.locator("#results .station-card")).to_have_count(3)
                expect(page.locator('[data-station="901001"]')).to_contain_text("Test Riverside Charging")
                request = [item for item in requests if item["url"] == endpoint + "search"][-1]
                self.assertEqual(request["data"]["location_mode"], "zip")
                self.assertEqual(request["data"]["zip_code"], "10036")
                self.assertEqual(float(request["data"]["radius"]), 10)
                with page.expect_response(lambda response: response.url == endpoint + "search" and response.request.method == "POST"):
                    page.locator('[name="radius"]').select_option("25")
                expect(page.locator("#submit")).to_be_enabled()
                self.assertEqual(float([item for item in requests if item["url"] == endpoint + "search"][-1]["data"]["radius"]), 25)
                expect(page.locator("#radius-label")).to_contain_text("25 mi")
                with page.expect_response(lambda response: response.url == endpoint + "search" and response.request.method == "POST"):
                    page.locator("#locate").click()
                expect(page.locator("#submit")).to_be_enabled()
                located = [item for item in requests if item["url"] == endpoint + "search"][-1]["data"]
                self.assertEqual(located["location_mode"], "coordinates")
                self.assertAlmostEqual(float(located["latitude"]), 40.758)
                self.assertAlmostEqual(float(located["longitude"]), -73.9855)

    def test_filters_clear_and_sort_retrieved_results(self):
        for mode in self.urls:
            with self.subTest(mode=mode):
                page, requests, _, endpoint = self.open_workspace(mode)
                self.search_zip(page, endpoint)
                expect(page.locator("#results .station-card")).to_have_count(3)
                count = len(requests)
                page.locator("#filters-toggle").click()
                page.locator("#connector").select_option("NACS")
                expect(page.locator("#results .station-card")).to_have_count(1)
                expect(page.locator('[data-station="901001"]')).to_be_visible()
                page.locator("#reset-filters").click()
                expect(page.locator("#results .station-card")).to_have_count(3)
                page.locator("#power").click()
                expect(page.locator("#results .station-card")).to_have_count(2)
                page.locator("#quick-reset").click()
                page.locator("#sort").select_option("name")
                expect(page.locator("#results .station-card").first).to_contain_text("Test Library Charging")
                self.assertEqual(len(requests), count, "Local filters must not repeat provider searches")

    def test_keyboard_search_and_theme_persistence(self):
        for mode in self.urls:
            with self.subTest(mode=mode):
                page, _, _, endpoint = self.open_workspace(mode)
                self.search_zip(page, endpoint, keyboard=True)
                expect(page.locator("#results .station-card")).to_have_count(3)
                before = page.locator("html").get_attribute("data-theme")
                after = "light" if before == "dark" else "dark"
                page.locator("#theme").focus()
                page.keyboard.press("Enter")
                expect(page.locator("html")).to_have_attribute("data-theme", after)
                page.locator("#garage-nav").focus()
                page.keyboard.press("Enter")
                expect(page.locator("#modal")).to_be_visible()
                page.keyboard.press("Escape")
                expect(page.locator("#modal")).not_to_be_visible()
                expect(page.locator("#garage-nav")).to_be_focused()
                page.reload(wait_until="domcontentloaded")
                expect(page.locator("html")).to_have_attribute("data-theme", after)
                expect(page.locator("#zip")).to_have_value("")

    def test_mobile_search_remains_accessible_with_sheet(self):
        for mode in self.urls:
            with self.subTest(mode=mode):
                page, _, _, endpoint = self.open_workspace(mode, mobile=True)
                expect(page.locator("#zip")).to_be_in_viewport()
                expect(page.locator("#locate")).to_be_in_viewport()
                self.search_zip(page, endpoint)
                toggle = page.locator("#sheet-toggle")
                expect(toggle).to_be_visible()
                expect(toggle).to_have_attribute("aria-expanded", "false")
                toggle.click()
                expect(toggle).to_have_attribute("aria-expanded", "true")
                expect(page.locator(".sidebar")).to_have_class(re.compile(r"\bexpanded\b"))
                expect(page.locator("#zip")).to_be_in_viewport()
                expect(page.locator("#submit")).to_be_in_viewport()
                self.search_zip(page, endpoint, "90210")
                toggle.click()
                expect(toggle).to_have_attribute("aria-expanded", "false")
                expect(page.locator("#zip")).to_be_in_viewport()
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 390)

    def test_empty_states_and_failed_search_preserve_prior_results(self):
        for mode in self.urls:
            with self.subTest(mode=mode):
                page, _, behavior, endpoint = self.open_workspace(mode)
                behavior["search"] = "empty"
                self.search_zip(page, endpoint)
                expect(page.locator("#results .station-card")).to_have_count(0)
                behavior["search"] = "success"
                self.search_zip(page, endpoint)
                expect(page.locator("#results .station-card")).to_have_count(3)
                page.locator("#filters-toggle").click()
                page.locator("#connector").select_option("CHAdeMO")
                expect(page.locator("#results .station-card")).to_have_count(0)
                page.locator("#reset-filters").click()
                expect(page.locator("#results .station-card")).to_have_count(3)
                behavior["search"] = "failure"
                self.search_zip(page, endpoint, "90210")
                expect(page.locator("#message")).to_contain_text("Test provider temporarily unavailable")
                expect(page.locator("#results .station-card")).to_have_count(3)
                expect(page.locator('[data-station="901001"]')).to_be_visible()
                expect(page.locator("#retry")).to_be_visible()
                behavior["search"] = "success"
                with page.expect_response(lambda response: response.url == endpoint + "search" and response.request.method == "POST"):
                    page.locator("#retry").click()
                expect(page.locator("#retry")).not_to_be_visible()
                expect(page.locator("#results .station-card")).to_have_count(3)

    def test_detail_save_and_comparison_actions_are_independent(self):
        for mode in self.urls:
            with self.subTest(mode=mode):
                page, _, _, endpoint = self.open_workspace(mode)
                self.search_zip(page, endpoint)
                page.locator('[data-station="901001"] .card-link').click()
                expect(page.locator("#detail")).to_contain_text("Test Riverside Charging")
                page.get_by_role("button", name="Save", exact=True).click()
                expect(page.get_by_role("button", name="Save", exact=True)).to_have_attribute("aria-pressed", "true")
                page.get_by_role("button", name="Compare", exact=True).click()
                expect(page.locator("#comparison-tray")).to_be_visible()
                page.locator("#compare-open").click()
                expect(page.locator(".comparison-table")).to_contain_text("Test Riverside Charging")
                page.locator("#modal-close").click()
                page.locator("#detail .back").click()
                page.locator("#favorites-nav").click()
                expect(page.locator("#results .station-card")).to_have_count(1)
                expect(page.locator('[data-station="901001"]')).to_be_visible()
                page.reload(wait_until="domcontentloaded")
                page.locator("#favorites-nav").click()
                expect(page.locator("#results .station-card")).to_have_count(1)
                expect(page.locator('[data-station="901001"]')).to_contain_text("Test Riverside Charging")

    def test_retired_sample_data_is_removed_without_losing_real_saved_stations(self):
        for mode in self.urls:
            with self.subTest(mode=mode):
                page, requests, _, endpoint = self.open_workspace(mode)
                page.evaluate("""station => {
                    localStorage.setItem('current-favorites', JSON.stringify([
                        {id:'demo-retired',name:'Retired sample'}, station
                    ]));
                    localStorage.setItem('current-searches', JSON.stringify([
                        {demo:true,zip_code:'10036',radius:10},
                        {location_mode:'coordinates',latitude:40,longitude:-73,radius:10},
                        {demo:false,zip_code:'90210',radius:25}
                    ]));
                    localStorage.setItem('current-last-results', JSON.stringify({
                        demo:true,stations:[{id:'demo-retired',name:'Retired sample'}]
                    }));
                }""", TEST_STATIONS[0])
                page.reload(wait_until="domcontentloaded")
                page.locator("#favorites-nav").click()
                expect(page.locator("#results .station-card")).to_have_count(1)
                expect(page.locator('[data-station="901001"]')).to_be_visible()
                page.locator("#more-actions").click()
                expect(page.locator(".saved-search")).to_have_count(1)
                with page.expect_response(lambda response: response.url == endpoint + "search" and response.request.method == "POST"):
                    page.get_by_role("button", name=re.compile(r"Run saved search: ZIP 90210")).click()
                expect(page.locator("#zip")).to_have_value("90210")
                payload = [item["data"] for item in requests if item["url"] == endpoint + "search"][-1]
                self.assertEqual(payload["zip_code"], "90210")
                self.assertNotIn("demo", payload)


if __name__ == "__main__":
    unittest.main()

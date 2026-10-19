"""Behavioral Chromium tests against Flask and a project-path Pages export."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

from playwright.sync_api import sync_playwright, expect
from werkzeug.serving import make_server

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from app import app
from scripts.build_pages import build


class WorkspaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        project = Path(cls.temporary.name) / "ev-charging-finder"
        build(project)
        cls.flask = make_server("127.0.0.1", 0, app, threaded=True)
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
        context = self.browser.new_context(viewport={"width": 390 if mobile else 1440, "height": 844 if mobile else 1000}, service_workers="block")
        self.addCleanup(context.close)
        # Exercise the real owned UI with deterministic third-party map/CDN failure.
        context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(self.urls[mode]) else route.abort())
        page = context.new_page()
        attempts = []
        page.on("request", lambda request: attempts.append(request.url) if "/api/" in request.url else None)
        page.goto(self.urls[mode], wait_until="domcontentloaded")
        expect(page.locator("#results .station-card").first).to_be_visible()
        return page, attempts

    def test_demo_search(self):
        for mode in self.urls:
            with self.subTest(mode=mode):
                page, attempts = self.open_workspace(mode)
                boot = json.loads(page.locator("#initial-data").text_content())
                self.assertTrue(boot["demo"])
                page.locator('#search [name="demo"]').check()
                page.locator('#search [name="zip_code"]').fill("10036")
                page.locator("#submit").click()
                expect(page.locator("#submit")).to_be_enabled()
                expect(page.locator("#results .station-card")).to_have_count(len(boot["stations"]))
                if mode == "pages":
                    self.assertEqual(boot["config"]["mode"], "static")
                    self.assertFalse(boot["config"]["live_search"])
                    self.assertEqual(attempts, [], "Pages must never call Flask APIs")

    def test_connector_filter(self):
        for mode in self.urls:
            with self.subTest(mode=mode):
                page, attempts = self.open_workspace(mode)
                stations = json.loads(page.locator("#initial-data").text_content())["stations"]
                expected = [station for station in stations if "NACS" in station["connectors"]]
                self.assertGreater(len(expected), 0)
                self.assertLess(len(expected), len(stations))
                page.locator("#filters-toggle").click()
                page.locator("#connector").select_option("NACS")
                expect(page.locator("#results .station-card")).to_have_count(len(expected))
                for station in expected:
                    expect(page.locator(f'[data-station="{station["id"]}"]')).to_be_visible()
                page.locator("#connector").select_option("")
                expect(page.locator("#results .station-card")).to_have_count(len(stations))
                if mode == "pages":
                    self.assertEqual(attempts, [])

    def test_theme_persists(self):
        for mode in self.urls:
            with self.subTest(mode=mode):
                page, _ = self.open_workspace(mode)
                before = page.locator("html").get_attribute("data-theme")
                after = "light" if before == "dark" else "dark"
                page.locator("#theme").click()
                expect(page.locator("html")).to_have_attribute("data-theme", after)
                page.reload(wait_until="domcontentloaded")
                expect(page.locator("html")).to_have_attribute("data-theme", after)

    def test_mobile_sheet(self):
        for mode in self.urls:
            with self.subTest(mode=mode):
                page, _ = self.open_workspace(mode, mobile=True)
                toggle = page.locator("#sheet-toggle")
                expect(toggle).to_be_visible()
                expect(toggle).to_have_attribute("aria-expanded", "false")
                toggle.click()
                expect(toggle).to_have_attribute("aria-expanded", "true")
                expect(page.locator(".sidebar")).to_have_class(__import__("re").compile(r"\bexpanded\b"))
                toggle.click()
                expect(toggle).to_have_attribute("aria-expanded", "false")
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 390)

    def test_coordinate_search_and_zip_validation_remain_independent(self):
        for mode in self.urls:
            with self.subTest(mode=mode):
                page, _ = self.open_workspace(mode)
                page.locator("#search-settings summary").click()
                page.locator("#location-mode").select_option("coordinates")
                page.locator('[name="latitude"]').fill("0")
                page.locator('[name="longitude"]').fill("0")
                page.locator("#submit").click()
                expect(page.locator("#results .station-card")).to_have_count(0)
                expect(page.locator("#results")).to_contain_text("No matching stations")
                page.locator("#location-mode").select_option("zip")
                page.locator("#zip").fill("10036")
                page.locator("#submit").click()
                expect(page.locator('[data-station="demo-1"]')).to_be_visible()
                expect(page.locator('[name="latitude"]')).to_be_disabled()

    def test_detail_save_and_comparison_actions_are_independent(self):
        for mode in self.urls:
            with self.subTest(mode=mode):
                page, _ = self.open_workspace(mode)
                page.locator('[data-station="demo-1"] .card-link').click()
                expect(page.locator("#detail")).to_contain_text("Demo Central Garage")
                page.get_by_role("button", name="Save", exact=True).click()
                expect(page.get_by_role("button", name="Save", exact=True)).to_have_attribute("aria-pressed", "true")
                page.get_by_role("button", name="Compare", exact=True).click()
                expect(page.locator("#comparison-tray")).to_be_visible()
                page.locator("#compare-open").click()
                expect(page.locator(".comparison-table")).to_contain_text("Demo Central Garage")
                page.locator("#modal-close").click()
                page.locator("#detail .back").click()
                page.locator("#favorites-nav").click()
                expect(page.locator("#results .station-card")).to_have_count(1)
                expect(page.locator('[data-station="demo-1"]')).to_be_visible()


if __name__ == "__main__":
    unittest.main()

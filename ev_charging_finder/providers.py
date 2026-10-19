"""Server-only upstream adapters, bounded caches and conservative transport policy."""
from collections import OrderedDict
import copy
import os
import threading
import time
from typing import Protocol
from urllib.parse import urlparse
import requests


class FinderError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


class TTLCache:
    def __init__(self, capacity=128, ttl=180, clock=time.monotonic):
        self.capacity, self.ttl, self.clock = capacity, ttl, clock
        self._items = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            item = self._items.get(key)
            if item is None:
                return None
            expires, value = item
            if expires <= self.clock():
                del self._items[key]
                return None
            self._items.move_to_end(key)
            return copy.deepcopy(value)

    def put(self, key, value):
        with self._lock:
            self._items[key] = (self.clock() + self.ttl, copy.deepcopy(value))
            self._items.move_to_end(key)
            while len(self._items) > self.capacity:
                self._items.popitem(last=False)

    def clear(self):
        with self._lock:
            self._items.clear()


station_cache = TTLCache(128, 180)
reference_cache = TTLCache(8, 86400)
zip_cache = TTLCache(256, 86400)


def request_json(url, *, params=None, headers=None, timeout=(5, 20), label="Station provider"):
    # Two attempts only; authorization, validation and malformed JSON are not retried.
    for attempt in range(2):
        try:
            response = requests.get(url, params=params, headers=headers, timeout=timeout)
            if response.status_code in (429, 500, 502, 503, 504):
                if attempt == 0:
                    time.sleep(0.15)
                    continue
                raise FinderError(f"{label} is temporarily unavailable. Please try again.", 503)
            if response.status_code == 404:
                raise FinderError(f"{label} record not found.", 404)
            response.raise_for_status()
            return response.json()
        except (requests.Timeout, requests.ConnectionError):
            if attempt == 0:
                time.sleep(0.15)
                continue
            raise FinderError(f"{label} timed out or could not be reached. Please try again.", 504) from None
        except requests.RequestException:
            raise FinderError(f"{label} request failed. Check server provider configuration.") from None
        except ValueError:
            raise FinderError(f"{label} returned invalid JSON.") from None


class StationProvider(Protocol):
    def search(self, latitude: float, longitude: float, radius: float) -> list: ...
    def station(self, station_id: int) -> dict: ...
    def references(self) -> dict: ...


class OpenChargeMapProvider:
    API_URL = "https://api.openchargemap.io/v3/poi/"

    def __init__(self, api_key=None):
        self.key = api_key if api_key is not None else os.environ.get("OCM_API_KEY", "").strip()
        if not self.key:
            raise FinderError("Live search is not configured. Set OCM_API_KEY on the server.", 503)

    def _fetch(self, params):
        params = {"output": "json", "compact": "false", "verbose": "true", "client": "ev-charging-finder", **params}
        key = (self.key, tuple(sorted(params.items())))
        records = station_cache.get(key)
        if records is None:
            records = request_json(self.API_URL, headers={"X-API-Key": self.key}, params=params, label="Open Charge Map")
            if not isinstance(records, list):
                raise FinderError("Open Charge Map returned an unexpected response.")
            station_cache.put(key, records)
        return records

    def search(self, latitude, longitude, radius):
        return self._fetch({"latitude": latitude, "longitude": longitude, "distance": radius, "distanceunit": "miles", "maxresults": 100})

    def station(self, station_id):
        records = self._fetch({"chargepointid": station_id, "maxresults": 1})
        for record in records:
            if isinstance(record, dict) and record.get("ID") == station_id:
                return record
        raise FinderError("Station not found.", 404)

    def references(self):
        key = ("ocm", self.key)
        references = reference_cache.get(key)
        if references is None:
            references = request_json("https://api.openchargemap.io/v3/referencedata/", headers={"X-API-Key": self.key}, params={"output": "json"}, label="Open Charge Map reference data")
            if not isinstance(references, dict):
                raise FinderError("Open Charge Map returned invalid reference data.")
            reference_cache.put(key, references)
        return references


class RoutingProvider(Protocol):
    def route(self, coordinates: list) -> dict: ...


class OSRMProvider:
    def __init__(self, base_url=None):
        self.base_url = (base_url if base_url is not None else os.environ.get("ROUTING_BASE_URL", "")).rstrip("/")
        if not self.base_url:
            raise FinderError("Routing is not configured. Set ROUTING_BASE_URL on the server to enable driving routes.", 503)
        parsed = urlparse(self.base_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise FinderError("The server routing provider URL is invalid.", 503)

    def route(self, coordinates):
        path = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in coordinates)
        data = request_json(f"{self.base_url}/route/v1/driving/{path}", params={"overview": "full", "geometries": "geojson", "steps": "false"}, timeout=(5, 15), label="Routing provider")
        try:
            if data.get("code") != "Ok":
                raise FinderError("No driving route was found for these locations.", 422)
            route = data["routes"][0]
            from .domain import finite_number
            distance = finite_number(route["distance"], "route distance")
            duration = finite_number(route["duration"], "route duration")
            geometry = route["geometry"]
            if geometry.get("type") != "LineString" or not isinstance(geometry.get("coordinates"), list) or len(geometry["coordinates"]) < 2:
                raise ValueError("Invalid geometry")
            for point in geometry["coordinates"]:
                if not isinstance(point, list) or len(point) < 2:
                    raise ValueError("Invalid geometry coordinate")
                from .finder import validate
                validate(float(point[1]), float(point[0]), 1, 1)
            return {"distance_miles": distance / 1609.344, "duration_minutes": duration / 60, "geometry": geometry, "provider": "OSRM", "traffic": False}
        except FinderError:
            raise
        except (AttributeError, KeyError, IndexError, TypeError, ValueError):
            raise FinderError("Routing provider returned invalid route data.") from None

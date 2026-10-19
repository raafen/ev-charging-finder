"""Server-only upstream adapters, bounded caches and conservative transport policy."""
from collections import OrderedDict
import math
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


context_cache = TTLCache(256, 900)


def station_context(latitude, longitude):
    """Fetch public weather and nearby OSM amenities; partial failures stay explicit."""
    from datetime import datetime, timezone
    from .domain import finite_number
    from .finder import distance_km, validate

    latitude, longitude = float(latitude), float(longitude)
    validate(latitude, longitude, 1, 1)
    key = (round(latitude, 3), round(longitude, 3))
    cached = context_cache.get(key)
    if cached is not None:
        return cached
    context = {
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "weather": {"status": "unavailable", "source": "Open-Meteo"},
        "amenities": {"status": "unavailable", "source": "OpenStreetMap contributors", "items": []},
    }
    try:
        data = request_json(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": latitude, "longitude": longitude,
                "current": "temperature_2m,precipitation,wind_speed_10m,weather_code",
                "timezone": "auto",
            },
            timeout=(3, 6), label="Weather provider",
        )
        current = data.get("current", {})
        code = finite_number(current.get("weather_code"), "weather code", minimum=0)
        description = (
            "Clear" if code == 0 else "Mainly clear / partly cloudy" if code in (1, 2, 3)
            else "Fog" if code in (45, 48) else "Rain / drizzle" if code in (51, 53, 55, 56, 57, 61, 63, 65, 66, 67)
            else "Snow" if code in (71, 73, 75, 77, 85, 86)
            else "Rain showers" if code in (80, 81, 82)
            else "Thunderstorm" if code in (95, 96, 99)
            else "Conditions unavailable"
        )
        context["weather"] = {
            "status": "available", "source": "Open-Meteo",
            "observed_at": current.get("time"), "description": description,
            "temperature_c": finite_number(current.get("temperature_2m"), "temperature"),
            "precipitation_mm": finite_number(current.get("precipitation"), "precipitation", minimum=0),
            "wind_kmh": finite_number(current.get("wind_speed_10m"), "wind speed", minimum=0),
            "weather_code": code,
        }
    except (AttributeError, FinderError, TypeError, ValueError):
        pass
    delta_lat = 1500 / 111000
    delta_lon = delta_lat / max(0.1, math.cos(math.radians(latitude)))
    bbox = (
        max(-180, longitude - delta_lon), max(-90, latitude - delta_lat),
        min(180, longitude + delta_lon), min(90, latitude + delta_lat),
    )
    items, succeeded = {}, 0
    categories = {"cafe", "restaurant", "fast_food", "food_court", "toilets"}
    for term in ("cafe", "restaurant", "toilets"):
        try:
            data = request_json(
                "https://photon.komoot.io/api/",
                params={"q": term, "bbox": ",".join(map(str, bbox)), "limit": 20},
                headers={"User-Agent": "CurrentEVFinder/2.0", "Accept": "application/json"},
                timeout=(3, 6), label="Nearby places provider",
            )
            succeeded += 1
            features = data.get("features", [])
            for feature in features if isinstance(features, list) else []:
                if not isinstance(feature, dict):
                    continue
                props = feature.get("properties", {})
                geometry = feature.get("geometry", {})
                if not isinstance(props, dict) or props.get("osm_key") != "amenity" or not isinstance(geometry, dict):
                    continue
                coords = geometry.get("coordinates", [])
                category = props.get("osm_value")
                if category not in categories or not isinstance(coords, list) or len(coords) < 2:
                    continue
                try:
                    lon = finite_number(coords[0], "longitude", minimum=-180, maximum=180)
                    lat = finite_number(coords[1], "latitude", minimum=-90, maximum=90)
                except ValueError:
                    continue
                distance_m = round(distance_km(latitude, longitude, lat, lon) * 1000)
                if distance_m > 1500:
                    continue
                item_key = (props.get("osm_type"), props.get("osm_id"))
                if not all(item_key):
                    continue
                items[item_key] = {
                    "name": props.get("name")[:160] if isinstance(props.get("name"), str) else None,
                    "category": category, "distance_m": distance_m,
                }
        except (AttributeError, FinderError, TypeError, ValueError):
            continue
    if succeeded:
        context["amenities"] = {
            "status": "available", "source": "OpenStreetMap contributors via Photon",
            "radius_m": 1500, "items": sorted(items.values(), key=lambda item: item["distance_m"])[:12],
        }
    context_cache.put(key, context)
    return context

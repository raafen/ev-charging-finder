"""Open Charge Map client and proximity filtering, shared by web and CLI."""
import math
import os
import re
import requests

API_URL = "https://api.openchargemap.io/v3/poi/"

class FinderError(Exception):
    pass

def validate(latitude, longitude, radius, limit):
    if not math.isfinite(latitude) or not -90 <= latitude <= 90:
        raise ValueError("Latitude must be between -90 and 90.")
    if not math.isfinite(longitude) or not -180 <= longitude <= 180:
        raise ValueError("Longitude must be between -180 and 180.")
    if not math.isfinite(radius) or not 0 < radius <= 100:
        raise ValueError("Radius must be greater than 0 and at most 100 miles.")
    if not 1 <= limit <= 100:
        raise ValueError("Result limit must be between 1 and 100.")

def distance_km(lat1, lon1, lat2, lon2):
    a, b = math.radians(lat1), math.radians(lat2)
    h = math.sin((b-a)/2)**2 + math.cos(a)*math.cos(b)*math.sin(math.radians(lon2-lon1)/2)**2
    return 6371.0088 * 2 * math.asin(math.sqrt(min(1, max(0, h))))

def normalize(records, latitude, longitude, radius, limit, operational_only):
    stations = []
    for record in records:
        if not isinstance(record, dict):
            continue
        address = record.get("AddressInfo") or {}
        status = record.get("StatusType") or {}
        if operational_only and status.get("IsOperational") is not True:
            continue
        try:
            lat, lon = float(address["Latitude"]), float(address["Longitude"])
            validate(lat, lon, radius, limit)
        except (KeyError, TypeError, ValueError):
            continue
        distance = distance_km(latitude, longitude, lat, lon) / 1.609344
        if distance > radius:
            continue
        provider = record.get("DataProvider") or {}
        stations.append({
            "id": record.get("ID"), "name": address.get("Title") or "Unnamed station",
            "address": ", ".join(str(address[k]) for k in ("AddressLine1", "Town", "StateOrProvince", "Postcode") if address.get(k)),
            "latitude": lat, "longitude": lon, "distance_miles": distance,
            "status": status.get("Title") or "Unknown", "points": record.get("NumberOfPoints"),
            "provider": provider.get("Title") or "Unknown provider",
            "license": provider.get("License") or "See source record for licensing",
            "source_url": f"https://openchargemap.org/site/poi/details/{record['ID']}" if isinstance(record.get("ID"), int) else "https://openchargemap.org",
        })
    return sorted(stations, key=lambda station: station["distance_miles"])[:limit]

def search(latitude, longitude, radius=10, limit=20, operational_only=False, demo=False):
    validate(latitude, longitude, radius, limit)
    if demo:
        records = [
            {"ID": None, "AddressInfo": {"Title": "Demo Central Garage", "AddressLine1": "100 Example Avenue", "Latitude": 40.754, "Longitude": -73.984}, "StatusType": {"Title": "Operational", "IsOperational": True}, "NumberOfPoints": 4},
            {"ID": None, "AddressInfo": {"Title": "Demo Riverside Charging", "AddressLine1": "200 Sample Street", "Latitude": 40.762, "Longitude": -73.995}, "StatusType": {"Title": "Temporarily unavailable", "IsOperational": False}, "NumberOfPoints": 2},
        ]
    else:
        key = os.environ.get("OCM_API_KEY", "").strip()
        if not key:
            raise FinderError("Set OCM_API_KEY in your environment, or select demo mode.")
        try:
            response = requests.get(API_URL, headers={"X-API-Key": key}, params={
                "output": "json", "latitude": latitude, "longitude": longitude,
                "distance": radius, "distanceunit": "miles", "maxresults": 100,
                "compact": "false", "verbose": "true", "client": "ev-charging-finder",
            }, timeout=(5, 20))
            response.raise_for_status()
            records = response.json()
        except requests.Timeout:
            raise FinderError("Open Charge Map timed out. Please try again.") from None
        except requests.RequestException:
            raise FinderError("Unable to retrieve stations. Check your API key and network connection.") from None
        except ValueError:
            raise FinderError("Open Charge Map returned invalid JSON.") from None
        if not isinstance(records, list):
            raise FinderError("Open Charge Map returned an unexpected response.")
    return normalize(records, latitude, longitude, radius, limit, operational_only)


def lookup_zip(zip_code, demo=False):
    """Resolve a five-digit US ZIP to an approximate center, preserving leading zeros."""
    zip_code = zip_code.strip()
    if not re.fullmatch(r"[0-9]{5}", zip_code):
        raise ValueError("Enter a five-digit US ZIP code, such as 10036.")
    if demo:
        if zip_code != "10036":
            raise ValueError("Offline ZIP demo supports 10036 only. Use coordinates or disable demo.")
        return 40.758, -73.9855, "10036 (demo location near Times Square)"
    try:
        response = requests.get(f"https://api.zippopotam.us/us/{zip_code}", timeout=(5, 10))
        if response.status_code == 404:
            raise FinderError("ZIP code not found. Try another US ZIP or use coordinates.")
        response.raise_for_status()
        place = response.json()["places"][0]
        lat, lon = float(place["latitude"]), float(place["longitude"])
        validate(lat, lon, 10, 20)
        return lat, lon, f"{zip_code} — {place['place name']}, {place['state abbreviation']}"
    except requests.Timeout:
        raise FinderError("ZIP lookup timed out. Try again or use coordinates.") from None
    except requests.RequestException:
        raise FinderError("ZIP lookup unavailable. Try again or use coordinates.") from None
    except (ValueError, KeyError, IndexError, TypeError):
        raise FinderError("ZIP lookup returned invalid location data.") from None

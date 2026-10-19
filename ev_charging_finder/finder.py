"""Station discovery, normalized public data and provider-backed route planning."""
import math
import re
import requests  # Kept as the shared HTTP module for CLI consumers and patchable transports.
from .domain import connector_name, finite_number
from .providers import FinderError, OpenChargeMapProvider, OSRMProvider, request_json, zip_cache

API_URL = OpenChargeMapProvider.API_URL


def validate(latitude, longitude, radius, limit):
    if not math.isfinite(latitude) or not -90 <= latitude <= 90:
        raise ValueError("Latitude must be between -90 and 90.")
    if not math.isfinite(longitude) or not -180 <= longitude <= 180:
        raise ValueError("Longitude must be between -180 and 180.")
    if not math.isfinite(radius) or not 0 < radius <= 100:
        raise ValueError("Radius must be greater than 0 and at most 100 miles.")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("Result limit must be between 1 and 100.")


def distance_km(lat1, lon1, lat2, lon2):
    a, b = math.radians(lat1), math.radians(lat2)
    h = math.sin((b-a)/2)**2 + math.cos(a)*math.cos(b)*math.sin(math.radians(lon2-lon1)/2)**2
    return 6371.0088 * 2 * math.asin(math.sqrt(min(1, max(0, h))))


def _object(value):
    return value if isinstance(value, dict) else {}


def _text(value, default=None):
    return value.strip() if isinstance(value, str) and value.strip() else default


def _number(value, integer=False):
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
        if not math.isfinite(value) or value < 0 or integer and not value.is_integer():
            return None
        return int(value) if integer else value
    except (TypeError, ValueError, OverflowError):
        return None


def _reference(record, field, references, collection):
    nested = _object(record.get(field))
    if nested:
        return nested
    reference_id = record.get(field + "ID")
    entries = references.get(collection, [])
    return next((item for item in entries if isinstance(item, dict) and item.get("ID") == reference_id), {}) if isinstance(entries, list) else {}


def normalize(records, latitude, longitude, radius, limit, operational_only, references=None):
    validate(latitude, longitude, radius, limit)
    references = _object(references)
    stations = []
    if not isinstance(records, list):
        return stations
    for record in records:
        if not isinstance(record, dict):
            continue
        address = _object(record.get("AddressInfo"))
        status = _reference(record, "StatusType", references, "StatusTypes")
        operational = status.get("IsOperational") if isinstance(status.get("IsOperational"), bool) else None
        if operational_only and operational is not True:
            continue
        try:
            lat, lon = float(address["Latitude"]), float(address["Longitude"])
            validate(lat, lon, radius, limit)
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        distance = distance_km(latitude, longitude, lat, lon) / 1.609344
        if distance > radius:
            continue
        connections = []
        entries = record.get("Connections")
        for connection in entries if isinstance(entries, list) else []:
            if not isinstance(connection, dict):
                continue
            kind = _reference(connection, "ConnectionType", references, "ConnectionTypes")
            current = _reference(connection, "CurrentType", references, "CurrentTypes")
            current_id = current.get("ID", connection.get("CurrentTypeID"))
            title = _text(current.get("Title"), "").upper()
            current_type = "DC" if current_id == 30 or "DC" in title else "AC" if current_id in (10, 20) or "AC" in title else "Unknown"
            connection_status = _reference(connection, "StatusType", references, "StatusTypes")
            connections.append({"connector": connector_name(kind.get("Title"), kind.get("ID", connection.get("ConnectionTypeID"))),
                                "title": _text(kind.get("Title")), "current_type": current_type,
                                "power_kw": _number(connection.get("PowerKW")), "quantity": _number(connection.get("Quantity"), True),
                                "voltage": _number(connection.get("Voltage")), "amps": _number(connection.get("Amps")),
                                "status": _text(connection_status.get("Title"), "Unknown"),
                                "operational": connection_status.get("IsOperational") if isinstance(connection_status.get("IsOperational"), bool) else None})
        provider = _reference(record, "DataProvider", references, "DataProviders")
        operator = _reference(record, "OperatorInfo", references, "Operators")
        if not operator:
            operator = next((v for v in references.get("Operators", []) if isinstance(v, dict) and v.get("ID") == record.get("OperatorID")), {}) if isinstance(references.get("Operators", []), list) else {}
        usage = _reference(record, "UsageType", references, "UsageTypes")
        station_id = record.get("ID") if isinstance(record.get("ID"), int) and not isinstance(record.get("ID"), bool) else None
        powers = [c["power_kw"] for c in connections if c["power_kw"] is not None]
        stations.append({"id": station_id, "name": _text(address.get("Title"), "Unnamed station"),
            "address": ", ".join(str(address[k]) for k in ("AddressLine1", "Town", "StateOrProvince", "Postcode") if isinstance(address.get(k), (str, int)) and address[k]),
            "latitude": lat, "longitude": lon, "distance_miles": distance, "operational": operational,
            "connectors": sorted({c["connector"] for c in connections}), "connections": connections, "max_power_kw": max(powers, default=None),
            "pricing": _text(record.get("UsageCost"), "Price not provided"), "verified": _text(record.get("DateLastVerified")),
            "updated": _text(record.get("DateLastStatusUpdate")) or _text(record.get("DateLastConfirmed")),
            "status": _text(status.get("Title"), "Unknown"), "points": _number(record.get("NumberOfPoints"), True),
            "network": _text(operator.get("Title")), "host": _text(record.get("HostName")), "network_access": "unknown",
            "access": _text(usage.get("Title"), "Unknown"), "membership_required": usage.get("IsMembershipRequired") if isinstance(usage.get("IsMembershipRequired"), bool) else None,
            "payments": {"pay_at_location": usage.get("IsPayAtLocation") if isinstance(usage.get("IsPayAtLocation"), bool) else None, "access_key_required": usage.get("IsAccessKeyRequired") if isinstance(usage.get("IsAccessKeyRequired"), bool) else None},
            "hours": _text(record.get("OpeningTimes")), "access_comments": _text(address.get("AccessComments")),
            "provider": _text(provider.get("Title"), "Unknown provider"), "license": _text(provider.get("License"), "See source record for licensing"),
            "source_url": f"https://openchargemap.org/site/poi/details/{station_id}" if station_id is not None else "https://openchargemap.org",
            "availability": "unknown", "availability_note": "Operational status is not real-time stall availability."})
    return sorted(stations, key=lambda station: station["distance_miles"])[:limit]



def _needed_references(records, provider):
    for record in records:
        if not isinstance(record, dict):
            continue
        connections = record.get("Connections", [])
        items = [record] + (connections if isinstance(connections, list) else [])
        for item in items:
            if not isinstance(item, dict):
                continue
            for field in ("StatusType", "UsageType", "DataProvider", "ConnectionType", "CurrentType"):
                if item.get(field + "ID") is not None and not _object(item.get(field)):
                    return provider.references()
        if record.get("OperatorID") is not None and not _object(record.get("OperatorInfo")):
            return provider.references()
    return {}


def search(latitude, longitude, radius=10, limit=100, operational_only=False):
    validate(latitude, longitude, radius, limit)
    provider = OpenChargeMapProvider()
    records = provider.search(latitude, longitude, radius)
    return normalize(records, latitude, longitude, radius, limit, operational_only, _needed_references(records, provider))


def get_station(station_id):
    if not re.fullmatch(r"[1-9][0-9]{0,11}", station_id):
        raise ValueError("Station ID must be a positive Open Charge Map numeric ID.")
    provider = OpenChargeMapProvider()
    record = provider.station(int(station_id))
    address = _object(record.get("AddressInfo"))
    try:
        stations = normalize([record], float(address["Latitude"]), float(address["Longitude"]), 1, 1, False, _needed_references([record], provider))
    except (KeyError, ValueError, TypeError):
        stations = []
    if not stations:
        raise FinderError("Station record has no valid location.")
    return stations[0]


def lookup_zip(zip_code):
    zip_code = zip_code.strip()
    if not re.fullmatch(r"[0-9]{5}", zip_code):
        raise ValueError("Enter a five-digit US ZIP code, such as 10036.")
    cached = zip_cache.get(zip_code)
    if cached is not None:
        return tuple(cached)
    data = request_json(f"https://api.zippopotam.us/us/{zip_code}", timeout=(5, 10), label="ZIP lookup")
    try:
        place = data["places"][0]
        lat, lon = float(place["latitude"]), float(place["longitude"])
        validate(lat, lon, 10, 20)
        result = (lat, lon, f"{zip_code} — {place['place name']}, {place['state abbreviation']}")
        zip_cache.put(zip_code, result)
        return result
    except (ValueError, KeyError, IndexError, TypeError):
        raise FinderError("ZIP lookup returned invalid location data.") from None


def coordinate(value, name):
    if not isinstance(value, (list, tuple)) or len(value) != 2 or any(isinstance(v, bool) for v in value):
        raise ValueError(f"{name} must be [latitude, longitude].")
    try:
        lat, lon = float(value[0]), float(value[1])
        validate(lat, lon, 1, 1)
        return [lat, lon]
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"{name} must contain valid latitude and longitude.") from None


def _corridor_distance(point, geometry):
    # Local tangent-plane distance selects candidates only. Detours use routing.
    lat, lon = point
    scale = math.cos(math.radians(lat))
    best = float("inf")
    for a, b in zip(geometry, geometry[1:]):
        ax, ay = (a[0] - lon) * scale, a[1] - lat
        bx, by = (b[0] - lon) * scale, b[1] - lat
        dx, dy = bx - ax, by - ay
        fraction = min(1, max(0, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) if dx or dy else 0
        best = min(best, math.hypot(ax + fraction * dx, ay + fraction * dy) * 69.0934)
    return best


def route_search(data, provider=None):
    if "demo" in data:
        raise ValueError("Demo requests are no longer supported. Search for real locations.")
    if "origin_zip" in data or "destination_zip" in data:
        if "origin" in data or "destination" in data:
            raise ValueError("Use ZIP codes or internal coordinates, not both.")
        origin = list(lookup_zip(str(data.get("origin_zip", "")))[:2])
        destination = list(lookup_zip(str(data.get("destination_zip", "")))[:2])
    else:
        origin, destination = coordinate(data.get("origin"), "origin"), coordinate(data.get("destination"), "destination")
    corridor = finite_number(data.get("corridor_miles", 3), "corridor_miles", minimum=0.1, maximum=25)
    range_miles = None if data.get("range_miles") is None else finite_number(data["range_miles"], "range_miles", minimum=1, maximum=1000)
    reserve = finite_number(data.get("reserve_miles", 20), "reserve_miles", maximum=1000)
    if range_miles is not None and reserve >= range_miles:
        raise ValueError("reserve_miles must be smaller than range_miles.")
    provider = provider or OSRMProvider()
    route = provider.route([origin, destination])
    route.update(origin=origin, destination=destination, stations=[], corridor_miles=corridor)
    if data.get("include_stations", True) is not True:
        route["stop_plan"] = {"status": "not_requested", "reason": "Enable station search for stop planning."}
        return route
    geometry = route["geometry"]["coordinates"]
    # Bounded external requests. Expose sampling limits instead of claiming coverage.
    sample_count = min(8, len(geometry))
    indices = sorted({round(i * (len(geometry) - 1) / max(1, sample_count - 1)) for i in range(sample_count)})
    candidates = {}
    for index in indices:
        lon, lat = geometry[index][:2]
        for station in search(lat, lon, corridor, 100):
            key = station["id"]
            if key is not None and _corridor_distance((station["latitude"], station["longitude"]), geometry) <= corridor:
                candidates[key] = station
    stations = sorted(candidates.values(), key=lambda s: _corridor_distance((s["latitude"], s["longitude"]), geometry))[:8]
    for station in stations:
        point = [station["latitude"], station["longitude"]]
        try:
            before = provider.route([origin, point])
            after = provider.route([point, destination])
            station["route"] = {"from_origin_miles": before["distance_miles"], "to_destination_miles": after["distance_miles"],
                "detour_miles": max(0, before["distance_miles"] + after["distance_miles"] - route["distance_miles"]),
                "detour_minutes": max(0, before["duration_minutes"] + after["duration_minutes"] - route["duration_minutes"])}
            if isinstance(data.get("vehicle"), dict):
                from .domain import compatibility
                station["compatibility"] = compatibility(data["vehicle"], station)
            route["stations"].append(station)
        except FinderError:
            continue  # Unroutable candidates are excluded, never assigned aerial detours.
    route["stations"].sort(key=lambda s: s["route"]["from_origin_miles"])
    route["coverage"] = {"complete": False, "sample_points": len(indices), "candidate_limit": 8,
        "note": "Bounded corridor sampling may miss stations. Detours are driving routes without traffic; confirm access and availability."}
    route["stop_plan"] = _stop_plan(route, provider, range_miles, reserve, data.get("vehicle"))
    route["alternatives"] = {"fast": [s["id"] for s in sorted(route["stations"], key=lambda s: s["route"]["detour_minutes"])], "cheap": [], "basis": "Fast ranks driving detour only, not charging time. Cheap requires manual per-station total cost assumptions."}
    costs = data.get("manual_station_costs")
    if costs is not None:
        if not isinstance(costs, dict):
            raise ValueError("manual_station_costs must map station IDs to numeric total session cost assumptions in one currency.")
        known = [(s["id"], finite_number(costs[str(s["id"])], "manual station cost")) for s in route["stations"] if str(s["id"]) in costs]
        route["alternatives"]["cheap"] = [{"id": key, "assumed_session_cost": cost} for key, cost in sorted(known, key=lambda item: item[1])]
    return route


def _stop_plan(route, provider, range_miles, reserve, vehicle):
    if range_miles is None:
        return {"status": "not_requested", "reason": "Enter range_miles and reserve_miles to calculate charging stops."}
    usable = range_miles - reserve
    if route["distance_miles"] <= usable:
        return {"status": "reachable", "stops": [], "range_miles": range_miles, "reserve_miles": reserve}
    if not isinstance(vehicle, dict) or not vehicle.get("connectors"):
        return {"status": "needs_vehicle", "stops": [], "reason": "Declare vehicle connectors before planning charging stops."}
    remaining = [s for s in route["stations"] if s["operational"] is True and s.get("compatibility", {}).get("physical") in ("compatible", "adapter_required")]
    stops, current, progress = [], route["origin"], 0
    # A full recharge at each selected stop is an explicit manual range assumption.
    while remaining:
        reachable = []
        for station in remaining:
            if station["route"]["from_origin_miles"] <= progress:
                continue
            leg = provider.route([current, [station["latitude"], station["longitude"]]])
            if leg["distance_miles"] <= usable:
                reachable.append((station, leg))
        if not reachable:
            break
        station, leg = max(reachable, key=lambda pair: pair[0]["route"]["from_origin_miles"])
        stops.append({"id": station["id"], "leg_miles": leg["distance_miles"], "leg_minutes": leg["duration_minutes"], "arrival_remaining_miles": range_miles - leg["distance_miles"]})
        current = [station["latitude"], station["longitude"]]
        progress = station["route"]["from_origin_miles"]
        remaining.remove(station)
        final_leg = provider.route([current, route["destination"]])
        if final_leg["distance_miles"] <= usable:
            return {"status": "conditional", "stops": stops, "final_leg_miles": final_leg["distance_miles"], "range_miles": range_miles, "reserve_miles": reserve,
                    "assumptions": "Full declared driving range at departure and after every stop; no live availability or network authorization guarantee. Greedy plan, not a global optimum."}
    return {"status": "no_plan_found", "stops": stops, "reason": "No feasible plan found among sampled, physically compatible operational stations; this does not prove the journey impossible.", "range_miles": range_miles, "reserve_miles": reserve}

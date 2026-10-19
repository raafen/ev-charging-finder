"""Provider-independent compatibility and transparent manual charging estimates."""
import math
from typing import Protocol

CONNECTORS = ("NACS", "J1772", "CCS1", "CHAdeMO", "Type 2", "CCS2", "Unknown")
CONNECTOR_IDS = {1: "J1772", 2: "CHAdeMO", 25: "Type 2", 27: "NACS", 30: "NACS", 32: "CCS1", 33: "CCS2"}


def connector_name(title=None, reference_id=None):
    if isinstance(reference_id, int) and not isinstance(reference_id, bool) and reference_id in CONNECTOR_IDS:
        return CONNECTOR_IDS[reference_id]
    text = str(title or "").lower().replace("-", " ")
    if "ccs" in text or "combo" in text:
        return "CCS2" if "type 2" in text or "ccs2" in text or "combo 2" in text else "CCS1" if "type 1" in text or "ccs1" in text or "combo 1" in text else "Unknown"
    if "chademo" in text:
        return "CHAdeMO"
    if "nacs" in text or "j3400" in text or "tesla" in text and "type 2" not in text:
        return "NACS"
    if "j1772" in text or "type 1" in text:
        return "J1772"
    if "type 2" in text or "mennekes" in text:
        return "Type 2"
    return "Unknown"


def finite_number(value, name, minimum=0, maximum=None):
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a finite number.")
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError):
        raise ValueError(f"{name} must be a finite number.") from None
    if not math.isfinite(number) or number < minimum or maximum is not None and number > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum if maximum is not None else 'a finite maximum'}.")
    return number


class VehicleProvider(Protocol):
    def vehicle(self, data: dict) -> dict: ...


class ManualVehicleProvider:
    """Only user-entered specifications; never invent vehicle catalog data."""
    def vehicle(self, data):
        if not isinstance(data, dict):
            raise ValueError("vehicle must be an object of manual specifications.")
        result = {"source": "manual", "connectors": [], "adapters": [], "networks": []}
        for name in ("connectors", "networks"):
            values = data.get(name, [])
            if not isinstance(values, list) or any(not isinstance(v, str) for v in values):
                raise ValueError(f"vehicle.{name} must be a list of strings.")
            result[name] = values[:30]
        adapters = data.get("adapters", [])
        if not isinstance(adapters, list) or any(not isinstance(a, dict) for a in adapters):
            raise ValueError("vehicle.adapters must be a list of {from,to,current_type} objects.")
        result["adapters"] = adapters[:30]
        for key in ("battery_kwh", "consumption_kwh_per_100_miles", "max_ac_kw", "max_dc_kw"):
            if data.get(key) is not None:
                result[key] = finite_number(data[key], key, minimum=0 if key in ("max_ac_kw", "max_dc_kw") else 0.001)
        return result


def compatibility(vehicle, station):
    vehicle = ManualVehicleProvider().vehicle(vehicle)
    if not isinstance(station, dict):
        raise ValueError("station must be an object.")
    plugs = [plug for plug in vehicle["connectors"] if plug in CONNECTORS and plug != "Unknown"]
    results = []
    connections = station.get("connections", [])
    if not isinstance(connections, list):
        raise ValueError("station.connections must be a list.")
    for connection in connections:
        if not isinstance(connection, dict):
            continue
        supplied_plug = connection.get("connector")
        plug = supplied_plug if supplied_plug in CONNECTORS else "Unknown"
        supplied_current = connection.get("current_type")
        current = supplied_current if supplied_current in ("AC", "DC") else "Unknown"
        physical, reason = "unknown", "Connector or vehicle inlet not specified."
        if plug != "Unknown" and plugs:
            physical, reason = "incompatible", "No matching inlet or declared adapter."
            if plug in plugs or plug == "J1772" and "CCS1" in plugs or plug == "Type 2" and "CCS2" in plugs:
                physical, reason = "compatible", "Matching physical inlet."
            else:
                for adapter in vehicle["adapters"]:
                    if adapter.get("from") == plug and adapter.get("to") in plugs:
                        if current not in ("AC", "DC") or adapter.get("current_type") not in ("AC", "DC"):
                            physical, reason = "unknown", "Adapter current-type approval not specified."
                        elif adapter["current_type"] == current:
                            physical, reason = "adapter_required", "Declared current-compatible adapter required; confirm manufacturer approval."
                            break
        # A plug match never establishes authorization on a restricted network.
        network = "unknown"
        if station.get("network_access") == "open":
            network = "allowed"
        elif station.get("network_access") == "restricted" and station.get("network"):
            network = "allowed" if station["network"] in vehicle["networks"] else "unknown"
        results.append({"connector": plug, "current_type": current, "physical": physical, "network": network, "reason": reason})
    return {"connections": results, "physical": "compatible" if any(r["physical"] == "compatible" for r in results) else "adapter_required" if any(r["physical"] == "adapter_required" for r in results) else "unknown" if not results or any(r["physical"] == "unknown" for r in results) else "incompatible", "network": "allowed" if results and all(r["network"] == "allowed" for r in results) else "unknown", "warning": "Physical fit does not establish network authorization, adapter safety, or live availability."}


def estimate(data):
    vehicle = ManualVehicleProvider().vehicle(data.get("vehicle", {}))
    if "battery_kwh" not in vehicle:
        raise ValueError("Enter the vehicle's usable battery_kwh.")
    start = finite_number(data.get("start_percent"), "start_percent", maximum=100)
    target = finite_number(data.get("target_percent"), "target_percent", maximum=100)
    if target <= start:
        raise ValueError("target_percent must exceed start_percent.")
    power = finite_number(data.get("station_power_kw"), "station_power_kw", minimum=0.001)
    current = data.get("current_type")
    if current not in ("AC", "DC"):
        raise ValueError("current_type must be AC or DC.")
    vehicle_limit = vehicle.get("max_ac_kw" if current == "AC" else "max_dc_kw")
    if vehicle_limit is None or vehicle_limit <= 0:
        raise ValueError("Enter a positive vehicle charging limit for the selected current type.")
    power = min(power, vehicle_limit)
    efficiency = finite_number(data.get("efficiency_percent", 90), "efficiency_percent", minimum=1, maximum=100) / 100
    battery_energy = finite_number(vehicle["battery_kwh"] * ((target - start) / 100), "Computed battery energy")
    energy = finite_number(battery_energy / efficiency, "Computed grid energy")
    minutes = finite_number(energy / power * 60, "Computed charging duration")
    breakdown = {}
    for field, factor in (("price_per_kwh", energy), ("price_per_minute", minutes), ("session_fee", 1), ("parking_fee", 1)):
        breakdown[field] = None if data.get(field) is None else finite_number(finite_number(data[field], field) * factor, f"Computed {field}")
    pricing_complete = all(v is not None for v in breakdown.values()) and data.get("tax_percent") is not None
    subtotal = finite_number(sum(v for v in breakdown.values() if v is not None), "Computed subtotal")
    tax = None if data.get("tax_percent") is None else finite_number(subtotal * (finite_number(data["tax_percent"], "tax_percent", maximum=100) / 100), "Computed tax")
    total = finite_number(subtotal + tax, "Computed total") if pricing_complete else None
    added_miles = finite_number(battery_energy / vehicle["consumption_kwh_per_100_miles"] * 100, "Computed added miles") if vehicle.get("consumption_kwh_per_100_miles") else None
    return {"battery_energy_kwh": battery_energy, "grid_energy_kwh": energy, "effective_power_kw": power, "minutes": minutes,
            "added_miles": added_miles,
            "fees": breakdown, "known_subtotal": subtotal, "tax": tax, "total": total,
            "pricing_complete": pricing_complete, "currency": str(data.get("currency", "USD"))[:8],
            "assumptions": ["Manual specifications and prices, not a station quote.", "Constant power; excludes tapering, temperature, queueing and idle penalties.", f"Charging efficiency: {efficiency * 100:g}%.", "Unspecified fees remain unknown, not zero."]}

import unittest
from ev_charging_finder.domain import compatibility, connector_name, estimate, ManualVehicleProvider


class DomainTests(unittest.TestCase):
    def station(self, connector, current="DC", **extra):
        return {"connections": [{"connector": connector, "current_type": current}], **extra}

    def test_connector_reference_and_title_normalization(self):
        self.assertEqual(connector_name(None, 32), "CCS1")
        self.assertEqual(connector_name("CCS (Type 2)"), "CCS2")
        self.assertEqual(connector_name("SAE J3400"), "NACS")
        self.assertEqual(connector_name("Unknown hardware", []), "Unknown")
        self.assertEqual(connector_name(None, True), "Unknown")

    def test_physical_is_not_network_authorization(self):
        result = compatibility({"connectors": ["NACS"]}, self.station("NACS", network="Restricted operator", network_access="restricted"))
        self.assertEqual(result["physical"], "compatible")
        self.assertEqual(result["network"], "unknown")
        authorized = compatibility({"connectors": ["NACS"], "networks": ["Restricted operator"]}, self.station("NACS", network="Restricted operator", network_access="restricted"))
        self.assertEqual(authorized["network"], "allowed")

    def test_adapter_direction_and_current_are_required(self):
        vehicle = {"connectors": ["NACS"], "adapters": [{"from": "CCS1", "to": "NACS", "current_type": "DC"}]}
        self.assertEqual(compatibility(vehicle, self.station("CCS1"))["physical"], "adapter_required")
        self.assertEqual(compatibility(vehicle, self.station("CCS1", "AC"))["physical"], "incompatible")
        vehicle["adapters"][0].pop("current_type")
        self.assertEqual(compatibility(vehicle, self.station("CCS1"))["physical"], "unknown")
        vehicle["adapters"] = [{"from": "NACS", "to": "CCS1", "current_type": "DC"}]
        self.assertEqual(compatibility(vehicle, self.station("CCS1"))["physical"], "incompatible")

    def test_ac_inlets_and_unknown(self):
        self.assertEqual(compatibility({"connectors": ["CCS1"]}, self.station("J1772", "AC"))["physical"], "compatible")
        self.assertEqual(compatibility({"connectors": ["J1772"]}, self.station("CCS1"))["physical"], "incompatible")
        self.assertEqual(compatibility({}, self.station("Unknown"))["physical"], "unknown")

    def inputs(self):
        return {"vehicle": {"battery_kwh": 80, "consumption_kwh_per_100_miles": 25, "max_dc_kw": 100},
                "start_percent": 20, "target_percent": 80, "station_power_kw": 150,
                "current_type": "DC", "efficiency_percent": 80,
                "price_per_kwh": .4, "price_per_minute": .1, "session_fee": 2,
                "parking_fee": 3, "tax_percent": 10}

    def test_constant_power_fees_and_miles(self):
        result = estimate(self.inputs())
        self.assertEqual(result["battery_energy_kwh"], 48)
        self.assertEqual(result["grid_energy_kwh"], 60)
        self.assertEqual(result["effective_power_kw"], 100)
        self.assertEqual(result["minutes"], 36)
        self.assertEqual(result["added_miles"], 192)
        self.assertAlmostEqual(result["known_subtotal"], 32.6)
        self.assertAlmostEqual(result["total"], 35.86)

    def test_unspecified_fees_not_treated_as_free(self):
        data = self.inputs()
        del data["parking_fee"]
        result = estimate(data)
        self.assertIsNone(result["total"])
        self.assertIsNone(result["fees"]["parking_fee"])
        self.assertFalse(result["pricing_complete"])

    def test_invalid_estimates_and_manual_profiles(self):
        for field, value in (("station_power_kw", 0), ("efficiency_percent", 101), ("target_percent", 10), ("price_per_kwh", float("nan")), ("start_percent", True)):
            with self.subTest(field=field), self.assertRaises(ValueError):
                estimate({**self.inputs(), field: value})
        with self.assertRaises(ValueError):
            ManualVehicleProvider().vehicle({"connectors": "CCS1"})
        with self.assertRaises(ValueError):
            ManualVehicleProvider().vehicle({"adapters": ["unapproved adapter"]})


if __name__ == "__main__":
    unittest.main()

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from download_light_rail_stations import merge_planned_stations  # noqa: E402


DATA_PATH = (
    Path(__file__).resolve().parents[1]
    / "data"
    / "light_rail_stations.geojson"
)


class LightRailStationDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.collection = json.loads(DATA_PATH.read_text(encoding="utf-8"))

    def test_has_unique_point_features(self):
        features = self.collection["features"]
        station_ids = [
            feature["properties"]["stationId"]
            for feature in features
        ]

        self.assertGreaterEqual(len(features), 40)
        self.assertEqual(len(station_ids), len(set(station_ids)))
        self.assertTrue(all(
            feature["geometry"]["type"] == "Point"
            for feature in features
        ))

    def test_contains_current_link_lines_and_seattle_stations(self):
        lines = {
            line
            for feature in self.collection["features"]
            for line in feature["properties"]["lines"]
        }
        names = {
            feature["properties"]["name"]
            for feature in self.collection["features"]
        }

        self.assertTrue({"1 Line", "2 Line", "T Line"}.issubset(lines))
        self.assertTrue({"Westlake", "Roosevelt", "U District", "Pinehurst"}.issubset(names))

    def test_keeps_planned_west_seattle_stations(self):
        planned = {
            feature["properties"]["name"]
            for feature in self.collection["features"]
            if feature["properties"].get("status") == "planned"
        }

        self.assertTrue({"Alaska Junction", "Delridge"}.issubset(planned))


def station(station_id, name, status=None):
    properties = {"stationId": station_id, "name": name, "lines": ["1 Line"]}
    if status:
        properties["status"] = status
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [-122.3, 47.6]},
        "properties": properties,
    }


class MergePlannedStationsTests(unittest.TestCase):
    def test_carries_planned_stations_forward(self):
        collection = {"features": [station("C03", "Westlake")]}
        existing = {"features": [
            station("C03", "Westlake"),
            station("DELRIDGE_PLANNED", "Delridge", "planned"),
        ]}

        merged = merge_planned_stations(collection, existing)

        self.assertEqual(
            [feature["properties"]["name"] for feature in merged["features"]],
            ["Delridge", "Westlake"],
        )

    def test_drops_planned_station_once_it_opens(self):
        collection = {"features": [station("W05", "Delridge")]}
        existing = {"features": [station("DELRIDGE_PLANNED", "Delridge", "planned")]}

        merged = merge_planned_stations(collection, existing)

        self.assertEqual(
            [feature["properties"]["stationId"] for feature in merged["features"]],
            ["W05"],
        )

    def test_does_not_carry_forward_stations_that_closed(self):
        collection = {"features": [station("C03", "Westlake")]}
        existing = {"features": [station("X99", "Old Stop")]}

        merged = merge_planned_stations(collection, existing)

        self.assertEqual(len(merged["features"]), 1)


if __name__ == "__main__":
    unittest.main()

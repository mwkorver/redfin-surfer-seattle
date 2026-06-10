import json
import unittest
from pathlib import Path


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
        self.assertTrue({"Westlake", "Roosevelt", "U District"}.issubset(names))


if __name__ == "__main__":
    unittest.main()

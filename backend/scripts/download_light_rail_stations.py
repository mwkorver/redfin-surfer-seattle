#!/usr/bin/env python3

import argparse
import csv
import io
import json
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_GTFS_URL = "https://www.soundtransit.org/GTFS-rail/40_gtfs.zip"
BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = BACKEND_DIR / "data" / "light_rail_stations.geojson"
BUNDLED_OUTPUTS = [
    BACKEND_DIR / "property_api" / "data" / "light_rail_stations.geojson",
    BACKEND_DIR.parent / "extension" / "data" / "light_rail_stations.geojson",
]


def read_csv(archive, name):
    with archive.open(name) as source:
        return list(csv.DictReader(io.TextIOWrapper(source, encoding="utf-8-sig")))


def build_station_collection(gtfs_bytes, source_url):
    with zipfile.ZipFile(io.BytesIO(gtfs_bytes)) as archive:
        feed_info = read_csv(archive, "feed_info.txt")
        routes = read_csv(archive, "routes.txt")
        trips = read_csv(archive, "trips.txt")
        stop_times = read_csv(archive, "stop_times.txt")
        stops = read_csv(archive, "stops.txt")

    light_rail_routes = {
        route["route_id"]: route
        for route in routes
        if route.get("route_type") == "0"
    }
    trip_routes = {
        trip["trip_id"]: trip["route_id"]
        for trip in trips
        if trip.get("route_id") in light_rail_routes
    }
    served_stop_routes = defaultdict(set)
    for stop_time in stop_times:
        route_id = trip_routes.get(stop_time.get("trip_id"))
        if route_id:
            served_stop_routes[stop_time["stop_id"]].add(route_id)

    stops_by_id = {stop["stop_id"]: stop for stop in stops}
    station_routes = defaultdict(set)
    for stop_id, route_ids in served_stop_routes.items():
        stop = stops_by_id.get(stop_id)
        if not stop:
            continue
        station_id = stop.get("parent_station") or stop_id
        station_routes[station_id].update(route_ids)

    features = []
    for station_id, route_ids in station_routes.items():
        station = stops_by_id.get(station_id)
        if not station:
            continue
        latitude = station.get("stop_lat")
        longitude = station.get("stop_lon")
        if not latitude or not longitude:
            continue

        line_names = sorted({
            light_rail_routes[route_id]["route_short_name"]
            for route_id in route_ids
        })
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [float(longitude), float(latitude)],
            },
            "properties": {
                "stationId": station_id,
                "name": station.get("stop_name", ""),
                "lines": line_names,
                "wheelchairBoarding": station.get("wheelchair_boarding") == "1",
                "url": station.get("stop_url", ""),
            },
        })

    features.sort(key=lambda feature: (
        feature["properties"]["name"],
        feature["properties"]["stationId"],
    ))
    metadata = feed_info[0] if feed_info else {}
    return {
        "type": "FeatureCollection",
        "name": "sound-transit-link-light-rail-stations",
        "metadata": {
            "source": source_url,
            "publisher": metadata.get("feed_publisher_name", "Sound Transit"),
            "feedVersion": metadata.get("feed_version", ""),
            "feedStartDate": metadata.get("feed_start_date", ""),
            "feedEndDate": metadata.get("feed_end_date", ""),
            "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "routeType": 0,
        },
        "features": features,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Download Sound Transit GTFS and create a Link station GeoJSON layer."
    )
    parser.add_argument("--url", default=DEFAULT_GTFS_URL)
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        type=Path,
    )
    args = parser.parse_args()

    with urllib.request.urlopen(args.url, timeout=60) as response:
        gtfs_bytes = response.read()

    collection = build_station_collection(gtfs_bytes, args.url)
    serialized = json.dumps(collection, indent=2, sort_keys=True) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(serialized, encoding="utf-8")
    print(f"Wrote {len(collection['features'])} stations to {args.output}")

    if args.output.resolve() == DEFAULT_OUTPUT.resolve():
        for bundled_output in BUNDLED_OUTPUTS:
            bundled_output.parent.mkdir(parents=True, exist_ok=True)
            bundled_output.write_text(serialized, encoding="utf-8")
            print(f"Updated bundled copy at {bundled_output}")


if __name__ == "__main__":
    main()

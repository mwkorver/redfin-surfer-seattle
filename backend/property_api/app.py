import base64
import binascii
import hmac
import json
import math
import os
import re
from datetime import datetime, timezone

import boto3
import duckdb
from botocore.exceptions import ClientError

BUCKET = os.environ.get("PROPERTY_BUCKET", "")
SYNC_TOKEN = os.environ.get("SYNC_TOKEN", "")
LOCAL_PARQUET = "/tmp/portfolio.parquet"
PARQUET_KEY = "properties/portfolio.parquet"
LIGHT_RAIL_STATIONS_KEY = os.environ.get(
    "LIGHT_RAIL_STATIONS_KEY",
    "reference/light_rail_stations.geojson",
)
LOCAL_LIGHT_RAIL_STATIONS = "/tmp/light_rail_stations.geojson"
BUNDLED_LIGHT_RAIL_STATIONS = os.path.join(
    os.path.dirname(__file__),
    "data",
    "light_rail_stations.geojson",
)
MAX_BODY_BYTES = 256 * 1024
LISTING_KEY_PATTERN = re.compile(
    r"^redfin/[A-Za-z0-9._~%+-]+(?:/[A-Za-z0-9._~%+-]+)*/home/(\d+)$"
)

s3 = boto3.client("s3")
light_rail_stations_etag = None


def lambda_handler(event, _context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = event.get("rawPath", "")

    if method == "OPTIONS":
        return response(204)

    if not is_authorized(event):
        return error_response(401, "unauthorized", "A valid bearer token is required.")

    try:
        # Normalize routing to support root path and named routes
        if method == "GET" and (path == "/properties" or path == "/properties/"):
            return list_properties()

        if method == "GET" and path in {"/stations", "/stations/"}:
            return list_light_rail_stations()

        if method == "GET" and path in {"/nearest-stations", "/nearest-stations/"}:
            return nearest_light_rail_stations(event)

        if path not in {"/", "/property", "/property/"}:
            return error_response(404, "route_not_found", "Route does not exist.")

        if method == "GET":
            listing_key = get_listing_key(event)
            validation_error = validate_listing_key(listing_key)
            if validation_error:
                return error_response(400, "invalid_listing_key", validation_error)
            return get_property(listing_key)

        if method in {"POST", "PUT"}:
            return put_property(event)

        if method == "DELETE":
            listing_key = get_listing_key(event)
            validation_error = validate_listing_key(listing_key)
            if validation_error:
                return error_response(400, "invalid_listing_key", validation_error)
            return tombstone_property(event, listing_key)

        return error_response(405, "method_not_allowed", f"Unsupported method: {method}")

    except ClientError as exc:
        return handle_s3_error(exc)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        return error_response(400, "invalid_request", str(exc))
    except Exception as exc:
        print(f"[ERROR] Unexpected Lambda failure: {str(exc)}")
        return error_response(500, "internal_error", "The property API failed unexpectedly.")


def is_authorized(event):
    if not SYNC_TOKEN:
        return False
    headers = normalize_headers(event.get("headers") or {})
    authorization = headers.get("authorization", "")
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        return False
    return hmac.compare_digest(authorization[len(prefix):], SYNC_TOKEN)


def load_light_rail_stations():
    global light_rail_stations_etag

    try:
        head = s3.head_object(Bucket=BUCKET, Key=LIGHT_RAIL_STATIONS_KEY)
        etag = head["ETag"]
        if etag != light_rail_stations_etag or not os.path.exists(LOCAL_LIGHT_RAIL_STATIONS):
            result = s3.get_object(Bucket=BUCKET, Key=LIGHT_RAIL_STATIONS_KEY)
            with open(LOCAL_LIGHT_RAIL_STATIONS, "wb") as station_file:
                station_file.write(result["Body"].read())
            light_rail_stations_etag = result.get("ETag", etag)

        with open(LOCAL_LIGHT_RAIL_STATIONS, encoding="utf-8") as station_file:
            collection = json.load(station_file)
        return collection, {
            "storage": "s3",
            "bucket": BUCKET,
            "key": LIGHT_RAIL_STATIONS_KEY,
            "etag": light_rail_stations_etag,
        }
    except (ClientError, OSError, json.JSONDecodeError) as exc:
        print(f"[WARNING] Unable to load station data from S3: {str(exc)}")

    with open(BUNDLED_LIGHT_RAIL_STATIONS, encoding="utf-8") as station_file:
        collection = json.load(station_file)
    return collection, {
        "storage": "bundled",
        "key": "data/light_rail_stations.geojson",
    }


def list_light_rail_stations():
    collection, storage = load_light_rail_stations()
    result = dict(collection)
    result["storage"] = storage
    headers = {"ETag": storage["etag"]} if storage.get("etag") else None
    return response(200, result, headers)


def nearest_light_rail_stations(event):
    query = event.get("queryStringParameters") or {}
    latitude = parse_coordinate(query.get("latitude"), "latitude", -90, 90)
    longitude = parse_coordinate(query.get("longitude"), "longitude", -180, 180)
    try:
        limit = min(10, max(1, int(query.get("limit", 2))))
    except (TypeError, ValueError) as exc:
        raise ValueError("Query parameter 'limit' must be an integer.") from exc

    collection, storage = load_light_rail_stations()
    stations = []
    for feature in collection.get("features") or []:
        coordinates = (feature.get("geometry") or {}).get("coordinates") or []
        if len(coordinates) < 2:
            continue
        try:
            distance_meters = haversine_distance_meters(
                latitude,
                longitude,
                float(coordinates[1]),
                float(coordinates[0]),
            )
        except (TypeError, ValueError):
            continue
        properties = feature.get("properties") or {}
        stations.append({
            "stationId": properties.get("stationId", ""),
            "name": properties.get("name", "Unknown station"),
            "lines": properties.get("lines") or [],
            "url": properties.get("url", ""),
            "distanceMeters": round(distance_meters),
            "distanceMiles": round(distance_meters / 1609.344, 2),
        })

    stations.sort(key=lambda station: station["distanceMeters"])
    return response(200, {
        "stations": stations[:limit],
        "dataset": collection.get("metadata") or {},
        "storage": storage,
    })


def parse_coordinate(value, name, minimum, maximum):
    try:
        coordinate = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Query parameter '{name}' must be a number.") from exc
    if not math.isfinite(coordinate) or not minimum <= coordinate <= maximum:
        raise ValueError(
            f"Query parameter '{name}' must be between {minimum} and {maximum}."
        )
    return coordinate


def haversine_distance_meters(latitude_a, longitude_a, latitude_b, longitude_b):
    earth_radius_meters = 6371008.8
    latitude_delta = math.radians(latitude_b - latitude_a)
    longitude_delta = math.radians(longitude_b - longitude_a)
    start_latitude = math.radians(latitude_a)
    end_latitude = math.radians(latitude_b)
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(start_latitude)
        * math.cos(end_latitude)
        * math.sin(longitude_delta / 2) ** 2
    )
    return earth_radius_meters * 2 * math.atan2(
        math.sqrt(haversine),
        math.sqrt(1 - haversine),
    )


def download_portfolio():
    if os.path.exists(LOCAL_PARQUET):
        try:
            os.remove(LOCAL_PARQUET)
        except OSError:
            pass

    try:
        res = s3.get_object(Bucket=BUCKET, Key=PARQUET_KEY)
        with open(LOCAL_PARQUET, "wb") as f:
            f.write(res["Body"].read())
        return res["ETag"]
    except ClientError as exc:
        if error_code(exc) in {"NoSuchKey", "404", "NotFound"}:
            return None
        raise


def upload_portfolio(conn, request_etag=None):
    if os.path.exists(LOCAL_PARQUET):
        try:
            os.remove(LOCAL_PARQUET)
        except OSError:
            pass

    conn.execute(f"COPY portfolio TO '{LOCAL_PARQUET}' (FORMAT 'parquet')")

    with open(LOCAL_PARQUET, "rb") as f:
        body_bytes = f.read()

    request = {
        "Bucket": BUCKET,
        "Key": PARQUET_KEY,
        "Body": body_bytes,
        "ContentType": "application/octet-stream",
    }
    if request_etag:
        request["IfMatch"] = request_etag
    else:
        request["IfNoneMatch"] = "*"

    res = s3.put_object(**request)
    return res["ETag"]


def initialize_db():
    conn = duckdb.connect()

    extension_paths = [
        "/var/task/spatial.duckdb_extension",
        "./spatial.duckdb_extension",
        os.path.join(os.path.dirname(__file__), "spatial.duckdb_extension")
    ]
    loaded = False
    load_errors = []
    for path in extension_paths:
        if os.path.exists(path):
            try:
                conn.execute(f"LOAD '{path}'")
                loaded = True
                print(f"[INFO] Loaded spatial extension from {path}")
                break
            except Exception as e:
                load_errors.append((path, str(e)))

    if not loaded:
        if os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
            error_msg = f"Failed to load spatial extension in Lambda. Errors: {load_errors}"
            print(f"[ERROR] {error_msg}")
            raise RuntimeError(error_msg)
        else:
            try:
                conn.execute("INSTALL spatial; LOAD spatial;")
            except Exception as e:
                print(f"[WARNING] Failed to auto-install spatial extension: {e}")

    conn.execute("""
        CREATE TABLE portfolio (
            listingKey VARCHAR PRIMARY KEY,
            redfinHomeId VARCHAR,
            price DOUBLE,
            address VARCHAR,
            geo VARCHAR,
            parcel VARCHAR,
            report VARCHAR,
            savedAt VARCHAR,
            serverUpdatedAt VARCHAR,
            updatedBy VARCHAR,
            deletedAt VARCHAR,
            geometry GEOMETRY
        )
    """)

    if os.path.exists(LOCAL_PARQUET) and os.path.getsize(LOCAL_PARQUET) > 0:
        try:
            conn.execute(f"INSERT INTO portfolio SELECT * FROM '{LOCAL_PARQUET}'")
        except Exception as e:
            print(f"[ERROR] Failed to load records from {LOCAL_PARQUET}: {e}")

    return conn


def row_to_geojson(row):
    geometry = None
    if row.get("geojson_geom"):
        try:
            geometry = json.loads(row["geojson_geom"])
        except Exception:
            pass

    properties = {}
    for col in ["listingKey", "redfinHomeId", "price", "savedAt", "serverUpdatedAt", "updatedBy", "deletedAt"]:
        properties[col] = row.get(col)

    for col in ["address", "geo", "parcel", "report"]:
        val = row.get(col)
        if val:
            try:
                properties[col] = json.loads(val)
            except Exception:
                properties[col] = val
        else:
            properties[col] = None

    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": properties
    }


def list_properties():
    etag = download_portfolio()
    if not etag:
        return response(200, {
            "type": "FeatureCollection",
            "features": []
        })

    conn = initialize_db()
    result = conn.execute("""
        SELECT *, ST_AsGeoJSON(geometry) as geojson_geom 
        FROM portfolio 
        WHERE deletedAt IS NULL
    """).fetchall()

    features = []
    columns = [desc[0] for desc in conn.description]
    for row in result:
        row_dict = dict(zip(columns, row))
        features.append(row_to_geojson(row_dict))

    conn.close()
    return response(200, {
        "type": "FeatureCollection",
        "features": features
    }, {"ETag": etag})


def get_property(listing_key):
    etag = download_portfolio()
    if not etag:
        return error_response(404, "not_found", "Property does not exist.")

    conn = initialize_db()
    result = conn.execute("""
        SELECT *, ST_AsGeoJSON(geometry) as geojson_geom 
        FROM portfolio 
        WHERE listingKey = ? AND deletedAt IS NULL
    """, (listing_key,)).fetchall()

    if not result:
        conn.close()
        return error_response(404, "not_found", "Property does not exist.")

    columns = [desc[0] for desc in conn.description]
    row_dict = dict(zip(columns, result[0]))
    conn.close()

    return response(200, row_to_geojson(row_dict), {"ETag": etag})


def put_property(event):
    body_bytes = decode_body(event)
    if len(body_bytes) > MAX_BODY_BYTES:
        return error_response(413, "payload_too_large", "Property JSON exceeds 256 KiB.")

    payload = json.loads(body_bytes)
    listing_key = get_listing_key(event, payload)
    validation_error = validate_listing_key(listing_key)
    if validation_error:
        return error_response(400, "invalid_listing_key", validation_error)

    geojson_feature = to_geojson_feature(payload)
    properties = geojson_feature["properties"]
    
    geometry = geojson_feature.get("geometry") or {}
    coordinates = geometry.get("coordinates") or [None, None]
    longitude = coordinates[0]
    latitude = coordinates[1]

    etag = download_portfolio()

    request_etag = normalize_headers(event.get("headers") or {}).get("if-match")
    if etag and not request_etag:
        return error_response(
            428,
            "precondition_required",
            "Use If-Match with the current ETag when writing the existing portfolio.",
            {"serverEtag": etag},
        )
    if request_etag and not etag:
        return error_response(409, "conflict", "The property no longer exists.")

    conn = initialize_db()

    redfin_home_id = LISTING_KEY_PATTERN.fullmatch(listing_key).group(1)
    saved_at = properties.get("savedAt") or utc_now()
    server_updated_at = utc_now()
    updated_by = properties.get("updatedBy") or "chrome-extension"
    deleted_at = None

    address_str = json.dumps(properties.get("address"))
    geo_str = json.dumps(properties.get("geo") or geojson_feature.get("geometry"))
    parcel_str = json.dumps(properties.get("parcel")) if properties.get("parcel") else None
    report_str = json.dumps(properties.get("report")) if properties.get("report") else None

    if longitude is not None and latitude is not None:
        conn.execute("""
            INSERT OR REPLACE INTO portfolio VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ST_Point(?, ?)
            )
        """, (
            listing_key,
            redfin_home_id,
            float(properties.get("price") or 0),
            address_str,
            geo_str,
            parcel_str,
            report_str,
            saved_at,
            server_updated_at,
            updated_by,
            deleted_at,
            float(longitude),
            float(latitude)
        ))
    else:
        conn.execute("""
            INSERT OR REPLACE INTO portfolio VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
            )
        """, (
            listing_key,
            redfin_home_id,
            float(properties.get("price") or 0),
            address_str,
            geo_str,
            parcel_str,
            report_str,
            saved_at,
            server_updated_at,
            updated_by,
            deleted_at
        ))

    try:
        new_etag = upload_portfolio(conn, request_etag)
    except ClientError as exc:
        conn.close()
        return handle_s3_error(exc)

    conn.close()

    report_response = {
        "aggregateScore": 100,
        "summary": "Property saved to S3 successfully as GeoJSON Feature.",
        "topics": [
            {
                "key": "archival",
                "label": "S3 Archival",
                "score": 100,
                "status": "GeoJSON written to S3."
            }
        ],
        "completedAt": server_updated_at,
        "geojson": geojson_feature
    }

    return response(200 if etag else 201, report_response, {"ETag": new_etag})


def tombstone_property(event, listing_key):
    etag = download_portfolio()
    if not etag:
        return error_response(404, "not_found", "Property does not exist.")

    request_etag = normalize_headers(event.get("headers") or {}).get("if-match")
    if not request_etag:
        return error_response(
            428,
            "precondition_required",
            "Use If-Match with the current ETag when deleting a property.",
            {"serverEtag": etag},
        )

    conn = initialize_db()
    existing = conn.execute("""
        SELECT *, ST_AsGeoJSON(geometry) as geojson_geom 
        FROM portfolio 
        WHERE listingKey = ? AND deletedAt IS NULL
    """, (listing_key,)).fetchall()

    if not existing:
        conn.close()
        return error_response(404, "not_found", "Property does not exist.")

    columns = [desc[0] for desc in conn.description]
    row_dict = dict(zip(columns, existing[0]))

    timestamp = utc_now()
    conn.execute("""
        UPDATE portfolio 
        SET deletedAt = ?, serverUpdatedAt = ? 
        WHERE listingKey = ?
    """, (timestamp, timestamp, listing_key))

    try:
        new_etag = upload_portfolio(conn, request_etag)
    except ClientError as exc:
        conn.close()
        return handle_s3_error(exc)

    conn.close()

    row_dict["deletedAt"] = timestamp
    row_dict["serverUpdatedAt"] = timestamp

    return response(200, row_to_geojson(row_dict), {"ETag": new_etag})


def to_geojson_feature(payload):
    if isinstance(payload, dict) and payload.get("type") == "Feature":
        feature = dict(payload)
        feature.setdefault("properties", {})
        return feature

    geo = payload.get("geo") or {}
    latitude = geo.get("latitude")
    longitude = geo.get("longitude")
    
    geometry = None
    if latitude is not None and longitude is not None:
        try:
            geometry = {
                "type": "Point",
                "coordinates": [float(longitude), float(latitude)]
            }
        except (ValueError, TypeError):
            pass

    properties = {}
    for k, v in payload.items():
        if k not in {"geo"}:
            properties[k] = v

    properties.setdefault("savedAt", utc_now())
    properties.setdefault("schemaVersion", 1)

    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": properties
    }


def get_listing_key(event, payload_body=None):
    query = event.get("queryStringParameters") or {}
    key = query.get("key", "")
    if not key and isinstance(payload_body, dict):
        key = payload_body.get("listingKey", "")
    return key


def validate_listing_key(listing_key):
    if not listing_key:
        return "Query parameter 'key' or body field 'listingKey' is required."
    if len(listing_key) > 512:
        return "listingKey is too long."
    if ".." in listing_key or "\\" in listing_key:
        return "listingKey contains invalid path components."
    if not LISTING_KEY_PATTERN.fullmatch(listing_key):
        return "listingKey must be a Redfin path ending in /home/{numeric-id}."
    return None


def decode_body(event):
    body = event.get("body")
    if body is None:
        raise ValueError("Request body is required.")
    if event.get("isBase64Encoded"):
        try:
            return base64.b64decode(body, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Request body is not valid base64.") from exc
    return body.encode("utf-8")


def normalize_headers(headers):
    return {str(key).lower(): value for key, value in headers.items()}


def handle_s3_error(exc):
    code = error_code(exc)
    if code in {"PreconditionFailed", "412", "ConditionalRequestConflict", "409"}:
        return error_response(
            409,
            "conflict",
            "The property changed in S3. Fetch the latest record before retrying.",
        )
    return error_response(502, "storage_error", f"S3 request failed: {code}")


def error_code(exc):
    return str(exc.response.get("Error", {}).get("Code", "Unknown"))


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def response(status_code, body=None, headers=None):
    response_headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": (
            "authorization,content-type,if-match,if-none-match"
        ),
        "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,OPTIONS",
        "Access-Control-Expose-Headers": "etag",
        "Cache-Control": "no-store",
    }
    response_headers.update(headers or {})
    result = {
        "statusCode": status_code,
        "headers": response_headers,
        "isBase64Encoded": False,
    }
    if body is not None:
        result["headers"]["Content-Type"] = "application/json"
        result["body"] = json.dumps(body, separators=(",", ":"))
    else:
        result["body"] = ""
    return result


def error_response(status_code, code, message, extra=None):
    body = {"error": code, "message": message}
    body.update(extra or {})
    return response(status_code, body)

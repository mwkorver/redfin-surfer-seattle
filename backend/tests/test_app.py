import io
import json
import os
import sys
import unittest
from unittest.mock import MagicMock

os.environ["PROPERTY_BUCKET"] = "test-properties"
os.environ["SYNC_TOKEN"] = "test-token-with-at-least-24-chars"
sys.modules["boto3"] = MagicMock()
sys.modules["botocore"] = MagicMock()
exceptions_module = MagicMock()


class FakeClientError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}


exceptions_module.ClientError = FakeClientError
sys.modules["botocore.exceptions"] = exceptions_module

from property_api import app  # noqa: E402


LISTING_KEY = "redfin/WA/Seattle/2544-NE-90th-St-98115/home/318529"
SECOND_LISTING_KEY = "redfin/WA/Seattle/1200-2nd-Ave-98101/home/999999"


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.version = 0

    def list_objects_v2(self, **_kwargs):
        return {
            "Contents": [{"Key": key} for key in sorted(self.objects)],
            "IsTruncated": False,
        }

    def get_object(self, Bucket, Key):
        del Bucket
        if Key not in self.objects:
            raise FakeClientError("NoSuchKey")
        obj = self.objects[Key]
        return {"Body": io.BytesIO(obj["body"]), "ETag": obj["etag"]}

    def head_object(self, Bucket, Key):
        del Bucket
        if Key not in self.objects:
            raise FakeClientError("404")
        return {"ETag": self.objects[Key]["etag"]}

    def put_object(self, Bucket, Key, Body, IfMatch=None, IfNoneMatch=None, **_kwargs):
        del Bucket
        current = self.objects.get(Key)
        if IfNoneMatch == "*" and current:
            raise FakeClientError("PreconditionFailed")
        if IfMatch and (not current or current["etag"] != IfMatch):
            raise FakeClientError("PreconditionFailed")
        self.version += 1
        etag = f'"etag-{self.version}"'
        self.objects[Key] = {"body": Body, "etag": etag}
        return {"ETag": etag}


def event(method, path="/property", key=LISTING_KEY, body=None, headers=None):
    result = {
        "requestContext": {"http": {"method": method}},
        "rawPath": path,
        "queryStringParameters": {"key": key} if key else {},
        "headers": {
            "authorization": "Bearer test-token-with-at-least-24-chars",
            **(headers or {}),
        },
    }
    if body is not None:
        result["body"] = json.dumps(body)
    return result


def record(score=86, listing_key=LISTING_KEY):
    return {
        "schemaVersion": 1,
        "listingKey": listing_key,
        "redfinHomeId": listing_key.rsplit("/", 1)[-1],
        "address": {"streetAddress": "2544 NE 90th St"},
        "geo": {
            "latitude": 47.6937989,
            "longitude": -122.3724072
        },
        "parcel": {
            "parcelId": "1234567890",
        },
        "report": {"aggregateScore": score},
    }


class PropertyApiTests(unittest.TestCase):
    def setUp(self):
        app.s3 = FakeS3()
        if os.path.exists(app.LOCAL_PARQUET):
            try:
                os.remove(app.LOCAL_PARQUET)
            except OSError:
                pass

    def test_create_get_update_list_and_tombstone(self):
        # 1. Store via PUT
        created = app.lambda_handler(event("PUT", body=record()), None)
        self.assertEqual(created["statusCode"], 201)
        first_etag = created["headers"]["ETag"]
        
        # Verify response structure matches sidepanel report expectation
        body = json.loads(created["body"])
        self.assertEqual(body["aggregateScore"], 100)
        self.assertIn("GeoJSON", body["summary"])
        
        # Verify the GeoJSON Feature structure inside S3
        saved_feature = body["geojson"]
        self.assertEqual(saved_feature["type"], "Feature")
        self.assertEqual(saved_feature["geometry"]["type"], "Point")
        # Standard GeoJSON coordinates are [longitude, latitude]
        self.assertEqual(saved_feature["geometry"]["coordinates"], [-122.3724072, 47.6937989])
        self.assertEqual(saved_feature["properties"]["redfinHomeId"], "318529")

        # 2. Retrieve via GET
        fetched = app.lambda_handler(event("GET"), None)
        self.assertEqual(fetched["statusCode"], 200)
        fetched_feature = json.loads(fetched["body"])
        self.assertEqual(fetched_feature["type"], "Feature")
        self.assertEqual(fetched_feature["properties"]["redfinHomeId"], "318529")
        self.assertEqual(fetched_feature["properties"]["report"]["aggregateScore"], 86)

        # 3. Update requires If-Match header
        missing_precondition = app.lambda_handler(event("PUT", body=record(91)), None)
        self.assertEqual(missing_precondition["statusCode"], 428)

        # 4. Successful PUT update
        updated = app.lambda_handler(
            event("PUT", body=record(91), headers={"if-match": first_etag}),
            None,
        )
        self.assertEqual(updated["statusCode"], 200)
        second_etag = updated["headers"]["ETag"]

        # 5. List properties returns standard FeatureCollection
        listed = app.lambda_handler(event("GET", path="/properties", key=None), None)
        self.assertEqual(listed["headers"]["ETag"], second_etag)
        collection = json.loads(listed["body"])
        self.assertEqual(collection["type"], "FeatureCollection")
        self.assertEqual(len(collection["features"]), 1)
        self.assertEqual(collection["features"][0]["properties"]["redfinHomeId"], "318529")

        # 6. Delete property marks it tombstoned
        deleted = app.lambda_handler(
            event("DELETE", headers={"if-match": second_etag}),
            None,
        )
        self.assertEqual(deleted["statusCode"], 200)

        # 7. List properties ignores tombstones
        listed_after_delete = app.lambda_handler(
            event("GET", path="/properties", key=None),
            None,
        )
        collection_after_delete = json.loads(listed_after_delete["body"])
        self.assertEqual(len(collection_after_delete["features"]), 0)

    def test_adds_second_property_with_portfolio_etag(self):
        created = app.lambda_handler(event("POST", key=None, body=record()), None)
        first_etag = created["headers"]["ETag"]

        second = app.lambda_handler(
            event(
                "POST",
                key=None,
                body=record(listing_key=SECOND_LISTING_KEY),
                headers={"if-match": first_etag},
            ),
            None,
        )
        self.assertEqual(second["statusCode"], 200)

        listed = app.lambda_handler(event("GET", path="/properties", key=None), None)
        collection = json.loads(listed["body"])
        self.assertEqual(len(collection["features"]), 2)

    def test_post_ingestion_without_query_parameters(self):
        # Test property ingestion via POST where listingKey is only in the body
        created = app.lambda_handler(event("POST", key=None, body=record()), None)
        self.assertEqual(created["statusCode"], 201)
        
        # Verify retrieved object
        fetched = app.lambda_handler(event("GET"), None)
        self.assertEqual(fetched["statusCode"], 200)
        fetched_feature = json.loads(fetched["body"])
        self.assertEqual(fetched_feature["properties"]["listingKey"], LISTING_KEY)

    def test_options_preflight(self):
        # OPTIONS request should return 204 with CORS headers
        res = app.lambda_handler(event("OPTIONS"), None)
        self.assertEqual(res["statusCode"], 204)
        self.assertEqual(res["headers"]["Access-Control-Allow-Origin"], "*")
        self.assertIn("POST", res["headers"]["Access-Control-Allow-Methods"])

    def test_rejects_invalid_key(self):
        unknown_route = app.lambda_handler(
            event("GET", path="/unknown"),
            None,
        )
        self.assertEqual(unknown_route["statusCode"], 404)

        invalid_key = app.lambda_handler(
            event("GET", key="../secrets"),
            None,
        )
        self.assertEqual(invalid_key["statusCode"], 400)

    def test_rejects_missing_token(self):
        request = event("GET")
        request["headers"] = {}
        result = app.lambda_handler(request, None)
        self.assertEqual(result["statusCode"], 401)


if __name__ == "__main__":
    unittest.main()

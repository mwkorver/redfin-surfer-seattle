# Property Sync Backend

One Lambda Function URL stores the canonical portfolio in the existing private
S3 bucket. The portfolio is a DuckDB-generated Parquet file at:

```text
properties/portfolio.parquet
```

The Function URL is public, but every non-`OPTIONS` request requires:

```http
Authorization: Bearer <sync-token>
```

## API

```text
GET    /properties
GET    /property?key=redfin/WA/Seattle/.../home/318529
POST   /property
PUT    /property
DELETE /property?key=redfin/WA/Seattle/.../home/318529
```

`POST` and `PUT` accept the `listingKey` in the JSON body. The first write
creates the portfolio. Later writes require the current portfolio ETag:

```http
If-Match: "<etag>"
```

Successful reads and writes return the current ETag. A write without the
required precondition returns `428` with `serverEtag`; a stale ETag returns
`409`. The Chrome extension retries against the latest ETag.

Deletes write a tombstone row. List and property reads exclude tombstones.
Request bodies are limited to 256 KiB. Stored fields are the listing key,
Redfin home ID, price, address, coordinates, parcel enrichment, diligence
report, timestamps, and point geometry.

## Deploy

Prerequisites: AWS CLI and AWS SAM CLI configured for the target account.

```bash
cd backend
sam build
sam deploy --guided
```

Provide a random token of at least 24 characters for `SyncToken`, then enter
the resulting Function URL and token in the extension settings.

## Test

```bash
cd backend
python3 -m unittest discover -s tests -v
```

The shared bearer token is appropriate only for a personal deployment. A
multi-user service should use per-user identity and authorization.

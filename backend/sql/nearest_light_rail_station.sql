WITH property AS (
    SELECT ST_FlipCoordinates(ST_Point($longitude, $latitude)) AS geometry
),
stations AS (
    SELECT
        stationId AS station_id,
        name AS station_name,
        lines,
        ST_FlipCoordinates(geom) AS geometry
    FROM ST_Read('data/light_rail_stations.geojson')
)
SELECT
    station_id,
    station_name,
    lines,
    ST_Distance_Sphere(property.geometry, stations.geometry) AS distance_meters,
    ST_Distance_Sphere(property.geometry, stations.geometry) / 1609.344 AS distance_miles
FROM stations
CROSS JOIN property
ORDER BY distance_meters
LIMIT 2;

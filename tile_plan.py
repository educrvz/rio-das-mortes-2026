"""Shared mixed-resolution tile plan for the Rio das Mortes app."""

import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ROUTE_DATA = ROOT / "route-data.js"
ZOOM_MIN = 10
ZOOM_MAX = 17

RIVER_BUFFER_BY_ZOOM = {
    **{zoom: 20.0 for zoom in range(10, 14)},
    **{zoom: 5.0 for zoom in range(14, 16)},
    **{zoom: 2.5 for zoom in range(16, 18)},
}
ROAD_BUFFER_BY_ZOOM = {
    10: 10.0,
    11: 10.0,
    12: 10.0,
    13: 5.0,
    14: 1.5,
    15: 1.5,
    16: 1.0,
    17: 1.0,
}


def deg2tile(lat, lon, zoom):
    lat_rad = math.radians(lat)
    n = 2**zoom
    x = int((lon + 180) / 360 * n)
    y = int(
        (1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi)
        / 2
        * n
    )
    return x, y


def tile_bounds(z, x, y):
    n = 2**z

    def longitude(tile_x):
        return tile_x / n * 360.0 - 180.0

    def latitude(tile_y):
        mercator = math.pi * (1 - 2 * tile_y / n)
        return math.degrees(math.atan(math.sinh(mercator)))

    return longitude(x), latitude(y + 1), longitude(x + 1), latitude(y)


def load_data():
    text = ROUTE_DATA.read_text()
    json_str = text[len("const ROUTE_DATA = ") :].rstrip().rstrip(";")
    data = json.loads(json_str)
    river = [(point[1], point[0]) for point in data["route"]]
    if data.get("altRoute"):
        river += [(point[1], point[0]) for point in data["altRoute"]]
    roads = [
        [(point[1], point[0]) for point in road["route"]]
        for road in data.get("roads", [])
    ]
    return river, roads


def add_buffered_tiles(tiles, points, zoom, buffer_km):
    buffer_deg_lat = buffer_km / 111.0
    for lat, lon in points:
        buffer_deg_lon = buffer_km / (111.0 * math.cos(math.radians(lat)))
        tx_min, ty_max = deg2tile(lat - buffer_deg_lat, lon - buffer_deg_lon, zoom)
        tx_max, ty_min = deg2tile(lat + buffer_deg_lat, lon + buffer_deg_lon, zoom)
        for tx in range(tx_min, tx_max + 1):
            for ty in range(ty_min, ty_max + 1):
                tiles.add((zoom, tx, ty))


def haversine_km(start, end):
    lat1, lon1 = start
    lat2, lon2 = end
    radius = 6371.0088
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lon2 - lon1)
    value = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    return 2 * radius * math.asin(min(1.0, math.sqrt(value)))


def densify_line(points, maximum_spacing_km):
    """Interpolate sparse KML segments so the complete line receives coverage."""
    if not points:
        return []
    dense = [points[0]]
    for start, end in zip(points, points[1:]):
        steps = max(1, math.ceil(haversine_km(start, end) / maximum_spacing_km))
        for step in range(1, steps + 1):
            fraction = step / steps
            dense.append(
                (
                    start[0] + (end[0] - start[0]) * fraction,
                    start[1] + (end[1] - start[1]) * fraction,
                )
            )
    return dense


def get_needed_tiles(river, roads):
    all_tiles = {zoom: set() for zoom in range(ZOOM_MIN, ZOOM_MAX + 1)}
    for zoom, buffer_km in RIVER_BUFFER_BY_ZOOM.items():
        add_buffered_tiles(
            all_tiles[zoom], densify_line(river, buffer_km * 0.75), zoom, buffer_km
        )
    for zoom, buffer_km in ROAD_BUFFER_BY_ZOOM.items():
        for road in roads:
            add_buffered_tiles(
                all_tiles[zoom], densify_line(road, buffer_km * 0.75), zoom, buffer_km
            )
    return all_tiles


def write_manifest(tiles_by_zoom, output=ROOT / "tile-manifest.js"):
    index = {}
    for z, tiles in sorted(tiles_by_zoom.items()):
        z_index = {}
        for _, x, y in sorted(tiles):
            z_index.setdefault(str(x), []).append(y)
        index[str(z)] = z_index

    tile_paths = sorted((ROOT / "tiles").glob("*/*/*.jpg"))
    package_bytes = sum(path.stat().st_size for path in tile_paths)
    digest = hashlib.sha256()
    for path in tile_paths:
        digest.update(path.relative_to(ROOT).as_posix().encode())
        with path.open("rb") as tile_file:
            for block in iter(lambda: tile_file.read(1024 * 1024), b""):
                digest.update(block)
    package_meta = {
        "id": digest.hexdigest()[:20],
        "count": sum(len(tiles) for tiles in tiles_by_zoom.values()),
        "bytes": package_bytes,
        "source": "INPE CBERS-4A/WPM",
        "license": "CC BY 4.0",
    }
    manifest = (
        "const TILE_PACKAGE_META = "
        + json.dumps(package_meta, separators=(",", ":"))
        + ";\nconst TILE_INDEX = "
        + json.dumps(index, separators=(",", ":"))
        + ";\n\nfunction getTileList() {\n"
        + "  const list = [];\n"
        + "  for (const z in TILE_INDEX)\n"
        + "    for (const x in TILE_INDEX[z])\n"
        + "      for (const y of TILE_INDEX[z][x])\n"
        + "        list.push(`tiles/${z}/${x}/${y}.jpg`);\n"
        + "  return list;\n}\n"
    )
    output.write_text(manifest)
    return package_meta["count"]

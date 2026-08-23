#!/usr/bin/env python3
"""Fail fast when the production PWA or offline package is incomplete."""

import json
import math
import re
import sys
from pathlib import Path
from PIL import Image, ImageStat

from tile_plan import ROOT, deg2tile, get_needed_tiles, haversine_km, load_data


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_javascript_json(path, prefix):
    text = path.read_text()
    if not text.startswith(prefix):
        fail(f"{path.name} does not start with {prefix!r}")
    return json.loads(text[len(prefix) :].rstrip().rstrip(";"))


def validate_route_data():
    data = load_javascript_json(ROOT / "route-data.js", "const ROUTE_DATA = ")
    expected = {
        "route": 84,
        "kmMarkers": 93,
        "pois": 55,
        "hospitals": 3,
        "roads": 5,
    }
    for key, count in expected.items():
        actual = len(data.get(key, []))
        if actual != count:
            fail(f"route-data.js {key}: expected {count}, found {actual}")
    if abs(data.get("totalKm", 0) - 91.66) > 0.02:
        fail(f"route length changed unexpectedly: {data.get('totalKm')}")
    print("Route data: 91.66 km · 93 markers · 55 POIs · 5 roads · 3 hospitals")


def parse_tile_manifest():
    text = (ROOT / "tile-manifest.js").read_text()
    meta_match = re.search(r"const TILE_PACKAGE_META = (\{.*?\});\s*\n", text, re.DOTALL)
    match = re.search(r"const TILE_INDEX = (\{.*?\});\s*\n", text, re.DOTALL)
    if not meta_match or not match:
        fail("tile-manifest.js is not parseable")
    meta = json.loads(meta_match.group(1))
    index = json.loads(match.group(1))
    tiles = {
        (int(z), int(x), int(y))
        for z, columns in index.items()
        for x, rows in columns.items()
        for y in rows
    }
    return meta, tiles


def validate_centerline_coverage(lines, zoom, manifest, spacing_km=0.25):
    images = {}
    for line_number, points in enumerate(lines, 1):
        for start, end in zip(points, points[1:]):
            steps = max(1, int(haversine_km(start, end) / spacing_km) + 1)
            for step in range(steps + 1):
                fraction = step / steps
                lat = start[0] + (end[0] - start[0]) * fraction
                lon = start[1] + (end[1] - start[1]) * fraction
                x, y = deg2tile(lat, lon, zoom)
                if (zoom, x, y) not in manifest:
                    fail(
                        f"line {line_number} has no z{zoom} imagery at "
                        f"{lat:.6f},{lon:.6f}"
                    )
                path = ROOT / "tiles" / str(zoom) / str(x) / f"{y}.jpg"
                if path not in images:
                    images[path] = Image.open(path).convert("RGB")
                world_x = (lon + 180.0) / 360.0 * (2**zoom)
                lat_rad = math.radians(lat)
                world_y = (
                    1
                    - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi
                ) / 2 * (2**zoom)
                pixel_x = min(255, max(0, int((world_x - math.floor(world_x)) * 256)))
                pixel_y = min(255, max(0, int((world_y - math.floor(world_y)) * 256)))
                pixel = images[path].getpixel((pixel_x, pixel_y))
                if max(pixel) < 3:
                    fail(
                        f"line {line_number} crosses black no-data at z{zoom} "
                        f"{lat:.6f},{lon:.6f}"
                    )
    for image in images.values():
        image.close()


def validate_tiles():
    river, roads = load_data()
    planned_by_zoom = get_needed_tiles(river, roads)
    planned = {tile for tiles in planned_by_zoom.values() for tile in tiles}
    package_meta, manifest = parse_tile_manifest()
    if manifest != planned:
        fail(
            f"tile manifest differs from plan: {len(planned - manifest)} missing, "
            f"{len(manifest - planned)} unexpected"
        )

    files = set()
    total_size = 0
    for path in (ROOT / "tiles").glob("*/*/*.jpg"):
        try:
            tile = (int(path.parent.parent.name), int(path.parent.name), int(path.stem))
        except ValueError:
            fail(f"invalid tile path: {path.relative_to(ROOT)}")
        size = path.stat().st_size
        if size < 100 or path.read_bytes()[:2] != b"\xff\xd8":
            fail(f"invalid JPEG tile: {path.relative_to(ROOT)}")
        with Image.open(path) as image:
            if image.size != (256, 256):
                fail(f"unexpected tile dimensions: {path.relative_to(ROOT)}")
            stats = ImageStat.Stat(image.convert("RGB").resize((16, 16)))
            if sum(stats.mean) / 3 < 2:
                fail(f"near-black no-data tile: {path.relative_to(ROOT)}")
        files.add(tile)
        total_size += size
    if files != manifest:
        fail(
            f"tile files differ from manifest: {len(manifest - files)} missing, "
            f"{len(files - manifest)} unexpected"
        )
    if package_meta.get("count") != len(manifest):
        fail("TILE_PACKAGE_META count differs from manifest")
    if package_meta.get("bytes") != total_size:
        fail("TILE_PACKAGE_META bytes differs from tile files")
    if not re.fullmatch(r"[0-9a-f]{20}", package_meta.get("id", "")):
        fail("TILE_PACKAGE_META id is missing or invalid")
    validate_centerline_coverage([river], 17, manifest)
    validate_centerline_coverage(roads, 16, manifest)
    print(f"Offline imagery: {len(files):,} JPEG tiles · {total_size / 1024 / 1024:.1f} MB")


def validate_shell():
    service_worker = (ROOT / "sw.js").read_text()
    app_shell_match = re.search(r"const APP_SHELL = \[(.*?)\];", service_worker, re.DOTALL)
    if not app_shell_match:
        fail("service-worker app shell is not parseable")
    paths = re.findall(r"['\"](\./[^'\"]*)['\"]", app_shell_match.group(1))
    for item in paths:
        relative = item.removeprefix("./").split("?", 1)[0]
        if relative and not (ROOT / relative).exists():
            fail(f"service-worker asset does not exist: {item}")
    if "unpkg.com" in (ROOT / "index.html").read_text():
        fail("index.html still depends on the Leaflet CDN")
    index_html = (ROOT / "index.html").read_text()
    route_data = load_javascript_json(ROOT / "route-data.js", "const ROUTE_DATA = ")
    poi_types = {poi["type"] for poi in route_data["pois"]}
    filter_types = set(re.findall(r"togglePOILayer\('([^']+)'\)", index_html))
    if filter_types != poi_types | {"bridge"}:
        fail(f"POI filters differ from data types: filters={filter_types}, data={poi_types}")
    manifest = json.loads((ROOT / "manifest.json").read_text())
    for icon in manifest.get("icons", []):
        if not (ROOT / icon["src"].split("?", 1)[0]).exists():
            fail(f"manifest icon does not exist: {icon['src']}")
    print(f"PWA shell: {len(paths)} cached local assets · local Leaflet · manifest icons present")


def validate_imagery_provenance():
    data = json.loads((ROOT / "data" / "mortes-2026-imagery.json").read_text())
    if data.get("license") != "CC BY 4.0" or len(data.get("scenes", [])) != 16:
        fail("imagery provenance must contain 16 pinned CC BY 4.0 scenes")
    if any(not scene["url"].startswith("https://data.inpe.br/") for scene in data["scenes"]):
        fail("imagery provenance contains a non-INPE scene")
    print("Imagery provenance: 16 pinned INPE CBERS-4A/WPM scenes · CC BY 4.0")


def validate_public_provenance():
    poi_text = (ROOT / "data" / "mortes-2026-pois.json").read_text()
    route_text = (ROOT / "route-data.js").read_text()
    if "docs.google.com/spreadsheets" in poi_text or "docs.google.com/spreadsheets" in route_text:
        fail("private Google Sheet URL leaked into public release data")
    print("Public provenance: local POI snapshot; private Sheet identifier omitted")


def main():
    validate_route_data()
    validate_imagery_provenance()
    validate_public_provenance()
    validate_tiles()
    validate_shell()
    print("Production release validation passed")


if __name__ == "__main__":
    main()

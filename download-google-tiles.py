#!/usr/bin/env python3
"""Replicate the earlier expedition apps' Google Satellite offline package."""

import argparse
import hashlib
import http.client
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from PIL import Image, UnidentifiedImageError

from tile_plan import ROOT, get_needed_tiles, load_data

TILES_DIR = ROOT / "google" / "tiles"
MANIFEST_PATH = ROOT / "google" / "tile-manifest.js"
TILE_URL = "https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36"
    )
}


def valid_jpeg(data):
    if len(data) < 100 or data[:2] != b"\xff\xd8":
        return False
    try:
        with Image.open(io.BytesIO(data)) as image:
            valid = image.format == "JPEG" and image.size == (256, 256)
            image.verify()
        return valid
    except (OSError, UnidentifiedImageError):
        return False


def valid_tile(path):
    return path.exists() and valid_jpeg(path.read_bytes())


def download_tile(tile):
    z, x, y = tile
    path = TILES_DIR / str(z) / str(x) / f"{y}.jpg"
    if valid_tile(path):
        return "skip"
    path.parent.mkdir(parents=True, exist_ok=True)
    server = (x + y + z) % 4
    url = TILE_URL.format(s=server, x=x, y=y, z=z)
    for attempt in range(3):
        try:
            request = Request(url, headers=HEADERS)
            data = urlopen(request, timeout=20).read()
            if not valid_jpeg(data):
                raise ValueError("response is not a JPEG tile")
            temporary = path.with_suffix(".jpg.part")
            temporary.write_bytes(data)
            temporary.replace(path)
            return "ok"
        except (HTTPError, URLError, TimeoutError, ValueError, http.client.HTTPException):
            time.sleep(0.5 * (attempt + 1))
    return "fail"


def write_manifest(tiles_by_zoom):
    index = {}
    for z, tiles in sorted(tiles_by_zoom.items()):
        columns = {}
        for _, x, y in sorted(tiles):
            columns.setdefault(str(x), []).append(y)
        index[str(z)] = columns

    tile_paths = sorted(TILES_DIR.glob("*/*/*.jpg"))
    package_bytes = sum(path.stat().st_size for path in tile_paths)
    digest = hashlib.sha256()
    for path in tile_paths:
        digest.update(path.relative_to(ROOT / "google").as_posix().encode())
        with path.open("rb") as tile_file:
            for block in iter(lambda: tile_file.read(1024 * 1024), b""):
                digest.update(block)
    package_meta = {
        "id": digest.hexdigest()[:20],
        "count": sum(len(tiles) for tiles in tiles_by_zoom.values()),
        "bytes": package_bytes,
        "source": "Google Satellite",
        "use": "research replication",
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
    MANIFEST_PATH.write_text(manifest)
    return package_meta


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument("--shard-index", type=int, default=0)
    args = parser.parse_args()
    if args.shard_count < 1 or not 0 <= args.shard_index < args.shard_count:
        parser.error("shard index must be within shard count")

    river, roads = load_data()
    planned = get_needed_tiles(river, roads)
    all_tiles = sorted(tile for zoom_tiles in planned.values() for tile in zoom_tiles)
    selected = all_tiles[args.shard_index :: args.shard_count]
    print(
        f"Google Satellite research package: {len(all_tiles):,} planned; "
        f"shard {args.shard_index + 1}/{args.shard_count}: {len(selected):,}"
    )

    counts = {"ok": 0, "skip": 0, "fail": 0}
    started = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(download_tile, tile) for tile in selected]
        for completed, future in enumerate(as_completed(futures), 1):
            try:
                result = future.result()
            except Exception as error:
                result = "fail"
                print(f"Unexpected download error: {type(error).__name__}: {error}")
            counts[result] += 1
            if completed % 200 == 0 or completed == len(selected):
                elapsed = max(0.01, time.time() - started)
                print(
                    f"[{completed / len(selected) * 100:5.1f}%] "
                    f"{completed:,}/{len(selected):,} · {counts['ok']:,} new · "
                    f"{counts['skip']:,} cached · {counts['fail']:,} failed · "
                    f"{completed / elapsed:.1f} tiles/s",
                    flush=True,
                )

    if counts["fail"]:
        raise SystemExit(f"{counts['fail']} tile downloads failed")
    if args.shard_count == 1:
        meta = write_manifest(planned)
        print(
            f"Manifest: {meta['count']:,} tiles · "
            f"{meta['bytes'] / 1024 / 1024:.1f} MB · {meta['id']}"
        )


if __name__ == "__main__":
    main()

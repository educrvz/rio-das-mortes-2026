#!/usr/bin/env python3
"""Build the licensed offline image package from pinned INPE CBERS-4A COGs."""

import argparse
import io
import json
import os
import time
import numpy as np
from PIL import Image, ImageStat
try:
    from rio_tiler.io import Reader
except ImportError as exc:
    raise SystemExit(
        "Install imagery dependencies first: pip install -r requirements-imagery.txt"
    ) from exc

from tile_plan import ROOT, get_needed_tiles, load_data, tile_bounds, write_manifest

IMAGERY_DATA = ROOT / "data" / "mortes-2026-imagery.json"
TILES_DIR = ROOT / "tiles"
DEFAULT_DELAY = 0.08
JPEG_QUALITY = 82
_readers = {}


def intersects(a, b):
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


def intersection_area(a, b):
    width = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    height = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    return width * height


def read_tile(url, x, y, z):
    reader = _readers.get(url)
    if reader is None:
        reader = Reader(url)
        reader.__enter__()
        _readers[url] = reader
    return reader.tile(x, y, z, tilesize=256)


def reset_readers(urls=None):
    targets = list(_readers) if urls is None else [url for url in urls if url in _readers]
    for url in targets:
        reader = _readers.pop(url)
        try:
            reader.__exit__(None, None, None)
        except Exception:
            pass


def render_tile_once(tile, scenes):
    z, x, y = tile
    bounds = tile_bounds(z, x, y)
    candidates = sorted(
        (scene for scene in scenes if intersects(bounds, scene["bbox"])),
        key=lambda scene: intersection_area(bounds, scene["bbox"]),
        reverse=True,
    )
    if not candidates:
        return "uncovered", tile

    # WPM scene bounding boxes include rotated no-data wedges. Composite valid
    # pixels from overlapping scenes rather than preserving a black wedge.
    canvas = np.zeros((3, 256, 256), dtype=np.uint8)
    filled = np.zeros((256, 256), dtype=bool)
    for candidate in candidates:
        candidate_image = read_tile(candidate["url"], x, y, z)
        pixels = np.asarray(candidate_image.array)[:3]
        valid = np.asarray(candidate_image.mask) > 0
        take = valid & ~filled
        canvas[:, take] = pixels[:, take]
        filled |= valid
        if filled.all():
            break
    if not filled.any():
        return "uncovered", tile
    output = TILES_DIR / str(z) / str(x) / f"{y}.jpg"
    output.parent.mkdir(parents=True, exist_ok=True)
    encoded = io.BytesIO()
    Image.fromarray(np.moveaxis(canvas, 0, -1), mode="RGB").save(
        encoded, format="JPEG", quality=JPEG_QUALITY
    )
    output.write_bytes(encoded.getvalue())
    return "ok", tile


def render_tile(tile, scenes):
    for attempt in range(5):
        try:
            return render_tile_once(tile, scenes)
        except Exception as exc:  # Retry transient COG/rate-limit failures.
            reset_readers()
            if attempt == 4:
                return f"error:{type(exc).__name__}:{exc}", tile
            time.sleep(2**attempt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--delay",
        type=float,
        default=DEFAULT_DELAY,
        help="Courtesy delay between tiles; keep this non-zero for the public INPE service.",
    )
    parser.add_argument("--limit", type=int, help="Render only the first N missing tiles")
    parser.add_argument("--shard-count", type=int, default=1, help="Split pending work across N processes")
    parser.add_argument("--shard-index", type=int, default=0, help="Zero-based shard handled by this process")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument(
        "--repair-blank",
        action="store_true",
        help="Re-render existing near-black tiles caused by scene-edge no-data wedges.",
    )
    parser.add_argument(
        "--repair-overlaps",
        action="store_true",
        help="Re-render tiles touched by multiple scenes using the compositing pipeline.",
    )
    parser.add_argument(
        "--repair-edge",
        action="store_true",
        help="Re-render overlap tiles containing measurable black no-data pixels.",
    )
    args = parser.parse_args()
    if args.shard_count < 1 or not 0 <= args.shard_index < args.shard_count:
        parser.error("--shard-index must be between 0 and --shard-count - 1")

    imagery = json.loads(IMAGERY_DATA.read_text())
    scenes = imagery["scenes"]
    river, roads = load_data()
    planned = get_needed_tiles(river, roads)
    all_tiles = [tile for zoom in sorted(planned) for tile in sorted(planned[zoom])]
    selected_tiles = all_tiles[args.shard_index :: args.shard_count]
    pending = []
    for z, x, y in selected_tiles:
        output = TILES_DIR / str(z) / str(x) / f"{y}.jpg"
        needs_repair = False
        if args.repair_blank and output.exists():
            with Image.open(output) as image:
                stats = ImageStat.Stat(image.convert("RGB").resize((16, 16)))
                needs_repair = sum(stats.mean) / 3 < 2
        if args.repair_overlaps and output.exists():
            bounds = tile_bounds(z, x, y)
            needs_repair = sum(
                1 for scene in scenes if intersects(bounds, scene["bbox"])
            ) > 1
        if args.repair_edge and output.exists():
            bounds = tile_bounds(z, x, y)
            overlaps = sum(1 for scene in scenes if intersects(bounds, scene["bbox"]))
            if overlaps > 1:
                with Image.open(output) as image:
                    pixels = np.asarray(image.convert("RGB").resize((64, 64)))
                    needs_repair = bool((pixels.max(axis=2) < 3).mean() > 0.001)
        if args.overwrite or needs_repair or not output.exists() or output.stat().st_size < 100:
            pending.append((z, x, y))
    if args.limit:
        pending = pending[: args.limit]

    print(f"Planned: {len(all_tiles):,} tiles; pending: {len(pending):,}")
    print(
        f"Source: {imagery['provider']} · {imagery['collection']} · "
        f"{imagery['license']} · {len(scenes)} pinned scenes"
    )
    if not pending:
        if args.shard_count == 1 and not args.limit:
            count = write_manifest(planned)
            print(f"Nothing to render; manifest contains {count:,} tiles")
        else:
            print("Nothing to render for this shard")
        return

    started = time.time()
    counts = {"ok": 0, "uncovered": 0, "error": 0}
    failures = []
    try:
        for completed, tile in enumerate(pending, 1):
            result, tile = render_tile(tile, scenes)
            key = result if result in counts else "error"
            counts[key] += 1
            if key != "ok":
                failures.append((tile, result))
            if completed % 100 == 0 or completed == len(pending):
                elapsed = max(time.time() - started, 0.001)
                print(
                    f"[{completed / len(pending):6.1%}] {completed:,}/{len(pending):,} · "
                    f"{counts['ok']:,} written · {counts['uncovered']:,} uncovered · "
                    f"{counts['error']:,} errors · {completed / elapsed:.1f} tiles/s",
                    flush=True,
                )
            if args.delay:
                time.sleep(args.delay)
    finally:
        reset_readers()

    if failures:
        for tile, error in failures[:20]:
            print(f"FAILED {tile}: {error}")
        raise SystemExit(f"Tile build incomplete: {len(failures)} failures")

    if not args.limit and args.shard_count == 1:
        count = write_manifest(planned)
        print(f"Wrote tile-manifest.js with {count:,} tiles")
    total_size = sum(path.stat().st_size for path in TILES_DIR.rglob("*.jpg"))
    print(f"Tile package: {total_size / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    os.environ.setdefault("GDAL_HTTP_MULTIPLEX", "YES")
    os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
    os.environ.setdefault("VSI_CACHE", "TRUE")
    os.environ.setdefault("VSI_CACHE_SIZE", "5000000")
    main()

#!/usr/bin/env python3
"""Download Google Satellite tiles for the Rio das Mortes corridor."""

import json, math, os, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

TILES_DIR = os.path.join(os.path.dirname(__file__), 'tiles')
ROUTE_DATA = os.path.join(os.path.dirname(__file__), 'route-data.js')
BUFFER_KM = 2.5
ZOOM_MIN = 10
ZOOM_MAX = 17
MAX_WORKERS = 12
TILE_URL = 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}'
HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}

def deg2tile(lat, lon, zoom):
    lat_rad = math.radians(lat)
    n = 2 ** zoom
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n)
    return x, y

def load_route():
    with open(ROUTE_DATA) as f:
        text = f.read()
    json_str = text[len('const ROUTE_DATA = '):].rstrip().rstrip(';')
    data = json.loads(json_str)
    points = [(p[1], p[0]) for p in data['route']]
    if data.get('altRoute'):
        points += [(p[1], p[0]) for p in data['altRoute']]
    return points

def get_needed_tiles(points):
    buffer_deg_lat = BUFFER_KM / 111.0
    all_tiles = {}
    for z in range(ZOOM_MIN, ZOOM_MAX + 1):
        tiles = set()
        for lat, lon in points:
            buffer_deg_lon = BUFFER_KM / (111.0 * math.cos(math.radians(lat)))
            min_lat = lat - buffer_deg_lat
            max_lat = lat + buffer_deg_lat
            min_lon = lon - buffer_deg_lon
            max_lon = lon + buffer_deg_lon
            tx_min, ty_max = deg2tile(min_lat, min_lon, z)
            tx_max, ty_min = deg2tile(max_lat, max_lon, z)
            for tx in range(tx_min, tx_max + 1):
                for ty in range(ty_min, ty_max + 1):
                    tiles.add((z, tx, ty))
        all_tiles[z] = tiles
    return all_tiles

def download_tile(z, x, y):
    path = os.path.join(TILES_DIR, str(z), str(x), f'{y}.jpg')
    if os.path.exists(path) and os.path.getsize(path) > 100:
        return 'skip'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    s = (x + y + z) % 4
    url = TILE_URL.format(s=s, x=x, y=y, z=z)
    for attempt in range(3):
        try:
            req = Request(url, headers=HEADERS)
            data = urlopen(req, timeout=15).read()
            with open(path, 'wb') as f:
                f.write(data)
            return 'ok'
        except (URLError, HTTPError, TimeoutError):
            time.sleep(0.5 * (attempt + 1))
    return 'fail'

def write_manifest(tiles_by_zoom):
    index = {}
    for z, tiles in sorted(tiles_by_zoom.items()):
        z_index = {}
        for _, x, y in sorted(tiles):
            z_index.setdefault(str(x), []).append(y)
        index[str(z)] = z_index

    manifest = (
        'const TILE_INDEX = '
        + json.dumps(index, separators=(',', ':'))
        + ';\n\nfunction getTileList() {\n'
        + '  const list = [];\n'
        + '  for (const z in TILE_INDEX)\n'
        + '    for (const x in TILE_INDEX[z])\n'
        + '      for (const y of TILE_INDEX[z][x])\n'
        + '        list.push(`tiles/${z}/${x}/${y}.jpg`);\n'
        + '  return list;\n}\n'
    )
    path = os.path.join(os.path.dirname(__file__), 'tile-manifest.js')
    with open(path, 'w') as f:
        f.write(manifest)
    print(f'Wrote tile-manifest.js with {sum(len(v) for v in tiles_by_zoom.values())} tiles')

def main():
    print('Loading route...')
    points = load_route()
    print(f'Route has {len(points)} points')

    print('Calculating needed tiles...')
    tiles_by_zoom = get_needed_tiles(points)
    all_tiles = []
    for z, tiles in sorted(tiles_by_zoom.items()):
        print(f'  Zoom {z:2d}: {len(tiles):6d} tiles')
        all_tiles.extend(tiles)
    print(f'  Total:  {len(all_tiles):6d} tiles')

    skipped = 0
    downloaded = 0
    failed = 0
    total = len(all_tiles)
    start_time = time.time()

    print(f'\nDownloading with {MAX_WORKERS} workers...')
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(download_tile, z, x, y): (z, x, y) for z, x, y in all_tiles}
        for i, future in enumerate(as_completed(futures), 1):
            result = future.result()
            if result == 'skip':
                skipped += 1
            elif result == 'ok':
                downloaded += 1
            else:
                failed += 1
            if i % 100 == 0 or i == total:
                elapsed = time.time() - start_time
                rate = (downloaded + skipped) / elapsed if elapsed > 0 else 0
                pct = i / total * 100
                print(f'  [{pct:5.1f}%] {i}/{total} — {downloaded} new, {skipped} cached, {failed} failed ({rate:.0f} tiles/s)')

    elapsed = time.time() - start_time
    print(f'\nDone in {elapsed:.0f}s — {downloaded} downloaded, {skipped} cached, {failed} failed')

    total_size = 0
    for root, dirs, files in os.walk(TILES_DIR):
        for f in files:
            total_size += os.path.getsize(os.path.join(root, f))
    print(f'Total tiles size: {total_size / 1024 / 1024:.1f} MB')
    write_manifest(tiles_by_zoom)

if __name__ == '__main__':
    main()

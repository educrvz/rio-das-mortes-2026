#!/usr/bin/env python3
"""Generate Rio das Mortes app data from the team's authoritative KML."""

import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DEFAULT_KML = ROOT / "data" / "Mortes-2026.kml"
OUTPUT = ROOT / "route-data.js"
NS = {"k": "http://www.opengis.net/kml/2.2"}
ROUTE_NAME = "Rio das Mortes (Vila Berrante- NSA)"
IGNORED_POIS = {"Novo Sto Antônio"}


def haversine(a, b):
    lon1, lat1 = a
    lon2, lat2 = b
    radius_km = 6371.0088
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lon2 - lon1)
    value = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    return 2 * radius_km * math.asin(min(1.0, math.sqrt(value)))


def parse_coordinates(text):
    coordinates = []
    for token in (text or "").replace("\n", " ").split():
        fields = token.split(",")
        if len(fields) >= 2:
            coordinates.append([float(fields[0]), float(fields[1])])
    return coordinates


def placemark_name(placemark):
    return (placemark.findtext("k:name", default="", namespaces=NS) or "").strip()


def direct_point(placemark):
    text = placemark.findtext("k:Point/k:coordinates", default="", namespaces=NS)
    points = parse_coordinates(text)
    return points[0] if points else None


def load_source(kml_path):
    root = ET.parse(kml_path).getroot()
    route = None
    controls = []
    pois = []

    for placemark in root.findall(".//k:Placemark", NS):
        name = placemark_name(placemark)
        line_text = placemark.findtext("k:LineString/k:coordinates", default="", namespaces=NS)
        if name == ROUTE_NAME and line_text:
            route = parse_coordinates(line_text)

        point = direct_point(placemark)
        if point and re.fullmatch(r"\d{3}|FIM", name):
            controls.append({"id": name, "coordinate": point})

    for folder in root.findall(".//k:Folder", NS):
        folder_name = (folder.findtext("k:name", default="", namespaces=NS) or "").strip()
        if folder_name not in {"Cidades", "POI"}:
            continue
        for placemark in folder.findall("k:Placemark", NS):
            name = placemark_name(placemark)
            if name in IGNORED_POIS:
                continue
            point = direct_point(placemark)
            if not point:
                continue
            poi_type = classify_poi(folder_name, name)
            pois.append({"name": name, "lat": point[1], "lon": point[0], "type": poi_type})

    if not route or len(route) < 2:
        raise ValueError(f"Detailed route LineString not found: {ROUTE_NAME}")
    if len(controls) < 2:
        raise ValueError("Expected numbered kilometer points plus FIM")
    return route, controls, deduplicate_pois(pois)


def classify_poi(folder_name, name):
    lowered = name.casefold()
    if folder_name == "Cidades":
        return "town"
    if "ponte" in lowered:
        return "bridge"
    if name == "Vila Berrante":
        return "exit"
    if "novo sto" in lowered or name == "Kuriala":
        return "town"
    return "house"


def deduplicate_pois(pois):
    seen = set()
    result = []
    for poi in pois:
        key = (poi["name"].casefold(), round(poi["lat"], 7), round(poi["lon"], 7))
        if key not in seen:
            seen.add(key)
            result.append(poi)
    return result


class LocalProjection:
    def __init__(self, latitude):
        self.x_scale = 111.32 * math.cos(math.radians(latitude))
        self.y_scale = 110.574

    def to_xy(self, point):
        return point[0] * self.x_scale, point[1] * self.y_scale


def project_onto_route(point, route, projection, cumulative):
    px, py = projection.to_xy(point)
    best = None
    for index, (start_geo, end_geo) in enumerate(zip(route, route[1:])):
        start = projection.to_xy(start_geo)
        end = projection.to_xy(end_geo)
        dx, dy = end[0] - start[0], end[1] - start[1]
        denominator = dx * dx + dy * dy
        fraction = 0.0 if denominator == 0 else (
            (px - start[0]) * dx + (py - start[1]) * dy
        ) / denominator
        fraction = max(0.0, min(1.0, fraction))
        projected = (start[0] + dx * fraction, start[1] + dy * fraction)
        offset = math.dist((px, py), projected)
        station = cumulative[index] + fraction * haversine(start_geo, end_geo)
        if best is None or offset < best[0]:
            best = (offset, station)
    return best


def validate_and_build_markers(route, controls):
    total_km = sum(haversine(a, b) for a, b in zip(route, route[1:]))
    cumulative = [0.0]
    for start, end in zip(route, route[1:]):
        cumulative.append(cumulative[-1] + haversine(start, end))
    projection = LocalProjection(sum(point[1] for point in route) / len(route))

    markers = []
    previous_station = -1.0
    max_offset = 0.0
    control_points = []
    for control in controls:
        offset, station = project_onto_route(
            control["coordinate"], route, projection, cumulative
        )
        if station < previous_station:
            raise ValueError(f"Point {control['id']} is out of downstream order")
        if offset > 0.001:
            raise ValueError(f"Point {control['id']} is {offset * 1000:.1f} m off route")
        previous_station = station
        max_offset = max(max_offset, offset)
        lon, lat = control["coordinate"]
        km = total_km if control["id"] == "FIM" else float(int(control["id"]))
        markers.append({"km": round(km, 2), "lat": lat, "lon": lon})
        control_points.append(
            {"id": control["id"], "lat": lat, "lon": lon, "km": round(station, 3)}
        )
    return total_km, markers, control_points, max_offset


def main():
    kml_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_KML
    route, controls, pois = load_source(kml_path)
    total_km, markers, control_points, max_offset = validate_and_build_markers(route, controls)
    data = {
        "name": "Rio das Mortes 2026",
        "totalKm": round(total_km, 2),
        "route": [[round(lon, 10), round(lat, 10)] for lon, lat in route],
        "controlPoints": control_points,
        "kmMarkers": markers,
        "pois": pois,
        "altRoute": [],
        "routeSource": "Detailed LineString and kilometer points from the team's Mortes 09/2026 KML",
    }
    OUTPUT.write_text(
        "const ROUTE_DATA = "
        + json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {OUTPUT.name}: {len(route)} route vertices, {len(control_points)} controls, "
        f"{len(markers)} markers, {len(pois)} POIs, {total_km:.2f} km, "
        f"max marker offset {max_offset * 1000:.6f} m"
    )


if __name__ == "__main__":
    main()

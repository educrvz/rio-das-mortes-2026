#!/usr/bin/env python3
"""Generate Rio das Mortes app data from the team's authoritative KML."""

import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DEFAULT_KML = ROOT / "data" / "Mortes-092026.kml"
POI_JSON = ROOT / "data" / "mortes-2026-pois.json"
EMERGENCY_JSON = ROOT / "data" / "mortes-2026-emergency.json"
OUTPUT = ROOT / "route-data.js"
NS = {"k": "http://www.opengis.net/kml/2.2"}
ROUTE_NAME = "Rio das Mortes (Vila Berrante- NSA)"
VALID_POI_TYPES = {"beach", "exit", "island", "town", "house", "lagoon", "airstrip"}


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
    roads = []

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
        if folder_name == "Estradas":
            for placemark in folder.findall("k:Placemark", NS):
                name = placemark_name(placemark)
                coordinates = parse_coordinates(
                    placemark.findtext(
                        "k:LineString/k:coordinates", default="", namespaces=NS
                    )
                )
                if len(coordinates) < 2:
                    continue
                length_km = sum(
                    haversine(start, end)
                    for start, end in zip(coordinates, coordinates[1:])
                )
                roads.append(
                    {
                        "name": name,
                        "lengthKm": round(length_km, 1),
                        "route": coordinates,
                    }
                )
            continue
    if not route or len(route) < 2:
        raise ValueError(f"Detailed route LineString not found: {ROUTE_NAME}")
    if len(controls) < 2:
        raise ValueError("Expected numbered kilometer points plus FIM")
    if not roads:
        raise ValueError("Expected the Estradas folder with road LineStrings")
    return route, controls, roads


def load_authoritative_pois():
    document = json.loads(POI_JSON.read_text(encoding="utf-8"))
    source = document["source"]
    pois = document["pois"]
    seen_ids = set()
    seen_coordinates = set()
    for poi in pois:
        if poi["type"] not in VALID_POI_TYPES:
            raise ValueError(f"Unsupported POI type: {poi['type']}")
        if poi["id"] in seen_ids:
            raise ValueError(f"Duplicate POI id: {poi['id']}")
        coordinate = (round(poi["lat"], 8), round(poi["lon"], 8))
        if coordinate in seen_coordinates:
            raise ValueError(f"Duplicate POI coordinate: {coordinate}")
        if not (-90 <= poi["lat"] <= 90 and -180 <= poi["lon"] <= 180):
            raise ValueError(f"Invalid POI coordinate: {poi['id']}")
        seen_ids.add(poi["id"])
        seen_coordinates.add(coordinate)
    return source, pois


def load_emergency_hospitals():
    document = json.loads(EMERGENCY_JSON.read_text(encoding="utf-8"))
    source = document["source"]
    hospitals = document["hospitals"]
    seen_cnes = set()
    for hospital in hospitals:
        if hospital.get("type") != "hospital":
            raise ValueError(f"Unsupported emergency type: {hospital.get('type')}")
        if hospital["cnes"] in seen_cnes:
            raise ValueError(f"Duplicate hospital CNES: {hospital['cnes']}")
        if not (-90 <= hospital["lat"] <= 90 and -180 <= hospital["lon"] <= 180):
            raise ValueError(f"Invalid hospital coordinate: {hospital['id']}")
        if not hospital.get("phones") or not hospital.get("antivenoms"):
            raise ValueError(f"Incomplete hospital record: {hospital['id']}")
        seen_cnes.add(hospital["cnes"])
    return source, hospitals


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
    route, controls, roads = load_source(kml_path)
    total_km, markers, control_points, max_offset = validate_and_build_markers(route, controls)
    poi_source, source_pois = load_authoritative_pois()
    emergency_source, hospitals = load_emergency_hospitals()
    cumulative = [0.0]
    for start, end in zip(route, route[1:]):
        cumulative.append(cumulative[-1] + haversine(start, end))
    projection = LocalProjection(sum(point[1] for point in route) / len(route))
    pois = []
    for poi in source_pois:
        offset, station = project_onto_route(
            [poi["lon"], poi["lat"]], route, projection, cumulative
        )
        pois.append(
            {
                **poi,
                "routeKm": round(station, 1),
                "offsetKm": round(offset, 2),
                "source": poi_source["title"],
                "sourceUrl": poi_source["publicSnapshot"],
            }
        )
    pois.sort(key=lambda poi: (poi["routeKm"], poi["type"], poi["id"]))
    data = {
        "name": "Rio das Mortes 2026",
        "totalKm": round(total_km, 2),
        "route": [[round(lon, 10), round(lat, 10)] for lon, lat in route],
        "controlPoints": control_points,
        "kmMarkers": markers,
        "pois": pois,
        "poiSource": poi_source,
        "hospitals": hospitals,
        "emergencySource": emergency_source,
        "roads": [
            {
                "name": road["name"],
                "lengthKm": road["lengthKm"],
                "route": [
                    [round(lon, 7), round(lat, 7)]
                    for lon, lat in road["route"]
                ],
            }
            for road in roads
        ],
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
        f"{len(markers)} markers, {len(pois)} POIs, {len(hospitals)} emergency hospitals, {len(roads)} roads, "
        f"{sum(road['lengthKm'] for road in roads):.1f} road km, {total_km:.2f} river km, "
        f"max marker offset {max_offset * 1000:.6f} m"
    )


if __name__ == "__main__":
    main()

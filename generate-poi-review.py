#!/usr/bin/env python3
"""Build a focused Google Earth KML for reviewing Rio das Mortes POIs."""

import json
import math
from html import escape
from pathlib import Path


ROOT = Path(__file__).resolve().parent
ROUTE_DATA = ROOT / "route-data.js"
OUTPUT = ROOT / "Rio das Mortes 2026 - Revisao POIs.kml"
NEAR_ROUTE_KM = 2.0


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


def load_data():
    text = ROUTE_DATA.read_text(encoding="utf-8")
    return json.loads(text.removeprefix("const ROUTE_DATA = ").rstrip().rstrip(";"))


def route_position(point, route):
    mean_latitude = math.radians(sum(item[1] for item in route) / len(route))
    x_scale = 111.320 * math.cos(mean_latitude)
    y_scale = 110.574

    def xy(item):
        return item[0] * x_scale, item[1] * y_scale

    cumulative = [0.0]
    for start, end in zip(route, route[1:]):
        cumulative.append(cumulative[-1] + haversine(start, end))

    px, py = xy(point)
    best = None
    for index, (start_geo, end_geo) in enumerate(zip(route, route[1:])):
        start = xy(start_geo)
        end = xy(end_geo)
        dx, dy = end[0] - start[0], end[1] - start[1]
        denominator = dx * dx + dy * dy
        fraction = 0.0 if denominator == 0 else (
            (px - start[0]) * dx + (py - start[1]) * dy
        ) / denominator
        fraction = max(0.0, min(1.0, fraction))
        nearest = (start[0] + dx * fraction, start[1] + dy * fraction)
        offset = math.dist((px, py), nearest)
        station = cumulative[index] + fraction * haversine(start_geo, end_geo)
        if best is None or offset < best[0]:
            best = offset, station
    return best


def suggested_category(poi):
    name = poi["name"].casefold()
    if poi["type"] == "exit":
        return "Acesso / entrada"
    if poi["type"] == "bridge":
        return "Ponte"
    if poi["type"] == "town":
        return "Cidade / apoio"
    if "pousada" in name:
        return "Pousada / apoio"
    if "rancho" in name:
        return "Rancho / referência"
    if "faz" in name:
        return "Fazenda / referência"
    if "barreira" in name:
        return "Referência a confirmar"
    return "Outro"


def placemark(row, prefix, style):
    label = f"{prefix} | KM {row['route_km']:.1f} | {row['name']}"
    description = (
        f"Sugestão: {row['category']}\n"
        f"Distância da rota: {row['offset_km']:.2f} km\n"
        "\nREVISAR:\n"
        "1. Manter ou remover do app?\n"
        "2. Nome está correto?\n"
        "3. Categoria/ícone está correto?\n"
        "4. Há telefone, contato, alerta ou observação útil?"
    )
    return f"""
    <Placemark>
      <name>{escape(label)}</name>
      <styleUrl>#{style}</styleUrl>
      <description>{escape(description)}</description>
      <Point><coordinates>{row['lon']:.10f},{row['lat']:.10f},0</coordinates></Point>
    </Placemark>"""


def km_placemark(marker, total_km):
    if marker["km"] == 0:
        label = "INÍCIO"
    elif marker["km"] == total_km:
        label = "FIM"
    else:
        label = f"KM {marker['km']:.0f}"
    return f"""
    <Placemark>
      <name>{label}</name>
      <styleUrl>#km</styleUrl>
      <Point><coordinates>{marker['lon']:.10f},{marker['lat']:.10f},0</coordinates></Point>
    </Placemark>"""


def main():
    data = load_data()
    rows = []
    for poi in data["pois"]:
        offset, station = route_position([poi["lon"], poi["lat"]], data["route"])
        rows.append(
            {
                **poi,
                "offset_km": offset,
                "route_km": station,
                "category": suggested_category(poi),
            }
        )
    near = sorted(
        [row for row in rows if row["offset_km"] <= NEAR_ROUTE_KM],
        key=lambda row: (row["route_km"], row["offset_km"]),
    )
    logistics = sorted(
        [row for row in rows if row["offset_km"] > NEAR_ROUTE_KM],
        key=lambda row: row["offset_km"],
    )

    route_coordinates = " ".join(
        f"{lon:.10f},{lat:.10f},0" for lon, lat in data["route"]
    )
    km_points = "".join(
        km_placemark(marker, data["totalKm"])
        for marker in data["kmMarkers"]
        if marker["km"] == 0
        or marker["km"] == data["totalKm"]
        or marker["km"] % 10 == 0
    )
    near_points = "".join(
        placemark(row, f"R{index:02d}", "review")
        for index, row in enumerate(near, 1)
    )
    logistics_points = "".join(
        placemark(row, f"L{index:02d}", "logistics")
        for index, row in enumerate(logistics, 1)
    )

    kml = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Rio das Mortes 2026 - Revisão de POIs</name>
  <description>Arquivo derivado para revisão. O KML original permanece intacto.</description>
  <Style id="route"><LineStyle><color>ff4444ff</color><width>4</width></LineStyle></Style>
  <Style id="review"><IconStyle><color>ff00ffff</color><scale>1.1</scale></IconStyle><LabelStyle><scale>0.9</scale></LabelStyle></Style>
  <Style id="logistics"><IconStyle><color>ffff0000</color><scale>0.9</scale></IconStyle><LabelStyle><scale>0.75</scale></LabelStyle></Style>
  <Style id="km"><IconStyle><color>ffffffff</color><scale>0.55</scale></IconStyle><LabelStyle><scale>0.75</scale></LabelStyle></Style>
  <Folder>
    <name>1 - Rota e quilômetros</name>
    <Placemark><name>Rota Vila Berrante - Novo Santo Antônio</name><styleUrl>#route</styleUrl><LineString><tessellate>1</tessellate><coordinates>{route_coordinates}</coordinates></LineString></Placemark>
    {km_points}
  </Folder>
  <Folder>
    <name>2 - REVISAR PRIMEIRO - POIs até 2 km da rota ({len(near)})</name>
    {near_points}
  </Folder>
  <Folder>
    <name>3 - Referências logísticas fora da rota ({len(logistics)})</name>
    {logistics_points}
  </Folder>
</Document>
</kml>
"""
    clean_kml = "\n".join(line.rstrip() for line in kml.splitlines()) + "\n"
    OUTPUT.write_text(clean_kml, encoding="utf-8")
    print(f"Wrote {OUTPUT.name}: {len(near)} near-route, {len(logistics)} logistics")


if __name__ == "__main__":
    main()

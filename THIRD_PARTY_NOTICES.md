# Third-party notices

## Offline satellite imagery

- Provider: Instituto Nacional de Pesquisas Espaciais (INPE)
- Product: CBERS-4A/WPM PCA Fused, RGB 321, 2 m spatial resolution
- Collection: [CB4A-WPM-PCA-FUSED-1](https://data.inpe.br/bdc/stac/v1/collections/CB4A-WPM-PCA-FUSED-1)
- License: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)
- Selected scenes and source URLs: [`data/mortes-2026-imagery.json`](data/mortes-2026-imagery.json)

The offline JPEG tiles in `tiles/` are derived from the pinned INPE scenes. The app displays the attribution “Imagens © INPE/CBERS-4A · CC BY 4.0” on both the map and installation page.

## Google Satellite research comparison

The separate package under `google/` reproduces the satellite-tile method used by the earlier Pindaíba and Carinhanha research apps. It is identified in the interface as “Imagens © Google · uso em pesquisa” and has its own install identity and offline cache.

## Map library

Leaflet is distributed under the BSD 2-Clause License. Its local distribution and license are stored under `vendor/leaflet/`.

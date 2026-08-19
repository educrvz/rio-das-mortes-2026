# Rio das Mortes 2026

Mapa GPS offline (PWA) para a expedição de canoa entre Vila Berrante e Novo Santo Antônio.

## Estado atual

- Projeto iniciado a partir do app Carinhanha 2026.
- Fonte: `data/Mortes-2026.kml`, recebido na pasta `00_WhatsApp_transfer` do Google Drive.
- Rota oficial do KML: LineString detalhada com 84 vértices.
- 93 pontos quilométricos (`000` a `091` e `FIM`) preservados nas coordenadas do KML.
- 20 POIs importados das pastas `Cidades` e `POI` do arquivo-fonte.
- Rota, POIs e interface ainda precisam de validação visual antes da geração do pacote offline.

## Gerar dados

```bash
python3 generate-route-data.py
```

O gerador usa diretamente a LineString `Rio das Mortes (Vila Berrante- NSA)`, valida a ordem e o alinhamento dos pontos quilométricos, e produz `route-data.js`.

## Próximas etapas

1. Validar visualmente a rota e os POIs.
2. Confirmar as referências de emergência sem presumir estoque em tempo real.
3. Gerar e baixar o corredor de tiles com `python3 download-tiles.py`.
4. Atualizar as estimativas de tamanho nas telas do app.
5. Executar testes móveis, offline e de produção.

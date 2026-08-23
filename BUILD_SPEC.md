# Rio das Mortes 2026 — especificação consolidada

## Objetivo

PWA offline para navegação de canoa no trecho Vila Berrante → Novo Santo Antônio, com GPS, progresso por quilômetro, POIs filtráveis, estradas logísticas, notas locais e funcionamento em modo avião.

## Fontes canônicas

- Rota, quilômetros e estradas: `data/Mortes-092026.kml`.
- POIs: planilha Google `mortes 2026`, `Sheet1!D2:J23`.
- Snapshot rastreável dos POIs: `data/mortes-2026-pois.json`.
- Os POIs anteriores do KML e todas as pré-seleções visuais foram descartados.

## Geometria

- Rio: 91,66 km, 84 vértices, sentido Vila Berrante → Novo Santo Antônio.
- Marcos: 000–091 + FIM, validados sobre a LineString.
- Estradas: cinco linhas, 5.390 vértices, aproximadamente 682,6 km.

## POIs oficiais

Total: 55, sem coordenadas duplicadas.

| Categoria | Emoji | Quantidade |
| --- | --- | ---: |
| Praia | 🏖️ | 21 |
| Acesso de carro | 🚗 | 3 |
| Ilha | 🏝️ | 13 |
| Povoado | 🏘️ | 3 |
| Casa | 🏠 | 8 |
| Lago | 💧 | 3 |
| Pista de pouso | 🛩️ | 4 |

Não há ponte na planilha. O botão 🌉 deve permanecer oculto enquanto a fonte oficial não trouxer essa categoria.

Cada POI mantém: identificador estável, categoria, coordenada decimal, coordenada original em DMS, célula-fonte, link para o snapshot público, km aproximado da rota e distância da rota. O identificador e a URL da planilha privada não são publicados.

## Emergência — animais peçonhentos

O botão 🐍 mostra três referências oficiais selecionadas por proximidade real ao rio ou às estradas logísticas:

- Centro de Saúde de Novo Santo Antônio — junto ao final do rio.
- Hospital Municipal Prefeito João Abreu Luz, São Félix do Araguaia — junto à estrada NSA–São Félix.
- Hospital Municipal Cristo Rei, Ribeirão Cascalheira — junto à estrada Ribeirão Cascalheira–Vila Berrante.

Fonte: relação de Mato Grosso do Ministério da Saúde, publicada em 03/07/2026, cruzada com os dados do SoroJá e verificada em 22/08/2026. A listagem não confirma estoque em tempo real; o app orienta ligar antes e acionar SAMU 192 ou Bombeiros 193 em emergência.

## Interface já definida

- Identidade visual própria em carvão, ocre, verde-rio e vermelho de rota; ícone específico da expedição.
- Mapa Leaflet com rota vermelha e estradas laranja tracejadas.
- Botão 🛣️ para mostrar/ocultar estradas.
- POIs ocultos por padrão e filtros por emoji.
- Marcos principais a cada 10 km; modo detalhado mostra todos os quilômetros.
- GPS, recentralização, velocidade, distância percorrida/restante e POI mais próximo.
- Notas locais com criação explícita, edição, remoção e exportação.
- PWA instalável em Android e iPhone.
- Leaflet empacotado localmente, sem dependência da CDN para abrir o app-base offline.

## Cobertura offline

- Corredor do rio até zoom 17.
- Todas as cinco estradas até zoom 17.
- Pacote INPE validado: 34.994 tiles, 199,9 MB.
- Pacote Google de pesquisa: 34.994 tiles, 547,3 MB, com PWA e cache independentes.
- A geometria das estradas acrescenta cerca de 125 KB ao app; o peso relevante vem das imagens.
- Fonte adotada: coleção colorida CBERS-4A/WPM PCA Fused do INPE, 2 m, CC BY 4.0.
- Dezesseis cenas fixadas cobrem o rio e as cinco estradas; o pipeline combina pixels válidos das cenas sobrepostas para eliminar lacunas nas bordas.

## Critérios para a primeira versão testável

1. Os 55 POIs da planilha aparecem na categoria correta e nenhum POI antigo permanece.
2. Rota, marcos e cinco estradas renderizam sem erro.
3. Filtros escondem e restauram cada categoria.
4. GPS e progresso funcionam em viewport móvel.
5. Notas persistem localmente e podem ser exportadas.
6. Cada pacote contém exatamente os 34.994 tiles previstos e exibe a atribuição correspondente.
7. O app passa em teste de modo avião no navegador e no aparelho real.

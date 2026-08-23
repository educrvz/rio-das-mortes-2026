# Rio das Mortes 2026

Guia de campo instalável (PWA) para a expedição de canoa entre Vila Berrante e Novo Santo Antônio.

- Começar pela versão INPE: https://educrvz.github.io/rio-das-mortes-2026/instrucoes.html
- Começar pela versão Google: https://educrvz.github.io/rio-das-mortes-2026/google/instrucoes.html
- Mapa INPE: https://educrvz.github.io/rio-das-mortes-2026/
- Mapa Google: https://educrvz.github.io/rio-das-mortes-2026/google/

## Estado atual

- Interface própria do Rio das Mortes, otimizada para uso no celular durante a expedição.
- Leaflet e todos os recursos do app-base são locais; rota, estradas, POIs, referências de emergência e notas carregam sem internet após a instalação.
- Rota e estradas: `data/Mortes-092026.kml`, recebido da equipe.
- POIs: `data/mortes-2026-pois.json`, transcrição rastreável da planilha Google `mortes 2026` (`Sheet1!D2:J23`).
- Rota oficial do KML: LineString detalhada com 84 vértices.
- 93 pontos quilométricos (`000` a `091` e `FIM`) preservados nas coordenadas do KML.
- 55 POIs oficiais: 21 praias, 3 acessos de carro, 13 ilhas, 3 povoados, 8 casas, 3 lagos e 4 pistas de pouso.
- Os POIs anteriores do KML e as pré-seleções visuais foram removidos; a planilha é a única fonte de POIs.
- Cinco estradas logísticas, 5.390 vértices e aproximadamente 682,6 km.
- Três referências oficiais para acidentes com animais peçonhentos: Novo Santo Antônio, São Félix do Araguaia e Ribeirão Cascalheira.
- Cobertura offline concluída: rio e estradas até zoom 17.
- Versão INPE: 34.994 tiles / 199,9 MB, derivados de cenas coloridas CBERS-4A/WPM de 2 m publicadas pelo INPE sob CC BY 4.0.
- Versão Google de pesquisa: os mesmos 34.994 tiles / 547,3 MB, replicando o método offline usado nos apps Pindaíba e Carinhanha.
- As duas versões têm manifestos, service workers, caches, ícones e anotações locais independentes; podem ser instaladas lado a lado.
- Nas duas versões, a página inicial de instalação não mostra o mapa. Ao iniciar, uma tela dedicada acompanha continuamente as 34.994 imagens e só revela o mapa ao terminar; se o progresso parar, o botão de continuação reaparece após 8 segundos.
- Cenas e URLs de origem fixadas em `data/mortes-2026-imagery.json`; pipeline reproduzível em `build-inpe-tiles.py`.

## Gerar dados

```bash
python3 generate-route-data.py
```

O gerador usa a LineString `Rio das Mortes (Vila Berrante- NSA)`, valida os pontos quilométricos, incorpora as cinco estradas, converte os 55 POIs oficiais e adiciona as três referências de emergência verificadas para `route-data.js`. Cada POI preserva a célula-fonte da planilha e recebe km aproximado da rota.

## Uso local

```bash
python3 -m http.server 8080
```

Abra `http://localhost:8080/instrucoes.html`. O app requer HTTP/HTTPS para registrar o service worker; não abra `index.html` diretamente pelo Finder.

## Validar uma versão de produção

1. Instalar a dependência do validador: `pip install Pillow==12.3.0`.
2. Executar `python3 generate-route-data.py` e confirmar que `route-data.js` não mudou.
3. Executar `python3 validate-release.py`.
4. Executar `node --check app.js`, `node --check sw.js`, `node --check google/sw.js` e `node --check route-data.js`.
5. Executar `node tests/install-first-flow.test.mjs`, `node tests/offline-worker.test.mjs` e `node tests/google-offline-worker.test.mjs`.
6. Instalar e testar no aparelho real com GPS e modo avião antes da viagem.

Para reproduzir o pacote INPE, instale `requirements-imagery.txt` e execute `python3 build-inpe-tiles.py`. O processo retoma tiles ausentes; `--repair-blank` substitui tiles inteiramente sem dados e `--repair-edge` recompõe bordas pretas usando cenas sobrepostas. Para reproduzir a versão Google de pesquisa pelo método histórico, execute `python3 download-google-tiles.py`.

## Imagens e licença

Imagens © Instituto Nacional de Pesquisas Espaciais (INPE), coleção CBERS-4A/WPM PCA Fused, resolução de 2 m. Licença [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). Cenas selecionadas entre agosto de 2025 e agosto de 2026.

Veja também [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

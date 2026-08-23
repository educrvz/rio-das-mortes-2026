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
- Versão Google de pesquisa: os mesmos 34.994 tiles / 547,3 MB, replicando o método offline usado nos apps Pindaíba e Carinhanha. Ela permanece identificada como uso de pesquisa; este repositório não afirma autoridade de licenciamento/armazenamento além dessa identificação.
- As duas versões têm manifestos, service workers, caches, ícones e anotações locais independentes; podem ser instaladas lado a lado.
- Nas duas versões, a página inicial de instalação não mostra o mapa. Ao iniciar, uma tela dedicada acompanha continuamente as 34.994 imagens e só revela o mapa depois da verificação exata do cache.
- Cenas e URLs de origem fixadas em `data/mortes-2026-imagery.json`; pipeline reproduzível em `build-inpe-tiles.py`.

## Recuperação automática do download

- **Política em execução:** cada tile recebe até quatro tentativas automáticas, contando a primeira. Erros de rede, timeout, 408, 429 e 5xx entram na fila persistente; 404/410 recebem no máximo duas tentativas e passam a indicar integridade/publicação, não uma falha comum de rede.
- **Ritmo protegido:** a concorrência começa em 6, varia de 2 a 12, reduz pela metade diante de timeout/429 ou janela com ao menos 10% de falhas recuperáveis, e cresce um passo depois de três janelas limpas. O atraso exponencial tem teto de 30 s, jitter de 80–120% e respeita `Retry-After`.
- **Queda geral de conexão:** duas janelas com pelo menos 75% de falhas de rede/timeout abrem o circuito. O app faz no máximo três sondas, após 5 s, 15 s e 45 s. Voltar ao primeiro plano retoma trabalho já devido; uma transição real de offline para online concede uma única nova rodada automática para a sessão persistida.
- **Espaço restante:** antes de baixar, o app pede persistência de armazenamento quando possível e estima somente os bytes ainda não confirmados no cache; exige 1,25× desse restante livre. Falha de quota/cache bloqueia o fluxo para liberar espaço, sem gastar tentativas de rede.
- **Retomada:** deixe a tela de download aberta enquanto houver trabalho ativo. A cada lote, cursor, fila, tentativas e contagem confirmada são persistidos; reabrir a mesma edição retoma esse estado. A suspensão do navegador pode atrasar a próxima tentativa, mas não perde a fila.
- **Quando aparece ação manual:** o botão não aparece durante recuperação automática. Ele aparece uma vez quando as tentativas automáticas se esgotaram ou quando há ação possível para liberar armazenamento. Erro de integridade/publicação mantém o mapa bloqueado até uma atualização publicada.
- **Prontidão real:** 100% visual não basta. O mapa só aparece após confirmar que as 34.994 URLs do manifesto estão no cache atual; um tile removido/evicto volta para reparo antes de criar o marcador de pronto.

### Baseline, meta e alternativa de empacotamento

- Baseline atual: o usuário relatou tentativas manuais repetidas para concluir o download em conexão imperfeita.
- Meta de produção: zero cliques manuais para falhas transitórias dispersas e uma desconexão temporária; no máximo uma tentativa explícita apenas depois de esgotamento automático ou de um estado de armazenamento acionável.
- Reavaliar arquivos agregados/PMTiles somente se qualquer edição ainda exigir mais de uma recuperação manual em dois testes físicos controlados consecutivos, ou não concluir depois de uma desconexão temporária no teste de aceitação abaixo.

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
4. Executar `node --check app.js`, `node --check sw.js`, `node --check google/sw.js`, `node --check offline-recovery-engine.js` e `node --check route-data.js`.
5. Executar `node tests/install-first-flow.test.mjs`, `node tests/offline-worker.test.mjs`, `node tests/google-offline-worker.test.mjs` e `node tests/offline-recovery-policy.test.mjs`.
6. Completar a aceitação física descrita abaixo antes da viagem.

Para reproduzir o pacote INPE, instale `requirements-imagery.txt` e execute `python3 build-inpe-tiles.py`. O processo retoma tiles ausentes; `--repair-blank` substitui tiles inteiramente sem dados e `--repair-edge` recompõe bordas pretas usando cenas sobrepostas. Para reproduzir a versão Google de pesquisa pelo método histórico, execute `python3 download-google-tiles.py`.

## Aceitação física antes da viagem

Execute a sequência para **cada edição**, registrando a contagem de cliques manuais e o resultado:

1. Em Wi-Fi estável, iniciar a instalação sem mapa e confirmar que o contador avança até 34.994 imagens sem revelar o mapa cedo.
2. Injetar falhas transitórias dispersas e uma desconexão temporária; confirmar recuperação automática sem clique manual.
3. Durante o download, deixar o app em segundo plano, bloquear a tela e encerrar o processo quando o sistema permitir; reabrir e confirmar retomada pela contagem persistida, sem recarregar tiles já confirmados.
4. Em Android, repetir no Chrome e no Brave instalados. Em iPhone, repetir no Safari e no app adicionado à Tela de Início, sem presumir Background Sync.
5. Somente após pronto, ativar modo avião e confirmar imagens, rota, estradas, POIs, notas, emergência e GPS disponível pelo aparelho.

## Imagens e licença

Imagens © Instituto Nacional de Pesquisas Espaciais (INPE), coleção CBERS-4A/WPM PCA Fused, resolução de 2 m. Licença [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). Cenas selecionadas entre agosto de 2025 e agosto de 2026.

Veja também [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

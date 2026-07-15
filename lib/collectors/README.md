# Coletores

Um coletor **nunca opera** — só busca dado de uma fonte externa, grava no
Market Database único (`data/market.db`, `lib/infra/db.js`) e emite um
evento (`lib/infra/eventBus.js`). Nenhum outro módulo (Signal Engine, Risk
Engine, etc.) deve chamar uma API externa diretamente — todos leem do banco.

## Padrão de um coletor

Cada função de coleta de domínio segue a mesma forma:

```js
async function collectX(db, eventBus, client, opts) {
  const data = await client.getX(...);        // busca na fonte externa
  if (!data) return { inserted: false };

  const inserted = insertIfNew(db, sql, params); // INSERT OR IGNORE + changes>0
  if (inserted) eventBus.emit("x.updated", { uuid, ... });
  return { inserted };
}
```

- `db`, `eventBus` e o cliente da fonte (`client`) são sempre **injetados**,
  nunca importados direto dentro da função de coleta — é isso que permite
  testar com um cliente falso e um banco temporário, sem rede real.
- Idempotência vem do schema, não do código: toda tabela com chave natural
  (timestamp que a própria fonte fornece — `open_time`, `funding_time`,
  `snapshot_time` do long/short) tem `UNIQUE INDEX` na migração, e o
  `INSERT OR IGNORE` descarta repetição sozinho. Domínios sem chave natural
  (ex: `tickers_snapshot`, que a Bybit não devolve com timestamp por
  símbolo) não têm índice único — cada coleta é uma observação nova
  legítima, não uma duplicata.
- Evento tem payload mínimo (uuid + poucos campos de referência) — quem
  consome relê do banco pelo uuid/timestamp, o banco continua sendo a única
  fonte de verdade.

## Métricas (`lib/collectors/collectorMetrics.js`)

Genérico, não específico da Bybit — qualquer coletor novo usa o mesmo
`createCollectorMetrics()`. Por domínio, acumula `totalRuns`,
`totalInserted` (dado novo) vs `totalSkipped` (duplicata descartada),
`totalErrors`, `consecutiveFailures`, `lastRunAt`/`lastSuccessAt`,
`lastLatencyMs`, `lastError`. É a base pro Data Quality Score por fonte
(Source Reliability Engine, ainda não implementado) e pro health check.

## Monitoramento de integridade

Cada processo de coleta escreve um heartbeat em disco (`data/*-health.json`)
com timestamp + snapshot das métricas — é a única forma de `npm run health`
(processo curto, à parte) saber se o coletor (processo longo, à parte) está
vivo e coletando de verdade, não só rodando. `lib/healthChecks.js` lê esse
arquivo: heartbeat velho (>5min) = `down`; algum domínio com 3+ falhas
consecutivas = `degraded` mesmo com heartbeat fresco (processo vivo mas
falhando contra a fonte); senão `ok`. Ver `checkCollector` (Bybit) e
`checkTelegramRadar` (Telegram) como referência pro próximo coletor.

## Retries

Toda chamada de rede passa por `lib/httpRetry.js` (backoff exponencial em
erro de rede/HTTP 429/5xx, falha imediata em erro de negócio/autenticação)
— já embutido em `lib/bybit.js`, herdado automaticamente por qualquer
coletor que use esse cliente. Um cliente novo (Binance, CoinGecko, etc.)
deve envolver suas chamadas em `withRetry` do mesmo jeito.

## Bybit Collector (`bybitCollector.js`) — v1, REST

Cobertura atual: `candles` (kline), `funding` (funding/history),
`open_interest`, `tickers_snapshot` (preço/mark/index/spread/funding/OI num
call só), `long_short_ratio` (account-ratio). Cada um com seu próprio
intervalo de polling (`runCollector(db, eventBus, client, config,
intervals)`).

**Deliberadamente fora do v1** (ver roadmap do projeto — Fase 0.4, Bybit
Streaming Collector):
- **Liquidações**: a Bybit não expõe histórico via REST (`/v5/market/liquidation`
  retorna 404) — só existe como stream WebSocket (`allLiquidation.{symbol}`),
  sem backfill histórico. Precisa de conexão persistente + reconexão, um
  padrão bem diferente do polling REST usado aqui.
- **Order book** e **trades públicos (tick a tick)**: tecnicamente têm
  endpoint REST, mas fazem mais sentido como stream (alto volume, dado que
  perde valor rápido) — mesma fase de streaming das liquidações.

## Fear & Greed Collector (`fearGreedCollector.js`) — v1

Fonte pública sem chave (`alternative.me/fng/`), atualiza ~1x/dia. Único
domínio (`fear_greed`), polling de hora em hora (`INSERT OR IGNORE`
descarta o resto). Timestamp da API vem em **segundos**, convertido pra ms
na gravação — todo o resto do banco usa ms epoch, atenção nisso ao integrar
fontes novas. `checkFearGreed` reusa a mesma função genérica de heartbeat
que `checkCollector` (`checkCollectorHeartbeat` em `lib/healthChecks.js`) —
só muda o path do arquivo.

Roda como processo próprio (`scripts/fearGreedCollector.js`, `npm run
collect:fear-greed`) em vez de entrar no processo do Bybit Collector — fonte
única e barata não justifica acoplar ao ciclo de vida de outro coletor.

## BTC Dominance Collector (`btcDominanceCollector.js`) — v1

Fonte pública sem chave (CoinGecko `/api/v3/global`). O `updated_at` da
resposta fica estável por alguns minutos (cache interno deles, confirmado
testando duas chamadas seguidas) — por isso `snapshot_time` funciona como
chave natural de idempotência (`UNIQUE INDEX`), igual funding/OI/Fear&Greed,
diferente do `tickers_snapshot` da Bybit (que não tem timestamp por
símbolo). Polling de 15min é suficiente (`INSERT OR IGNORE` descarta o
resto enquanto o cache deles não vira). Também grava `eth_dominance_pct`,
market cap e volume totais de brinde, já que vêm no mesmo call.

## Como adicionar um coletor novo

1. Migração nova em `lib/infra/migrations/000N_*.sql` (só as tabelas que
   esse coletor usa — nada especulativo).
2. `lib/collectors/xCollector.js` seguindo o padrão acima, usando
   `createCollectorMetrics()`.
3. `lib/xClient.js` (se a fonte for nova) envolvendo toda chamada em
   `withRetry` (`lib/httpRetry.js`).
4. `checkX` em `lib/healthChecks.js` lendo o heartbeat do processo.
5. Testes: funções puras de coleta com cliente falso + banco temporário
   (ver `test/collectors/bybitCollector.test.js`), métricas (reusa
   `test/collectors/collectorMetrics.test.js` como referência).
6. Script standalone `scripts/xCollector.js` (ou adicionar ao coletor
   existente, se fizer sentido rodar no mesmo processo) + `npm run` script.

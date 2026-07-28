# Hummingbot

`github.com/hummingbot/hummingbot` -- bot de trading/market-making de
cripto em Python+Cython, ~48 conectores CEX nativos (sem ccxt), DEX via
processo TypeScript separado (Gateway, HTTPS+mTLS).

## Auditoria completa

- [Auditoria: Hummingbot vs. cripto10](../../) -- Controllers/Executors,
  Avellaneda-Stoikov, conectores. (artifact publicado em 2026-07-27)

## O que ficou provado ao ler o código

- **V2 (Controllers + Executors)**: Controller decide (produz
  `ExecutorAction`), Executor executa como state machine autônoma por
  posição (triple-barrier: stop-loss/take-profit/trailing-stop/time-limit,
  `CloseType` tipado no fechamento). Padrão mais elegante da série pra
  gestão de posição, mas resolve concorrência entre múltiplas posições --
  problema que o cripto10 não tem hoje (1 posição por vez).
- **Backtest V2**: Controller (decisão) é literalmente reusado; Executor
  (execução) é trocado por um simulador vetorizado separado -- reuso
  parcial, não total.
- **Order tracking dual-canal**: websocket primário + polling REST
  adaptativo (acelera quando desconfia que o websocket parou) +
  rastreamento de "lost order". Não confirmado se o cripto10 já tem
  robustez equivalente -- sinalizado pra verificação, não classificado às
  cegas.
- **Protections**: 3º voto pro padrão de Guard Pipeline.
- **RateOracle + suíte de conformidade de conectores**: referência pra
  quando o cripto10 diversificar de bolsa.
- **Avellaneda-Stoikov real** (market making dois lados) -- não se aplica
  ao cripto10 (trading direcional, posição única).

## Ideias extraídas -- Research Objects no Feature Registry

| Registry id | Ideia | Prioridade |
|---|---|---|
| `idea-executor-state-machine` | State machine autônoma por posição | ★★★☆☆ (guardar) |
| `idea-order-reconciliation-audit` | Verificar reconciliação de ordens atual antes de classificar | ★★★☆☆ (verificar) |
| `idea-risk-guard-pipeline` | 3º de 4 origens (Protections) | ★★★★☆ |
| `idea-multi-exchange-plugin-pattern` | 3º de 4 origens (RateOracle + conformance tests) | ★★☆☆☆ |

## O que NÃO vale importar

Avellaneda-Stoikov/market making dois lados (problema de estratégia
diferente); Gateway TypeScript pra DEX/AMM (sem ambição de DEX hoje).

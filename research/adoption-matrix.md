# Adoption Matrix

_Gerado automaticamente por `npm run adoption-matrix` em 2026-07-28T02:27:49.987Z a partir de `registry/research-objects.json` (45 Research Objects). Não editar este arquivo à mão._

Ideias extraídas das auditorias de concorrentes (OpenAlice/Freqtrade/Hummingbot/Lean/Jesse), agrupadas por prioridade. Ver `research/competitor-intelligence/` para o contexto completo de cada origem, e `npm run registry -- show <id>` para o Research Object inteiro (referências, dependências, histórico).

## Prioridade Alta

| id | nome | origem | status | depende de |
|---|---|---|---|---|
| `idea-hypothesis-ledger` | Hypothesis Ledger (Trading-as-Git) | OpenAlice | backlog | `engine-replay`, `engine-brain-analytics` |
| `idea-monte-carlo-mode` | Monte Carlo Mode (perturbação de candles) | Jesse | backlog | `engine-replay` |
| `idea-optimizer-overfit-clustering` | Diagnóstico de overfitting via clustering do grid de parâmetros | Lean/QuantConnect | backlog | `engine-backtest` |
| `idea-risk-guard-pipeline` | Guard Pipeline (risk veto plugável) | openalice, freqtrade, hummingbot, lean | backlog | -- |
| `idea-significance-testing` | Significance Testing (bootstrap p-value de regra de entrada) | Jesse | backlog | `engine-replay` |

## Prioridade Média

| id | nome | origem | status | depende de |
|---|---|---|---|---|
| `idea-order-reconciliation-audit` | Auditoria da reconciliação de ordens (verificar antes de classificar) | Hummingbot | backlog | -- |
| `idea-output-truncation-transparency` | Transparência de truncamento em outputs ("omitted: N") | OpenAlice | backlog | -- |

## Prioridade Baixa

| id | nome | origem | status | depende de |
|---|---|---|---|---|
| `idea-executor-state-machine` | Executor (state machine autônoma por posição) | Hummingbot | backlog | -- |
| `idea-multi-exchange-plugin-pattern` | Padrão de plugin pra multi-exchange (Broker Packs / conector template) | openalice, freqtrade, hummingbot, lean | backlog | -- |

## Descartado

| id | nome | origem | motivo |
|---|---|---|---|
| `idea-kelly-edge-sizing` | Kelly Criterion / Edge Positioning (sizing por expectância) | openalice, freqtrade, jesse | Position sizing baseado em Kelly Criterion/expectância histórica (edge). Descartado deliberadamente: 3 confirmações independentes de que essa ambição não vingou nem em projetos maduros -- OpenAlice removeu o módulo Edge, Freqtrade removeu o módulo Edge (deprecado 2023.9, removido 2025.6), Jesse só tem helpers opcionais (risk_to_qty/kelly_criterion em jesse.utils) nunca invocados automaticamente pelo framework. Registrado aqui pra não ser re-proposto sem essa memória. |

## Componentes validados por auditoria externa

Componentes do próprio cripto10 que alguma auditoria confirmou como iguais/melhores que o equivalente externo (`validated-by:*` nas tags).

| id | nome | validado por |
|---|---|---|
| `brain-market` | Market Brain | openalice |
| `engine-backtest` | Auto-tuning / Backtest Engine | freqtrade |
| `engine-replay` | Replay Engine | freqtrade, hummingbot, lean, jesse |
| `synthesis-context-fusion` | Context Fusion | openalice |


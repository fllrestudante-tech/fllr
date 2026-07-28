# Adoption Matrix

_Gerado automaticamente por `npm run adoption-matrix` em 2026-07-28T20:32:31.783Z a partir de `registry/research-objects.json` (85 Research Objects). Não editar este arquivo à mão._

Ideias extraídas das auditorias de concorrentes (OpenAlice/Freqtrade/Hummingbot/Lean/Jesse), agrupadas por prioridade. Ver `research/competitor-intelligence/` para o contexto completo de cada origem, e `npm run registry -- show <id>` para o Research Object inteiro (referências, dependências, histórico).

## Mapa de Capacidades

O que o sistema sabe fazer, não só quais componentes existem. Cada capability é um `type: "capability"` no Registry -- `dependsOn` lista quem implementa.

| capability | status | implementado por |
|---|---|---|
| **Auto-tuning** | production | `engine-backtest` (production) |
| **Context Synthesis** | production | `synthesis-context-fusion` (production) |
| **Liquidity & Smart Money** | production | `brain-liquidity` (production), `brain-fvg` (production), `brain-order-block` (production), `synthesis-institutional-context` (production) |
| **Market Classification** | production | `brain-market` (production), `brain-structure` (production), `brain-liquidity` (production) |
| **Opportunity Discovery** | idea | `idea-opportunity-alice` (idea) |
| **Research & Validation** | production | `engine-replay` (production), `engine-brain-analytics` (production), `experiment-fvg-accuracy` (validated), `experiment-fvg-redundancy` (research), `experiment-structure-liquidity-combo` (research), `experiment-structure-liquidity-fvg-combo` (research) |

## Ideias extraídas de auditorias de concorrentes

### Prioridade Alta

| id | nome | origem | status | depende de |
|---|---|---|---|---|
| `idea-hypothesis-ledger` | Hypothesis Ledger (Trading-as-Git) | OpenAlice | backlog | `engine-replay`, `engine-brain-analytics`, `idea-significance-testing`, `idea-monte-carlo-mode` |
| `idea-monte-carlo-mode` | Monte Carlo Mode (perturbação de candles) | Jesse | backlog | `engine-replay` |
| `idea-optimizer-overfit-clustering` | Diagnóstico de overfitting via clustering do grid de parâmetros | Lean/QuantConnect | backlog | `engine-backtest` |
| `idea-risk-guard-pipeline` | Guard Pipeline (risk veto plugável) | openalice, freqtrade, hummingbot, lean | backlog | -- |
| `idea-significance-testing` | Significance Testing (bootstrap p-value de regra de entrada) | Jesse | backlog | `engine-replay` |

### Prioridade Média

| id | nome | origem | status | depende de |
|---|---|---|---|---|
| `idea-order-reconciliation-audit` | Auditoria da reconciliação de ordens (verificar antes de classificar) | Hummingbot | backlog | -- |
| `idea-output-truncation-transparency` | Transparência de truncamento em outputs ("omitted: N") | OpenAlice | backlog | -- |

### Prioridade Baixa

| id | nome | origem | status | depende de |
|---|---|---|---|---|
| `idea-executor-state-machine` | Executor (state machine autônoma por posição) | Hummingbot | backlog | -- |
| `idea-multi-exchange-plugin-pattern` | Padrão de plugin pra multi-exchange (Broker Packs / conector template) | openalice, freqtrade, hummingbot, lean | backlog | -- |

## Blueprint de pesquisa contínua (Fase 4 -- síntese própria, não de auditoria)

| id | nome | status | prioridade | depende de |
|---|---|---|---|---|
| `idea-asset-profile` | Market Knowledge Base (Asset) | research | Alta | `idea-dynamic-universe` |
| `idea-capital-flow-engine` | Capital Flow Engine | idea | Alta | `idea-dynamic-universe` |
| `idea-causal-event-log` | Causal Event Log (Replay causal) | idea | Média | `engine-replay`, `idea-market-memory` |
| `idea-confidence-engine` | Confidence Engine (generalizado) | idea | Média | `synthesis-context-fusion` |
| `idea-correlation-brain` | Correlation Brain | idea | Alta | `brain-market` |
| `idea-cost-engine` | Cost Engine | idea | Baixa | -- |
| `idea-dynamic-universe` | Dynamic Universe | idea | Alta | -- |
| `idea-evolution-engine` | Evolution Engine | idea | Baixa | `engine-brain-analytics`, `engine-replay` |
| `idea-feature-builder` | Feature Builder | idea | Alta | -- |
| `idea-hypothesis-builder` | Hypothesis Builder | idea | Baixa | `idea-hypothesis-ledger`, `idea-asset-profile` |
| `idea-knowledge-graph` | Knowledge Graph | idea | Média | -- |
| `idea-market-memory` | Market Memory | idea | Média | `engine-replay` |
| `idea-meta-analytics` | Meta Analytics | idea | Baixa | `engine-brain-analytics`, `engine-replay`, `idea-regime-engine` |
| `idea-metric-models` | Metric Models (FundingModel/OIModel/SpreadModel/ATRModel/VolumeModel) | idea | Baixa | `idea-asset-profile` |
| `idea-multi-timeframe-brain` | Multi-Timeframe Brain | idea | Média | `brain-structure`, `brain-liquidity`, `brain-fvg`, `brain-order-block` |
| `idea-opportunity-alice` | Opportunity Engine (Opportunity Alice) | idea | Alta | `idea-dynamic-universe`, `idea-feature-builder` |
| `idea-portfolio-intelligence` | Portfolio Intelligence | idea | Baixa | `idea-executor-state-machine` |
| `idea-regime-engine` | Regime Engine | idea | Alta | `brain-market`, `brain-structure`, `brain-liquidity`, `synthesis-context-fusion` |
| `idea-replay-attribution` | Feature Attribution no Replay | idea | Média | `engine-replay`, `engine-brain-analytics` |
| `idea-statistical-narrative` | Statistical Narrative | idea | Baixa | `idea-asset-profile` |
| `idea-weight-engine` | Weight Engine | idea | Média | `engine-brain-analytics`, `engine-replay`, `synthesis-context-fusion` |

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


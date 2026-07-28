# Cripto10 — Capability Map

_Gerado automaticamente por `npm run capability-map` em 2026-07-28T23:35:39.119Z a partir de `registry/research-objects.json` (106 Research Objects, 56 mapeados). Não editar este arquivo à mão._

## Objetivo

Este documento é o mapa vivo de capacidades do cripto10. Não é um roadmap, não é um backlog, não é documentação técnica -- responde só uma pergunta: **"o que o sistema é capaz de fazer?"**. Cada capability aponta pro seu Research Object correspondente, estado de maturidade, consumidores reais e dependências -- tudo derivado do Feature Registry, nada duplicado.

## 1. Knowledge Domain

### Knowledge Services

#### 🚀 Context Builder

| Campo | Valor |
|---|---|
| Research Object | `capability-context-builder` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🟠 Core |
| Proof | Production |
| Status | production |
| Maturity | 3 |
| Depends On | `capability-knowledge-resolver` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ✅ |

#### 🚀 Knowledge Resolver

| Campo | Valor |
|---|---|
| Research Object | `capability-knowledge-resolver` |
| Capability Stage | 🚀 Production |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🟠 Core |
| Proof | Production |
| Status | production |
| Maturity | 3 |
| Depends On | `idea-asset-profile` |
| Consumer | `capability-context-builder` |
| Replay Validated | ❌ |
| Production | ✅ |

#### 🧪 Signal Registry

| Campo | Valor |
|---|---|
| Research Object | `capability-signal-registry` |
| Capability Stage | 🧪 Prototype |
| Nature | ⚙️ Operational (executa) |
| Criticality | ⚪ Optional |
| Proof | Reasoning |
| Status | research |
| Maturity | 1 |
| Depends On | -- |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

#### 🧪 Statistical Resolver

| Campo | Valor |
|---|---|
| Research Object | `capability-statistical-resolver` |
| Capability Stage | 🧪 Prototype |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🟡 Supporting |
| Proof | Reasoning |
| Status | research |
| Maturity | 1 |
| Depends On | `idea-asset-profile` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

### Asset Knowledge

#### 🧪 Market Knowledge Base (Asset)

| Campo | Valor |
|---|---|
| Research Object | `idea-asset-profile` |
| Capability Stage | 🧪 Prototype |
| Nature | 📖 Knowledge (sabe) |
| Criticality | 🔵 Experimental |
| Proof | Benchmark |
| Status | research |
| Maturity | 1 |
| Depends On | `idea-dynamic-universe` |
| Consumer | `capability-knowledge-resolver`, `capability-statistical-resolver`, `idea-hypothesis-builder`, `idea-metric-models`, `idea-statistical-narrative` |
| Replay Validated | ❌ |
| Production | ❌ |

#### 💡 Causal Event Log (Replay causal)

| Campo | Valor |
|---|---|
| Research Object | `idea-causal-event-log` |
| Capability Stage | 💡 Idea |
| Nature | 📖 Knowledge (sabe) |
| Criticality | ⚪ Optional |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `engine-replay`, `idea-market-memory` |
| Consumer | `pattern-no-true-event-sourcing` |
| Replay Validated | ❌ |
| Production | ❌ |

#### 💡 Confidence Engine (generalizado)

| Campo | Valor |
|---|---|
| Research Object | `idea-confidence-engine` |
| Capability Stage | 💡 Idea |
| Nature | 📖 Knowledge (sabe) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `synthesis-context-fusion` |
| Consumer | `pattern-trust-verification` |
| Replay Validated | ❌ |
| Production | ❌ |

#### 💡 Knowledge Graph

| Campo | Valor |
|---|---|
| Research Object | `idea-knowledge-graph` |
| Capability Stage | 💡 Idea |
| Nature | 📖 Knowledge (sabe) |
| Criticality | ⚪ Optional |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | -- |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

#### 💡 Market Memory

| Campo | Valor |
|---|---|
| Research Object | `idea-market-memory` |
| Capability Stage | 💡 Idea |
| Nature | 📖 Knowledge (sabe) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `engine-replay` |
| Consumer | `idea-causal-event-log`, `pattern-no-embeddings-semantic-memory` |
| Replay Validated | ❌ |
| Production | ❌ |

#### 💡 Metric Models (FundingModel/OIModel/SpreadModel/ATRModel/VolumeModel)

| Campo | Valor |
|---|---|
| Research Object | `idea-metric-models` |
| Capability Stage | 💡 Idea |
| Nature | 📖 Knowledge (sabe) |
| Criticality | ⚪ Optional |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `idea-asset-profile` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

#### 💡 Statistical Narrative

| Campo | Valor |
|---|---|
| Research Object | `idea-statistical-narrative` |
| Capability Stage | 💡 Idea |
| Nature | 📖 Knowledge (sabe) |
| Criticality | ⚪ Optional |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `idea-asset-profile` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

## 2. Analysis Domain

### Market Analysis

#### 🚀 FVG Brain

| Campo | Valor |
|---|---|
| Research Object | `brain-fvg` |
| Capability Stage | 🚀 Production |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🟠 Core |
| Proof | Replay |
| Status | production |
| Maturity | 2 |
| Depends On | `feature-fair-value-gap`, `brain-structure`, `brain-liquidity`, `synthesis-context-fusion` |
| Consumer | `capability-liquidity-smart-money`, `engine-decision-brain`, `engine-replay`, `experiment-fvg-accuracy`, `experiment-fvg-redundancy`, `experiment-structure-liquidity-fvg-combo`, `idea-multi-timeframe-brain`, `synthesis-institutional-context` |
| Replay Validated | ✅ |
| Production | ✅ |

#### 🚀 Liquidity Brain

| Campo | Valor |
|---|---|
| Research Object | `brain-liquidity` |
| Capability Stage | 🚀 Production |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🟠 Core |
| Proof | Replay |
| Status | production |
| Maturity | 2 |
| Depends On | `feature-equal-highs-lows`, `feature-liquidity-sweep` |
| Consumer | `brain-fvg`, `brain-order-block`, `capability-liquidity-smart-money`, `capability-market-classification`, `engine-decision-brain`, `engine-replay`, `experiment-fvg-redundancy`, `experiment-structure-liquidity-combo`, `experiment-structure-liquidity-fvg-combo`, `idea-multi-timeframe-brain`, `idea-regime-engine`, `synthesis-context-fusion`, `synthesis-institutional-context` |
| Replay Validated | ✅ |
| Production | ✅ |

#### 🚀 Market Brain

| Campo | Valor |
|---|---|
| Research Object | `brain-market` |
| Capability Stage | 🚀 Production |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🟠 Core |
| Proof | Replay |
| Status | production |
| Maturity | 2 |
| Depends On | -- |
| Consumer | `capability-market-classification`, `engine-decision-brain`, `engine-replay`, `idea-correlation-brain`, `idea-regime-engine`, `synthesis-context-fusion` |
| Replay Validated | ✅ |
| Production | ✅ |

#### 🚀 Order Block Brain

| Campo | Valor |
|---|---|
| Research Object | `brain-order-block` |
| Capability Stage | 🚀 Production |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🟠 Core |
| Proof | Replay |
| Status | production |
| Maturity | 2 |
| Depends On | `feature-order-block-detection`, `brain-structure`, `brain-liquidity`, `synthesis-context-fusion` |
| Consumer | `capability-liquidity-smart-money`, `engine-decision-brain`, `engine-replay`, `experiment-fvg-redundancy`, `idea-multi-timeframe-brain`, `synthesis-institutional-context` |
| Replay Validated | ✅ |
| Production | ✅ |

#### 🚀 Structure Brain

| Campo | Valor |
|---|---|
| Research Object | `brain-structure` |
| Capability Stage | 🚀 Production |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🟠 Core |
| Proof | Replay |
| Status | production |
| Maturity | 2 |
| Depends On | `feature-bos`, `feature-choch` |
| Consumer | `brain-fvg`, `brain-order-block`, `capability-market-classification`, `engine-decision-brain`, `engine-replay`, `experiment-structure-liquidity-combo`, `experiment-structure-liquidity-fvg-combo`, `idea-multi-timeframe-brain`, `idea-regime-engine`, `synthesis-context-fusion` |
| Replay Validated | ✅ |
| Production | ✅ |

#### 💡 Capital Flow Engine

| Campo | Valor |
|---|---|
| Research Object | `idea-capital-flow-engine` |
| Capability Stage | 💡 Idea |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `idea-dynamic-universe` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

#### 💡 Correlation Brain

| Campo | Valor |
|---|---|
| Research Object | `idea-correlation-brain` |
| Capability Stage | 💡 Idea |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `brain-market` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

#### 💡 Multi-Timeframe Brain

| Campo | Valor |
|---|---|
| Research Object | `idea-multi-timeframe-brain` |
| Capability Stage | 💡 Idea |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `brain-structure`, `brain-liquidity`, `brain-fvg`, `brain-order-block` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

### Context

#### 💡 Feature Builder

| Campo | Valor |
|---|---|
| Research Object | `idea-feature-builder` |
| Capability Stage | 💡 Idea |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | -- |
| Consumer | `idea-opportunity-alice` |
| Replay Validated | ❌ |
| Production | ❌ |

#### 💡 Regime Engine

| Campo | Valor |
|---|---|
| Research Object | `idea-regime-engine` |
| Capability Stage | 💡 Idea |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `brain-market`, `brain-structure`, `brain-liquidity`, `synthesis-context-fusion` |
| Consumer | `idea-meta-analytics` |
| Replay Validated | ❌ |
| Production | ❌ |

#### 💡 Structured Evidence (Evidence como objeto de 1ª classe)

| Campo | Valor |
|---|---|
| Research Object | `idea-structured-evidence` |
| Capability Stage | 💡 Idea |
| Nature | 📖 Knowledge (sabe) |
| Criticality | ⚪ Optional |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `idea-weight-engine`, `idea-replay-attribution` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

#### 🚀 Context Fusion

| Campo | Valor |
|---|---|
| Research Object | `synthesis-context-fusion` |
| Capability Stage | 🚀 Production |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🟠 Core |
| Proof | Replay |
| Status | production |
| Maturity | 2 |
| Depends On | `brain-market`, `brain-structure`, `brain-liquidity` |
| Consumer | `brain-fvg`, `brain-order-block`, `capability-context-synthesis`, `engine-decision-brain`, `engine-replay`, `idea-confidence-engine`, `idea-regime-engine`, `idea-weight-engine` |
| Replay Validated | ✅ |
| Production | ✅ |

#### 🚀 Institutional Context

| Campo | Valor |
|---|---|
| Research Object | `synthesis-institutional-context` |
| Capability Stage | 🚀 Production |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🟠 Core |
| Proof | Replay |
| Status | production |
| Maturity | 2 |
| Depends On | `brain-liquidity`, `brain-fvg`, `brain-order-block` |
| Consumer | `capability-liquidity-smart-money`, `engine-decision-brain`, `engine-replay` |
| Replay Validated | ✅ |
| Production | ✅ |

## 3. Discovery Domain

### Opportunity Discovery

#### 💡 Opportunity Discovery

| Campo | Valor |
|---|---|
| Research Object | `capability-opportunity-discovery` |
| Capability Stage | 💡 Idea |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | ⚪ Optional |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `idea-opportunity-alice` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

#### 💡 Opportunity Engine (Opportunity Alice)

| Campo | Valor |
|---|---|
| Research Object | `idea-opportunity-alice` |
| Capability Stage | 💡 Idea |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `idea-dynamic-universe`, `idea-feature-builder` |
| Consumer | `capability-opportunity-discovery` |
| Replay Validated | ❌ |
| Production | ❌ |

### Opportunity Tracking

#### 🧪 Telegram Radar

| Campo | Valor |
|---|---|
| Research Object | `engine-telegram-radar` |
| Capability Stage | 🧪 Prototype |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🟡 Supporting |
| Proof | Production |
| Status | research |
| Maturity | 1 |
| Depends On | -- |
| Consumer | `engine-narrative` |
| Replay Validated | ❌ |
| Production | ❌ |

### Universe Discovery

#### 💡 Dynamic Universe

| Campo | Valor |
|---|---|
| Research Object | `idea-dynamic-universe` |
| Capability Stage | 💡 Idea |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | -- |
| Consumer | `idea-asset-profile`, `idea-capital-flow-engine`, `idea-opportunity-alice` |
| Replay Validated | ❌ |
| Production | ❌ |

## 4. Execution Domain

### Trading

#### 🚀 Order Execution

| Campo | Valor |
|---|---|
| Research Object | `capability-order-execution` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🔴 Mission Critical |
| Proof | Production |
| Status | production |
| Maturity | 4 |
| Depends On | `capability-risk-management` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ✅ |

#### 🚀 Risk Management

| Campo | Valor |
|---|---|
| Research Object | `capability-risk-management` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🔴 Mission Critical |
| Proof | Production |
| Status | production |
| Maturity | 4 |
| Depends On | -- |
| Consumer | `capability-order-execution` |
| Replay Validated | ❌ |
| Production | ✅ |

#### 💡 Portfolio Intelligence

| Campo | Valor |
|---|---|
| Research Object | `idea-portfolio-intelligence` |
| Capability Stage | 💡 Idea |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | ⚪ Optional |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `idea-executor-state-machine` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

### Validation

#### 🚀 Replay Engine

| Campo | Valor |
|---|---|
| Research Object | `engine-replay` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🟠 Core |
| Proof | Production |
| Status | production |
| Maturity | 2 |
| Depends On | `brain-market`, `brain-structure`, `brain-liquidity`, `synthesis-context-fusion`, `brain-fvg`, `brain-order-block`, `synthesis-institutional-context` |
| Consumer | `capability-experiments-engine`, `capability-research-validation`, `engine-brain-analytics`, `engine-decision-brain`, `idea-causal-event-log`, `idea-evolution-engine`, `idea-hypothesis-ledger`, `idea-market-memory`, `idea-meta-analytics`, `idea-monte-carlo-mode`, `idea-replay-attribution`, `idea-significance-testing`, `idea-weight-engine`, `pattern-no-true-event-sourcing` |
| Replay Validated | ❌ |
| Production | ✅ |

#### 💡 Feature Attribution no Replay

| Campo | Valor |
|---|---|
| Research Object | `idea-replay-attribution` |
| Capability Stage | 💡 Idea |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `engine-replay`, `engine-brain-analytics` |
| Consumer | `idea-structured-evidence` |
| Replay Validated | ❌ |
| Production | ❌ |

## 5. Research Domain

### Intelligence

#### 🚀 Adoption Matrix

| Campo | Valor |
|---|---|
| Research Object | `capability-adoption-matrix` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🟡 Supporting |
| Proof | Production |
| Status | production |
| Maturity | 3 |
| Depends On | `capability-feature-registry` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ✅ |

#### 🚀 Capability Map

| Campo | Valor |
|---|---|
| Research Object | `capability-capability-map` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🟡 Supporting |
| Proof | Production |
| Status | production |
| Maturity | 2 |
| Depends On | `capability-feature-registry` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ✅ |

#### 🚀 Competitor Intelligence

| Campo | Valor |
|---|---|
| Research Object | `capability-competitor-intelligence` |
| Capability Stage | 🚀 Production |
| Nature | 📖 Knowledge (sabe) |
| Criticality | 🟡 Supporting |
| Proof | Production |
| Status | production |
| Maturity | 3 |
| Depends On | -- |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ✅ |

#### 🚀 DNA Matrix

| Campo | Valor |
|---|---|
| Research Object | `capability-dna-matrix` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🟡 Supporting |
| Proof | Production |
| Status | production |
| Maturity | 3 |
| Depends On | `capability-feature-registry` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ✅ |

#### 🚀 Engineering Patterns

| Campo | Valor |
|---|---|
| Research Object | `capability-engineering-patterns` |
| Capability Stage | 🚀 Production |
| Nature | 📖 Knowledge (sabe) |
| Criticality | 🟡 Supporting |
| Proof | Production |
| Status | production |
| Maturity | 2 |
| Depends On | `capability-feature-registry` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ✅ |

### Scientific Method

#### 🚀 Experiments Engine

| Campo | Valor |
|---|---|
| Research Object | `capability-experiments-engine` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🟡 Supporting |
| Proof | Production |
| Status | production |
| Maturity | 3 |
| Depends On | `engine-replay`, `engine-brain-analytics` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ✅ |

#### 🚀 Feature Registry

| Campo | Valor |
|---|---|
| Research Object | `capability-feature-registry` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🟠 Core |
| Proof | Production |
| Status | production |
| Maturity | 3 |
| Depends On | -- |
| Consumer | `capability-adoption-matrix`, `capability-capability-map`, `capability-dna-matrix`, `capability-engineering-patterns` |
| Replay Validated | ❌ |
| Production | ✅ |

#### 🚀 Brain Analytics

| Campo | Valor |
|---|---|
| Research Object | `engine-brain-analytics` |
| Capability Stage | 🚀 Production |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🟡 Supporting |
| Proof | Production |
| Status | production |
| Maturity | 2 |
| Depends On | `engine-replay` |
| Consumer | `capability-experiments-engine`, `capability-research-validation`, `engine-decision-brain`, `idea-evolution-engine`, `idea-hypothesis-ledger`, `idea-meta-analytics`, `idea-replay-attribution`, `idea-weight-engine` |
| Replay Validated | ❌ |
| Production | ✅ |

#### 📚 Hypothesis Ledger (Trading-as-Git)

| Campo | Valor |
|---|---|
| Research Object | `idea-hypothesis-ledger` |
| Capability Stage | 📚 Research |
| Nature | 📖 Knowledge (sabe) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | backlog |
| Maturity | 0 |
| Depends On | `engine-replay`, `engine-brain-analytics`, `idea-significance-testing`, `idea-monte-carlo-mode` |
| Consumer | `idea-hypothesis-builder`, `pattern-immutable-decision-ledger` |
| Replay Validated | ❌ |
| Production | ❌ |

#### 📚 Monte Carlo Mode (perturbação de candles)

| Campo | Valor |
|---|---|
| Research Object | `idea-monte-carlo-mode` |
| Capability Stage | 📚 Research |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | backlog |
| Maturity | 0 |
| Depends On | `engine-replay` |
| Consumer | `idea-hypothesis-ledger` |
| Replay Validated | ❌ |
| Production | ❌ |

#### 📚 Diagnóstico de overfitting via clustering do grid de parâmetros

| Campo | Valor |
|---|---|
| Research Object | `idea-optimizer-overfit-clustering` |
| Capability Stage | 📚 Research |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | backlog |
| Maturity | 0 |
| Depends On | `engine-backtest` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

#### 📚 Significance Testing (bootstrap p-value de regra de entrada)

| Campo | Valor |
|---|---|
| Research Object | `idea-significance-testing` |
| Capability Stage | 📚 Research |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | backlog |
| Maturity | 0 |
| Depends On | `engine-replay` |
| Consumer | `idea-hypothesis-ledger` |
| Replay Validated | ❌ |
| Production | ❌ |

## 6. Intelligence Domain

### Evolution

#### 💡 Evolution Engine

| Campo | Valor |
|---|---|
| Research Object | `idea-evolution-engine` |
| Capability Stage | 💡 Idea |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | ⚪ Optional |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `engine-brain-analytics`, `engine-replay` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

### Learning

#### 💡 Hypothesis Builder

| Campo | Valor |
|---|---|
| Research Object | `idea-hypothesis-builder` |
| Capability Stage | 💡 Idea |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | ⚪ Optional |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `idea-hypothesis-ledger`, `idea-asset-profile` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

### Feedback

#### 💡 Meta Analytics

| Campo | Valor |
|---|---|
| Research Object | `idea-meta-analytics` |
| Capability Stage | 💡 Idea |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | ⚪ Optional |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `engine-brain-analytics`, `engine-replay`, `idea-regime-engine` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ❌ |

### Optimization

#### 💡 Weight Engine

| Campo | Valor |
|---|---|
| Research Object | `idea-weight-engine` |
| Capability Stage | 💡 Idea |
| Nature | 🧠 Cognitive (pensa) |
| Criticality | 🔵 Experimental |
| Proof | Reasoning |
| Status | idea |
| Maturity | 0 |
| Depends On | `engine-brain-analytics`, `engine-replay`, `synthesis-context-fusion` |
| Consumer | `idea-structured-evidence` |
| Replay Validated | ❌ |
| Production | ❌ |

## 7. Infrastructure Domain

### Runtime

#### 🚀 Configuration

| Campo | Valor |
|---|---|
| Research Object | `capability-configuration` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🟠 Core |
| Proof | Production |
| Status | production |
| Maturity | 3 |
| Depends On | -- |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ✅ |

#### 🚀 Health Dashboard

| Campo | Valor |
|---|---|
| Research Object | `capability-health-dashboard` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🟡 Supporting |
| Proof | Production |
| Status | production |
| Maturity | 3 |
| Depends On | `capability-market-database` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ✅ |

#### 🚀 Monitoring (Data Confidence / Freshness / Incidents)

| Campo | Valor |
|---|---|
| Research Object | `capability-monitoring` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🟡 Supporting |
| Proof | Production |
| Status | production |
| Maturity | 3 |
| Depends On | `capability-market-database` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ✅ |

#### 🚀 Scheduler

| Campo | Valor |
|---|---|
| Research Object | `capability-scheduler` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🟠 Core |
| Proof | Production |
| Status | production |
| Maturity | 3 |
| Depends On | -- |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ✅ |

### Data

#### 🚀 Data Collectors

| Campo | Valor |
|---|---|
| Research Object | `capability-data-collectors` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🔴 Mission Critical |
| Proof | Production |
| Status | production |
| Maturity | 4 |
| Depends On | -- |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ✅ |

#### 🚀 Event Log

| Campo | Valor |
|---|---|
| Research Object | `capability-event-log` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🟡 Supporting |
| Proof | Production |
| Status | production |
| Maturity | 2 |
| Depends On | `capability-market-database` |
| Consumer | -- |
| Replay Validated | ❌ |
| Production | ✅ |

#### 🚀 Market Database

| Campo | Valor |
|---|---|
| Research Object | `capability-market-database` |
| Capability Stage | 🚀 Production |
| Nature | ⚙️ Operational (executa) |
| Criticality | 🔴 Mission Critical |
| Proof | Production |
| Status | production |
| Maturity | 4 |
| Depends On | -- |
| Consumer | `capability-event-log`, `capability-health-dashboard`, `capability-monitoring` |
| Replay Validated | ❌ |
| Production | ✅ |

## Legenda

**Capability Stage** (ciclo de vida): 💡 Idea · 📚 Research · 🧪 Prototype · 🔁 Replay · ✅ Validated · 🚀 Production · 🛠 Deprecated

**Nature** (o que a capability É): 🧠 Cognitive -- pensa/julga (Brains, Resolvers) · 📖 Knowledge -- sabe/representa fato (Asset Profile, Market Memory) · ⚙️ Operational -- executa/roda (Replay, Scheduler, Collectors, Risk)

**Criticality** (o quanto o sistema depende disso hoje, independente do Capability Stage): 🔴 Mission Critical (dinheiro/segurança na mesa) · 🟠 Core (o sistema quebra sem isso) · 🟡 Supporting (ajuda, não é indispensável) · 🔵 Experimental (candidato de peso, ainda não construído) · ⚪ Optional (baixa prioridade)

**Proof** (nível de evidência, complementa Maturity -- "nenhuma feature sem evidência"): Reasoning (só desenho) · Benchmark (testado contra dado real) · Replay (validado estatisticamente via Replay Engine) · Production (rodando de verdade) · Live Profit (provado com capital real -- nenhuma capability chegou aqui ainda)


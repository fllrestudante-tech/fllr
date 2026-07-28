# Lean/QuantConnect

`github.com/QuantConnect/Lean` -- motor de trading algorítmico multi-asset
(ações/forex/futuros/opções/cripto) em C#/.NET, usado em produção
institucional via QuantConnect Cloud. O mais maduro dos 5 projetos
auditados.

## Auditoria completa

- [Auditoria: Lean/QuantConnect vs. cripto10](../../) -- Algorithm
  Framework, Insight, Optimizer, live/backtest unificado. (artifact
  publicado em 2026-07-27)

## O que ficou provado ao ler o código

- **1º dos 5 projetos a unificar live e backtest de ponta a ponta**:
  `BacktestingTransactionHandler` herda literalmente de
  `BrokerageTransactionHandler`; `QCAlgorithm` nunca sabe se está em
  backtest ou ao vivo. Validação mais forte da série inteira de que o
  Replay Engine do cripto10 está no nível do estado da arte.
- **`Insight`** (`Direction/Magnitude/Confidence/Weight/Score`) é quase
  idêntico em espírito ao `BrainResult` do cripto10 -- confirmação
  independente do formato escolhido.
- **Insight Score** (equivalente ao Hypothesis Engine) existe só como hook
  opcional, sem implementação padrão -- mesmo o motor mais maduro deixou
  essa peça incompleta.
- **4ª confirmação idêntica, agora unânime**: Risk Management Models vetam
  via target "zerar posição" com precedência.
- **Optimizer/Analysis**: clustering (k-means) sobre o grid de parâmetros
  pra distinguir região estável de pico isolado suspeito de overfitting --
  única ideia genuinamente nova desta auditoria.
- Reality Modeling (fee/slippage/fill granulares, Almgren-Chriss) e
  Portfolio Construction (Markowitz/Black-Litterman) resolvem escala
  institucional que o cripto10 não tem.

## Ideias extraídas -- Research Objects no Feature Registry

| Registry id | Ideia | Prioridade |
|---|---|---|
| `idea-optimizer-overfit-clustering` | Diagnóstico de overfitting via clustering do grid | ★★★★☆ |
| `idea-risk-guard-pipeline` | 4º de 4 origens, agora unânime | ★★★★☆ |
| `idea-multi-exchange-plugin-pattern` | 4º de 4 origens (IBrokerage/IBrokerageFactory via MEF) | ★★☆☆☆ |

## O que NÃO vale importar

Reality Modeling de impacto de mercado (escala institucional); Portfolio
Construction multi-posição (cripto10 opera 1 símbolo/posição).

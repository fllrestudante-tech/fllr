# Jesse

`github.com/jesse-ai/jesse` -- framework de trading cripto em Python,
foco em backtest ultrarrápido (extensão Rust) e rigor estatístico. Live
trading é um pacote fechado externo (`jesse_live`), não auditável neste
repositório.

## Auditoria completa

- [Auditoria: Jesse vs. cripto10](../../) -- Significance Testing, Monte
  Carlo, store Redux-like. (artifact publicado em 2026-07-27, 5ª e última
  da série)

## O que ficou provado ao ler o código

- **Significance Testing**: bootstrap resampling (2000 simulações) sobre
  retornos de uma regra de entrada testada isoladamente ("só sinal"),
  devolve p-value formal de que a regra tem poder preditivo real vs.
  coincidência. A ideia mais forte desde o Trading-as-Git do OpenAlice.
- **Monte Carlo Mode**: perturba candles (ruído gaussiano + moving block
  bootstrap) e reroda o backtest milhares de vezes -- distribuição de
  métricas em vez de um número único.
- **Mesmo simulador pra backtest/optimize/monte-carlo/significance-test**
  -- 5ª confirmação de que reusar o motor de decisão entre modos de
  análise é o padrão certo.
- **"Otimização genética" não existe mais** -- é busca aleatória via
  Optuna (só storage) + Ray pra paralelizar, com overfitting mitigado só
  por split treino/teste reportado lado a lado (decisão manual).
- `risk_to_qty`/`kelly_criterion`: helpers opcionais nunca invocados
  automaticamente -- 3ª confirmação de que Kelly/edge sizing ambicioso não
  vingou como padrão.

## Ideias extraídas -- Research Objects no Feature Registry

| Registry id | Ideia | Prioridade |
|---|---|---|
| `idea-significance-testing` | Bootstrap p-value de regra de entrada | ★★★★☆ |
| `idea-monte-carlo-mode` | Perturbação de candles + distribuição de métricas | ★★★★☆ |
| `idea-kelly-edge-sizing` | 3ª confirmação de descarte | descartado |

## O que NÃO vale importar

Performance via Rust/array de crescimento geométrico (escala que o
Node.js do cripto10 não tem hoje).

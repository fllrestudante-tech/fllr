# Freqtrade

`github.com/freqtrade/freqtrade` -- bot de trading cripto em Python,
open-source, maduro, milhares de usuários reais. 100% determinístico (nem
o FreqAI usa LLM -- é ML clássico/RL).

## Auditoria completa

- [Auditoria: Freqtrade vs. cripto10](../../) -- arquitetura, FreqAI,
  Hyperopt, Protections, motor de backtest. (artifact publicado em
  2026-07-27)

## O que ficou provado ao ler o código

- **Motor de backtest é um segundo laço de controle**, reimplementado à
  parte do motor live -- a própria doc deles admite mismatch backtest/live
  como consequência conhecida. Valida a decisão do Replay Engine do
  cripto10 (reroda as mesmas funções dos Brains usadas ao vivo).
- **FreqAI**: pipeline de ML real em produção -- feature engineering
  (`%`-prefixed), labels (`&`-prefixed), retreino walk-forward com corte
  treino/teste estrito, Reinforcement Learning genuíno
  (`gymnasium`+`stable-baselines3`, reward shaping). Blueprint mais rico
  pra Fase 5 (Learning Engine) -- sem ação agora, corretamente
  sequenciado atrás do Decision Brain.
- **Hyperopt (Optuna)**: sem proteção automática contra overfitting --
  validação out-of-sample é disciplina manual do usuário. `isCandidateBetter`
  do cripto10 já é mais rigoroso (gate estatístico automático).
- **Edge module (Kelly/expectancy sizing) foi removido em 2025** pelo
  próprio Freqtrade.
- **Protections**: circuit breaker como classe resolvida por nome -- 2º
  voto pro mesmo padrão de Guard Pipeline do OpenAlice.

## Ideias extraídas -- Research Objects no Feature Registry

Nenhum item novo "implementar já" -- o valor foi validação (ver tags
`validated-by:freqtrade` em `engine-replay` e `engine-backtest`) e reforço
de recomendações já registradas via outras origens:

| Registry id | Papel do Freqtrade |
|---|---|
| `idea-risk-guard-pipeline` | 2º de 4 origens (Protections) |
| `idea-multi-exchange-plugin-pattern` | 2º de 4 origens (subclasse por exchange sobre ccxt) |
| `idea-kelly-edge-sizing` | 2ª de 3 confirmações de descarte (Edge module removido em 2025) |

## O que NÃO vale importar

Motor de backtest separado do live (armadilha conhecida, já evitada pelo
Replay Engine).

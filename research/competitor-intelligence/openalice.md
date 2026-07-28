# OpenAlice

`github.com/TraderAlice/OpenAlice` -- workspace de dados/ferramentas para
agentes de codificação externos (Claude Code/Codex/opencode/Pi) fazerem
trading. **Não é** um bot autônomo concorrente ao cripto10 -- o LLM externo
decide 100% da operação; a única camada determinística é aprovação humana
antes da execução.

## Auditorias completas

- [Auditoria de superfície](../../) -- arquitetura, pipeline de decisão,
  componentes inovadores, comparação componente a componente, roadmap
  avaliado. (artifact publicado em 2026-07-27)
- [Mergulho profundo](../../) -- 9 eixos: contexto, memória, classificação
  de mercado, múltiplos símbolos, watchlist, eventos, organização de IA,
  aprendizado, desacoplamento. (artifact publicado em 2026-07-27)

## O que ficou provado ao ler o código (não o marketing)

- **Trading-as-Git**: ledger de decisões estilo Git (stage→commit→push,
  hash SHA-256 encadeado, tese obrigatória, snapshot completo do estado no
  momento da decisão). O achado mais valioso de toda a série de 5
  auditorias.
- **Deliberadamente "burro" em síntese**: sem contexto centralizado, sem
  classificador de regime, sem embeddings/memória semântica, sem event
  bus (removido de propósito), watchlist fragmentada em 2 sistemas
  desconectados. Tudo isso é delegado ao LLM externo reconsultar sob
  demanda -- não é lacuna, é filosofia de design.
- **Achado que muda a prioridade**: o `TradingGit` tem a matéria-prima
  perfeita pra um scorecard automático (mensagem = tese, `stateAfter` =
  snapshot de PnL), mas **o próprio OpenAlice nunca construiu a
  agregação**. Zero `winRate`/`scorecard`/`trackRecord` em todo o código.
- **Gate de trading em 3 camadas reais**: staging obrigatório + master
  switch `allowAiTrading` (default `false`) + enforcement no próprio
  domínio (não só na borda da tool).
- **Guard Pipeline**: risco vetado por classes resolvidas por nome, cada
  uma só vê contexto montado (nunca a conta bruta) -- 1º de 4 projetos a
  confirmar esse padrão.

## Ideias extraídas -- Research Objects no Feature Registry

| Registry id | Ideia | Prioridade |
|---|---|---|
| `idea-hypothesis-ledger` | Ledger hash-encadeado como veículo do Hypothesis Engine | ★★★★★ |
| `idea-risk-guard-pipeline` | Risk veto plugável (1º de 4 origens) | ★★★★☆ |
| `idea-multi-exchange-plugin-pattern` | Broker Packs (1º de 4 origens) | ★★☆☆☆ |
| `idea-output-truncation-transparency` | "omitted: N" em vez de truncar em silêncio | ★★★☆☆ |
| `idea-opportunity-alice` | Nota: watchlist/multi-símbolo do OpenAlice são rasos -- não há atalho a copiar | -- |
| `idea-kelly-edge-sizing` | Edge module removido pelo OpenAlice (1ª de 3 confirmações) | descartado |

## O que NÃO vale importar

Estado 100% em arquivo (sem banco de dados) -- contradiz a base Market
Database do cripto10. Sistema multi-agente/event bus interno -- o próprio
OpenAlice construiu e removeu.

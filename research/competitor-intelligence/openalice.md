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
- [OpenAlice como Laboratório](../../) -- 3ª rodada, focada em PADRÕES
  arquiteturais (não funcionalidades): representação interna (FSM/grafo/
  blackboard/event sourcing), arquitetura de pastas, organização de IA
  (planner/critic/orquestração), desacoplamento avançado (capabilities/DI/
  hot-reload), lista explícita do que NÃO copiar pros 5 princípios do
  cripto10, watchlist/multi-símbolo a fundo, feature engineering. (artifact
  publicado em 2026-07-28)
- [Engineering Patterns — OpenAlice](https://claude.ai/code/artifact/674a6c7e-783c-4bad-a5e1-7d91f6cacf24) --
  5ª rodada, camada acima da auditoria: não módulos/arquivos/features, só
  PADRÕES (Immutable Decision Ledger, Capability Isolation,
  Anti-Corruption Layer, Progressive Commitment, Trust Verification +
  4 novos) e o que eles deliberadamente NÃO fizeram (embeddings, planner,
  FSM formal, event sourcing verdadeiro) e por quê. Alimenta a
  [DNA Matrix](../dna-matrix.md) (gerada, `npm run dna-matrix`). (artifact
  publicado em 2026-07-28)
- [OpenAlice — Deep Reverse Engineering](https://claude.ai/code/artifact/fa16c86c-f3a2-4bba-ac1c-662163179105) --
  4ª rodada, consolida as 3 anteriores em 19 eixos nomeados + 2 eixos novos
  (Escalabilidade, Governança) + investigação dos "10 gaps institucionais"
  (Cognitive Architecture, Memória profunda, Feature Lifecycle, Knowledge
  Graph tipado, Provenance, Confidence generalizado, Institutional Radar,
  Event Sourcing causal, fluxo científico do Hypothesis Ledger, Meta layer
  dos Brains). (artifact publicado em 2026-07-28)

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
- **Como laboratório, é radicalmente mais simples do que parece**: sem FSM
  formal, sem blackboard, sem event sourcing de verdade (o `TradingGit`
  parece mas consulta o broker ao vivo pra cada snapshot, não reconstrói
  nada), sem planner/critic/reflection, sem prompt graph, sem memory
  manager, sem feature store, sem validação estatística sistemática. O que
  existe de maduro é pequeno: cache com staleness explícita (`meta.stale`),
  capability/feature-flag com precedência `env > config > auto` +
  razão textual, e orquestração de sub-agentes real mas deliberadamente sem
  nenhum componente que julgue/funda respostas.
- **Achado que muda o desenho do Opportunity Alice**: o "panel" multi-
  símbolo do OpenAlice é anunciado como paralelo mas roda sequencial de
  verdade por baixo do capô; o circuit breaker de 60s compartilha uma
  única variável entre uma família inteira de métodos; não existe
  anti-churn nem teto de universo em lugar nenhum. Confirmação final de que
  não há atalho de cópia aqui.

## Ideias extraídas -- Research Objects no Feature Registry

| Registry id | Ideia | Prioridade |
|---|---|---|
| `idea-hypothesis-ledger` | Ledger hash-encadeado como veículo do Hypothesis Engine | ★★★★★ |
| `idea-risk-guard-pipeline` | Risk veto plugável (1º de 4 origens) | ★★★★☆ |
| `idea-multi-exchange-plugin-pattern` | Broker Packs (1º de 4 origens) | ★★☆☆☆ |
| `idea-output-truncation-transparency` | "omitted: N" em vez de truncar em silêncio | ★★★☆☆ |
| `idea-opportunity-alice` | Pipeline completo documentado (Universe Manager→...→Decision) + 4 anti-padrões a evitar | -- |
| `idea-kelly-edge-sizing` | Edge module removido pelo OpenAlice (1ª de 3 confirmações) | descartado |
| `idea-causal-event-log` | Replay evoluindo pra cadeia causal de eventos (gap 8, nenhuma das 5 plataformas tem) | ★★★☆☆ |
| `idea-dynamic-universe` | + camada "Institutional Radar" (Regime→Capital Flow→Sector Rotation) inspirada no board sector-rotation.ts | ★★★★★ |
| `idea-hypothesis-ledger` | + fluxo científico explícito (Hipótese→...→Reprodução→Conclusão→Adoção) | ★★★★★ |
| `idea-meta-analytics` | + ângulos específicos (erro por regime, drift, redundância persistente) | ★★☆☆☆ |
| `idea-confidence-engine` | + generalização além do Brain (qualquer Research Object) | ★★★☆☆ |

## O que NÃO vale importar

Estado 100% em arquivo (sem banco de dados) -- contradiz a base Market
Database do cripto10. Sistema multi-agente/event bus interno -- o próprio
OpenAlice construiu e removeu. Ver a auditoria "Laboratório" para a lista
completa de padrões que quebrariam os 5 princípios do cripto10 se copiados
sem adaptar (aprovação humana pontual como gate de promoção, feature flags
sem prova estatística, scheduler cego disparando automação, etc.).

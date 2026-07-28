# Research

Camada permanente de pesquisa do cripto10 -- diferente de `registry/` e
`experiments/` (que continuam exatamente onde estão, esta pasta não move
nem duplica o conteúdo deles, só referencia). O objetivo desta pasta é
transformar "uma auditoria pontual" em **fonte contínua de conhecimento**:
cada plataforma auditada ganha um documento vivo que evolui conforme a
gente revisita, não um relatório que expira no dia em que foi escrito.

## Estrutura

- **`competitor-intelligence/`** -- um arquivo por plataforma auditada
  (OpenAlice, Freqtrade, Hummingbot, Lean/QuantConnect, Jesse). Cada um
  resume os mecanismos reais encontrados, linka os artifacts completos da
  auditoria, e lista quais ideias extraídas viraram Research Object no
  Feature Registry (com o id, pra rastreabilidade).
- **[`registry/`](../registry/research-objects.json)** (raiz do projeto,
  não movido) -- o Feature Registry propriamente dito. `type: "idea"` com
  `owner.type: "external"` são as ideias vindas de auditoria de
  concorrentes; use `npm run registry -- list --type=idea` pra ver todas.
- **[`experiments/`](../experiments/definitions.json)** (raiz do projeto,
  não movido) -- definições do Experiments Engine.
- **`papers/`** -- reservado. Vazio hoje (nenhum paper acadêmico foi
  formalmente incorporado ainda) -- existe pra quando um `type: "paper"`
  no Registry precisar de um resumo mais longo do que cabe em
  `description`/`references`.
- **`benchmarks/`** -- reservado. Vazio hoje, mesma lógica de `papers/`
  para `type: "benchmark"` (ex: comparação formal de métricas entre
  cripto10 e um benchmark público) quando esse tipo de Research Object
  existir de fato.
- **`adoption-matrix.md`** -- **gerado**, não escrito à mão. Rodar
  `npm run adoption-matrix` regenera a partir do `registry/research-objects.json`
  atual -- nunca editar este arquivo diretamente, ele fica desatualizado
  na primeira mudança no Registry.

## Blueprint de pesquisa contínua (Fase 4)

Além de comparar plataforma-a-plataforma, existe uma síntese própria --
[artifact "Cripto10 — Blueprint de Pesquisa Contínua"](../..) -- propondo
7 motores novos que não substituem Brains/Replay/Analytics/Registry/
Experiments, só os alimentam com mais robustez: **Opportunity Engine**
(com **Dynamic Universe** dentro), **Feature Builder**, **Regime Engine**,
**Market Memory**, **Knowledge Graph**, **Confidence Engine**, **Evolution
Engine** -- mais 2 camadas de apoio de prioridade menor (**Asset
Profile**, **Cost Engine**). Todos registrados como `type: "idea"` com a
tag `fase-4` -- `npm run registry -- list --tags=fase-4` lista os 11.
Nenhuma implementação começou; é roadmap documentado, não compromisso de
prazo.

## OpenAlice Deep Reverse Engineering

Auditoria mais recente -- [artifact "OpenAlice — Deep Reverse Engineering"](https://claude.ai/code/artifact/fa16c86c-f3a2-4bba-ac1c-662163179105),
consolidando as 3 rodadas anteriores em 19 eixos (Filosofia, Arquitetura,
Fluxo de dados, Modelo de contexto, Memória, IA, Organização do código,
Eventos, Watchlists, Multi-symbol, Estado interno, Pesquisa, Backtesting,
Aprendizado, Escalabilidade, Observabilidade, Governança, Pontos fortes,
Limitações) + 2 eixos genuinamente novos (Escalabilidade, Governança
formal). Regra de incorporação, sem exceção: **nada é copiado -- cada
descoberta vira Research Object, passa por Experiments/Replay/Analytics, só
então é cogitada pra promoção.**

Refinou 4 ideias já existentes com o detalhe extra pedido nos "10 gaps
institucionais" desta rodada (`idea-meta-analytics`, `idea-confidence-engine`,
`idea-hypothesis-ledger`, `idea-dynamic-universe`, `idea-knowledge-graph`) e
registrou 1 ideia nova: `idea-causal-event-log` (Replay evoluindo de
snapshots de estado pra cadeia causal de eventos -- algo que nenhuma das 5
plataformas auditadas tem). 4 dos 10 gaps não viraram Research Object porque
já são cobertos pelos campos que o schema atual tem, sem mudança nenhuma:

- **Feature Lifecycle completo** (Idea→Research→Experiment→Replay→Paper
  Trading→Live Shadow→Limited Capital→Production→Monitoring→Retirement) --
  `status` já é vocabulário aberto (string livre). Vocabulário recomendado
  daqui pra frente, sem mudança de código: `idea → backlog → research →
  experiment → replay-validated → paper-trading → live-shadow →
  limited-capital → production → monitoring → retired/deprecated`.
- **Provenance/linhagem** (por que existe, quem criou, quando, que
  experimento validou, que replay aprovou) -- já coberto por
  `owner`+`references`+`history`+`dependsOn`+`listConsumers`; o que falta é
  uso consistente, não schema novo.
- **Cognitive Architecture** (Perception→Memory→Reasoning→Planning→
  Execution→Reflection→Learning) -- é uma lente de avaliação, não um motor
  pra construir; mapeada no artifact acima, não vira Research Object.
- **Relações tipadas no Knowledge Graph** (derivesFrom/validates/
  contradicts/...) -- deferido de propósito: exigiria mudar `dependsOn` de
  array de strings pra array de `{id, relation}`, mudança de schema real
  que só se justifica quando o Knowledge Graph (visualização) for
  construído de fato.

## 3 pilares (rodada mais recente) + Engineering Patterns + DNA Matrix

Usuário pediu foco em 3 pilares que multiplicam o valor de todos os Brains
existentes: **Market Knowledge Base** (`idea-asset-profile`, renomeada --
biografia por ativo: regimes conhecidos, reação a FOMC/CPI, drawdown médio,
funding/OI típicos, melhores/piores horários e regimes, setor/narrativa),
**Opportunity Engine + Dynamic Universe** (pipeline reordenado com filtros
de narrativa/setor/capital-flow/regime ANTES do scanner + loop vivo
Radar→Research→Brains→Replay→Analytics→Experiments→Registry→Opportunity→
Radar) e **Engineering Patterns / DNA Matrix** (este artifact:
[Engineering Patterns — OpenAlice](https://claude.ai/code/artifact/674a6c7e-783c-4bad-a5e1-7d91f6cacf24)).

Diferença desta rodada: em vez de perguntar "o que o OpenAlice tem",
pergunta "qual paradigma de engenharia ele usa" -- 14 Research Objects
novos `type: "pattern"` (Immutable Decision Ledger, Capability Isolation,
Anti-Corruption Layer, Progressive Commitment, Trust Verification,
Precedence Resolution, Append-Only Audit Trail, Complexity Rejection,
Delegated Judgment, Exclusive Ownership, mais 4 sobre decisões que o
OpenAlice deliberadamente NÃO tomou -- embeddings, planner, FSM formal,
event sourcing verdadeiro -- e por quê).

**`dna-matrix.md`** -- **gerado**, `npm run dna-matrix` (mesma disciplina
do `adoption-matrix.md`, nunca editar à mão). Pergunta diferente da
Adoption Matrix: não "de onde veio e com que prioridade", mas "isso combina
com os princípios do cripto10" -- `dna-fit:0-100` (alinhamento filosófico),
classificação (`SUPERIOR/INSPIRADOR/COMPLEMENTAR/EQUIVALENTE/NÃO
NECESSÁRIO/CONTRÁRIO AOS PRINCÍPIOS`, mais granular que o antigo
SUPERIOR/EQUIVALENTE/PIOR) e `maintenance-cost:low/medium/high` -- todas
tags novas, zero mudança de schema. Também introduz `domain:research|
knowledge|analysis|discovery`, resposta à crítica "muitos motores
horizontais": os mesmos componentes de sempre, agrupados em 4 domínios
claros em vez de uma lista plana de "Engines".

## A pergunta central mudou (rodada mais recente)

Usuário reformulou a pergunta que todo o desenho acima ainda respondia:
não "o que este ativo está fazendo" (pergunta de indicador), mas **"qual
ativo merece minha atenção AGORA"** (pergunta institucional). Isso
reordenou o Opportunity Engine -- o scanner deixa de ser a 1ª etapa,
passa a vir depois de Narrative Detection/Sector Detection/Correlation/
Capital Rotation/Market Regime -- e adicionou 6 Research Objects novos,
todos `type: "idea"`, `tags: ["fase-4", ...]`, zero implementação:
`idea-capital-flow-engine` (pra onde o dinheiro está indo, distinto de
Funding/OI), `idea-correlation-brain` (quem puxa quem entre
BTC/ETH/SOL/TOTAL3/DXY/Nasdaq/Gold/Bonds), `idea-multi-timeframe-brain`
(alignment/conflict score entre 1m-1w), `idea-weight-engine` (pesos dos
Brains aprendidos estatisticamente via Replay, não fixos),
`idea-replay-attribution` (Replay evolui de "acertou?" pra "por que
acertou, qual Brain ajudou/atrapalhou"), `idea-portfolio-intelligence`
(gestão multi-posição, ainda sem precondição real -- 1 posição por vez
hoje). `idea-market-memory`, `idea-dynamic-universe`, `idea-opportunity-alice`
e `idea-asset-profile` (Market Knowledge Base) foram enriquecidas com
mais detalhe, não substituídas.

**Ordem de Fase 4 proposta pelo usuário** (substitui a lista plana
anterior por uma sequência antes do Decision Brain): Market Knowledge
Base → Dynamic Universe → Capital Flow Engine → Correlation Brain →
Regime Engine → Multi-Timeframe Brain → Opportunity Engine → Market
Memory → Weight Engine → Decision Brain → Learning Engine. **Ainda não
confirmada como compromisso de implementação** -- é a 3ª+ rodada seguida
de expansão de escopo dentro do mesmo ciclo (Blueprint de 7 motores → 3
pilares/Engineering Patterns/DNA Matrix → esta), documentada por
disciplina de projeto, não porque a decisão de travar/começar a codar já
foi tomada.

## Por que não virou uma reorganização de pasta

`registry/` e `experiments/` já têm código real apontando pros caminhos
atuais (`lib/registry/registryStore.js`, `scripts/registry.js`,
`scripts/experiments.js`, testes) -- mover isso pra dentro de `research/`
seria uma mudança estrutural sem ganho real, só pra bater com o desenho
visual da pasta. `research/` é a camada de conhecimento/documentação;
`registry/` e `experiments/` continuam sendo a camada funcional, no lugar
onde o código já espera encontrá-los.

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

## Fase imediata (ordem confirmada, diferente da Fase 4 macro acima)

Enquanto a Fase 4 acima decide "qual motor grande vem depois", esta é a
sequência mais granular pra terminar de amadurecer o que já está em
construção (Market Knowledge Base). Ordem confirmada pelo usuário,
mudança principal: **`idea-feature-builder` entra ANTES do
Resolver/Replay, não depois**.

1. Market Knowledge Base acumula conhecimento real (Asset Profile+Statistics
   -- v1 entregue, `idea-asset-profile`).
2. Asset Statistics alimentada continuamente com histórico real (entregue,
   `npm run knowledge-base -- compute-statistics`).
3. Feature Builder evolui estatística em evidência consumível
   (`idea-feature-builder`, ainda `idea` -- exemplos ilustrativos: Funding
   Extreme, OI Expansion, Volatility Compression, Regime Transition,
   Liquidity Imbalance).
4. Resolvers conectados ao Replay Engine.
5. Validação via Replay/Experiments se cada Feature (não percentil/zscore
   isolado) melhora decisão -- **o Replay deve validar o que o Brain vai
   de fato consumir**, uma Feature nomeada, não um número solto sem
   significado direto.
6. Só depois disso um Brain passa a consumir essas Features de verdade.

Pipeline revisado: Knowledge → Statistics → **Feature Builder** →
Statistical Resolver → Signals → Brain (Feature Builder entra entre
Statistics e Resolver -- ver comentário atualizado em
`lib/knowledgeBase/statisticalResolver.js`).

**Status real (2026-07-29): passos 1-3 entregues** (Market Knowledge Base,
Asset Statistics, Feature Builder v1 -- 8 Features, 855 testes, ver
`idea-feature-builder`). **Passos 4-6 (Resolver↔Replay, validação
quantitativa, consumo por Brain) deliberadamente NÃO iniciados** --
reafirmado explicitamente pelo usuário como princípio: "nenhuma Feature
deve influenciar decisões de trading" até existir uma rodada dedicada e
um plano completo de validação. Escopo dessa rodada futura já registrado
como `idea-feature-replay-validation` (ainda `idea`, sem plano de código),
com as 5 perguntas que o plano dedicado precisará responder quando vier:
(1) como reconstruir o estado das Features ponto-a-ponto (point-in-time),
não só o snapshot atual; (2) como evitar look-ahead bias na recomputação;
(3) como registrar o resultado de cada Feature em cada replay pra análise
posterior; (4) como medir contribuição individual (Feature Attribution,
não só PnL final -- `idea-replay-attribution`); (5) critérios estatísticos
mínimos pra promover uma Feature de `research` → `replay-validated` →
consumo por Brain (vocabulário de Feature Lifecycle já documentado
abaixo). Disciplina de 5 passos confirmada: **construir infraestrutura
(feito) → produzir conhecimento (feito) → produzir Features (feito) →
validar quantitativamente (não iniciado) → só então Brain consome (não
iniciado)**.

## Knowledge Ecosystem (reframe -- Asset é só 1 de N domínios)

`idea-knowledge-ecosystem`: o verdadeiro centro da Knowledge Base não é
o ativo, é o CONTEXTO -- um ativo é só uma peça (mercado em bull, setor
L1, narrativa, dominância, funding, regime, tudo junto). Domínios de
conhecimento propostos além de Asset Knowledge (já existe): Market/
Sector/Narrative/Event/Macro/Exchange/Portfolio/Strategy Knowledge --
nenhum implementado, documentado como direção de longo prazo. Quando um
desses ganhar consumidor real, vira Research Object próprio com tabela
dedicada, mesmo padrão já usado pra Asset Knowledge.

**Família de Resolvers, não um Resolver gigante**: Knowledge Resolver
(`lib/knowledgeBase/resolver.js`) e Statistics Resolver
(`lib/knowledgeBase/statisticalResolver.js`) já são 2 membros de uma
família de Resolvers especializados por design (comentário atualizado em
ambos os arquivos) -- Context/Market/Portfolio Resolver nascem como
módulo próprio quando existirem, nunca como método a mais dentro de um
Resolver genérico.

**Capability Map confirmado congelado** (usuário reforçou explicitamente
nesta rodada) -- os 4 níveis Capability→Service→Component→Consumer,
Ownership/Produced-By Graph, Dependency Graph completo e o Architecture
Manifest continuam fora, sem prazo. **Proof também tem uma evolução
documentada, mas não priorizada**: `Hypothesis → Evidence → Replay →
Paper/Benchmark → Shadow Mode → Production → Live Profit → Long-term
Validation` -- diferenciaria melhor "hipótese promissora" de "hipótese
comprovada ao longo do tempo", mas é refinamento institucional, não
prioridade desta fase.

## Os 5 níveis do conhecimento (definição oficial)

Formalizado depois da evolução do Statistical Resolver -- distingue o que
até agora era tratado meio de forma solta:

1. **Observation** -- uma medição, nada mais. `Funding = 0.0032` não é
   conhecimento, é dado bruto. Vive na Storage (`lib/knowledgeBase/assetStore.js`/
   `assetStatisticsStore.js`), nunca julga.
2. **Knowledge** -- a Observation com contexto histórico agregado (Asset
   Statistics: médias, percentis, distribuição) -- ainda não é julgamento,
   é "o que normalmente acontece".
3. **Interpretation** -- a resposta a "isso é raro/comum/mudou/persiste/
   contradiz outro indicador" -- só o Statistical Resolver
   (`lib/knowledgeBase/statisticalResolver.js`) produz isso, nunca a
   Storage. Hoje: `{level, direction}` (LOW/NORMAL/HIGH/EXTREME).
4. **Hypothesis** -- uma Interpretation promovida a afirmação testável
   ("Funding extremo antecede expansão de volatilidade") -- ver
   `idea-hypothesis-builder`/`idea-hypothesis-ledger`, ainda não
   implementado.
5. **Decision** -- o que um Brain/Decision Brain faz com a Hypothesis
   validada -- fora do escopo da Knowledge Base inteiramente, é o Brain
   quem decide.

Dentro da própria Knowledge Base, dois tipos de fato coexistem e vale
distinguir mentalmente (não é uma separação de schema, `idea-asset-profile`
cobre os dois): **Institutional Facts** (identidade do ativo -- setor,
narrativa, exchange, listagem -- praticamente nunca muda) vs.
**Statistical Facts** (funding médio, ATR médio, OI médio -- muda
constantemente, sempre computado, nunca digitado).

**Evidence como objeto de primeira classe** -- documentado como evolução
futura, não implementado: `lib/brains/brainResult.js::evidence` hoje é um
array flat (raramente populado de fato pelos Brains atuais). A ideia é
`{ source, weight, confidence, reason }` por item em vez de string solta
-- abre caminho pro Weight Engine/Feature Attribution/Explainability sem
quebrar a interface de quem já lê `evidence` hoje (ninguém lê de forma
estruturada ainda). Registrado como `idea-structured-evidence`.

## Capability Map — documento central

`capability-map.md` -- **gerado**, `npm run capability-map` (mesma
disciplina de `adoption-matrix.md`/`dna-matrix.md`). Elevado a documento
central do projeto, mesmo nível do Blueprint de Pesquisa Contínua, da DNA
Matrix e do próprio Feature Registry -- publicado também como artifact
visual: [Cripto10 — Capability Map](https://claude.ai/code/artifact/4bbf9d11-9365-48a0-b59a-26db37e9b9de).

Pergunta diferente das outras duas: não "de onde veio" (Adoption Matrix)
nem "combina com os princípios" (DNA Matrix), mas **"o que o sistema é
capaz de fazer?"**. Organizado em **6 domínios** (Knowledge/Analysis/
Discovery/Execution/Research/Infrastructure), cada um com sub-domínios
(`capmap-domain:*`/`capmap-subdomain:*` -- taxonomia própria deste
documento, deliberadamente separada da `domain:*` de 4 domínios que a
DNA Matrix usa; documentos diferentes podem organizar o mesmo Registry de
formas diferentes, sem forçar concordância entre eles). Cada capability
vira um cartão com Research Object/Capability Stage/Status/Maturity/
Depends On/Consumer (derivado via `listConsumers`, nunca armazenado)/
Replay Validated/Production.

**Capability Stage** -- ciclo de vida próprio, independente do `status`
cru do Registry: 💡 Idea · 📚 Research · 🧪 Prototype · 🔁 Replay · ✅
Validated · 🚀 Production · 🛠 Deprecated (derivado de `status`+`maturity`
existentes, nenhum campo novo).

Esta rodada também registrou 20 Research Objects novos `type: "capability"`
pras capacidades REAIS de Execution/Infrastructure/Research-tooling que
só existiam como código, nunca tinham virado Research Object (Risk
Management, Order Execution, Experiments Engine, Feature Registry, Data
Collectors, Market Database, Scheduler, Health Dashboard, Monitoring,
Configuration, Knowledge Resolver/Statistical Resolver/Context Builder/
Signal Registry, e as próprias Adoption/DNA Matrix/Engineering
Patterns/Capability Map como capabilities de si mesmas) -- 106 Research
Objects total. Achado honesto registrado: "Event Bus" foi rotulado
`capability-event-log` de propósito -- cripto10 tem jornal de auditoria
append-only (`events_log`), não um event bus/pub-sub de verdade (e nunca
precisou, ver achado da auditoria OpenAlice: o próprio OpenAlice
construiu e removeu o event bus que tinha).

## Capability Map — congelado

Última rodada do Capability Map (usuário confirmou explicitamente: "depois
dessa atualização, o Capability Map deve ser considerado congelado --
próximas evoluções só via Research Objects + consumidor real + validação
por Replay/Experiments"). Acrescentou, tudo mecânico (tags novas sobre
Research Objects já existentes, zero código de Brain tocado):

- **Nature** -- 🧠 Cognitive (pensa/julga: Brains, Resolvers) · 📖
  Knowledge (sabe/representa fato: Asset Profile, Market Memory) · ⚙️
  Operational (executa/roda: Replay, Scheduler, Collectors, Risk).
- **Criticality** -- 🔴 Mission Critical · 🟠 Core · 🟡 Supporting · 🔵
  Experimental · ⚪ Optional -- independente do Capability Stage (Context
  Builder é mais crítico que Telegram Radar mesmo os dois sendo
  "Production").
- **Proof** -- Reasoning · Benchmark · Replay · Production · Live Profit
  -- complementa `maturity` com o nível de evidência real por trás de
  cada capability, reforçando "nenhuma feature sem evidência".
- **7º domínio: Intelligence** (Learning/Evolution/Feedback/Optimization)
  -- separado de Research porque não é mais método científico, é
  aprendizado do próprio sistema sobre si mesmo (`idea-hypothesis-builder`,
  `idea-evolution-engine`, `idea-meta-analytics`, `idea-weight-engine`).
- **Sub-domínios de Discovery refinados** (Universe Discovery/Opportunity
  Discovery/Opportunity Tracking -- Ranking/Learning ficam vazios por
  enquanto, sem objeto ainda, o que é honesto: Opportunity Alice ainda
  não diferencia essas etapas de verdade).

**Explicitamente NÃO implementado nesta rodada, documentado como próximo
passo só quando houver consumidor real**: quebrar "Capability" em 4
níveis (Capability→Service→Component→Consumer -- exigiria registrar
arquivos individuais como Research Object, ex: `StatisticsComputer`,
explosão de escopo sem consumidor claro ainda); Ownership/Produced-By
graph explícito (hoje já coberto por `dependsOn`/`listConsumers`, um
grafo formal separado seria redundante sem um caso de uso novo); cadeia
de rastreabilidade Pattern→Capability→Feature Registry→Git (boa
narrativa, sem ferramenta nova clara ainda); e o **Cripto10 Architecture
Manifest** (documento de 4-5 páginas, Vision→Principles→Domains→
Capabilities→Research→Implementation→Replay→Production, porta de entrada
pra qualquer pessoa ou IA que for contribuir) -- fica pro próximo pedido
explícito, propositalmente depois da arquitetura estar de fato parada,
não durante uma rodada que ainda está mexendo nela.

## Por que não virou uma reorganização de pasta

`registry/` e `experiments/` já têm código real apontando pros caminhos
atuais (`lib/registry/registryStore.js`, `scripts/registry.js`,
`scripts/experiments.js`, testes) -- mover isso pra dentro de `research/`
seria uma mudança estrutural sem ganho real, só pra bater com o desenho
visual da pasta. `research/` é a camada de conhecimento/documentação;
`registry/` e `experiments/` continuam sendo a camada funcional, no lugar
onde o código já espera encontrá-los.

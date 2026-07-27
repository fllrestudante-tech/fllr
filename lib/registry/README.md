# Feature Registry (Research Objects)

Catálogo estruturado de metadados sobre tudo que a plataforma já é ou pode
vir a ser: Features, Indicadores, Brains, Sínteses, Engines e, no futuro,
Experiments/Papers/Benchmarks/Datasets/Models. **É só uma camada de
metadados** -- não altera nenhum algoritmo, Brain, Replay Engine ou Brain
Analytics existente, e nenhum desses módulos lê o Registry hoje. O objetivo
é ter um vocabulário comum pronto para quando o Experiments Engine (próxima
entrega) precisar referenciar "qual feature esse experimento usou".

## Por que um Research Object comum

Em vez de Feature/Experiment/Paper/Benchmark/Dataset/Model nascerem cada um
com seu próprio formato (o que exigiria retrabalho a cada tipo novo),
qualquer objeto de pesquisa da plataforma compartilha a mesma forma. Um
Experiment futuro será só `type: "experiment"` referenciando
`dependsOn: ["feature-bos", ...]` -- não um subsistema novo.

## Forma do Research Object

```js
{
  id,            // kebab-case, ex: "feature-bos", único no registro
  type,          // vocabulário ABERTO (ver abaixo)
  name,
  description,
  owner: { type, name },      // ex: {type:"internal", name:"internal"}, {type:"community", name:"OpenAlice"}
  references: [{ type, url, note }],  // proveniência concreta (github/paper/youtube/commit/...), cada item objeto
  status,        // vocabulário ABERTO
  maturity,      // 0-5, ESCALA FECHADA (ver abaixo)
  tags: [],
  dependsOn: [], // ids de outros Research Objects
  metrics: { replay: {}, paperTrading: {}, live: {} },  // por fase -- accuracy/precision/recall/snapshots/winrate/avgRR/profitFactor
  history: [{ date, action, note }],  // log append-only, gerado automaticamente
  createdAt, updatedAt,
}
```

### `status` vs `maturity`

Dois campos com significado diferente por design (mesmo princípio de
`confidence` vs `score` no `BrainResult`, `lib/brains/brainResult.js`):

- **`status`** é o estado curatorial/intenção -- vocabulário recomendado
  hoje: `idea` → `backlog` → `research` → `validated` → `production` →
  `rejected` → `deprecated`. **Aberto** (string livre): um enum fechado
  quebraria assim que um status novo fosse necessário.
- **`maturity`** é a profundidade de evidência que sustenta isso -- escala
  **fechada** 0-5 (mesma de `lib/researchMaturity.js`, hoje só aplicada a
  Brains):
  - `0` Idea -- ainda não implementado.
  - `1` Prototype -- código existe, não validado por Replay.
  - `2` Replay -- validado estatisticamente via Replay Engine/Brain Analytics.
  - `3` Statistical -- amostra grande o suficiente (`config.replay.minSnapshotsForDecisionBrain`).
  - `4` Production -- decidindo/influenciando trades reais (mesmo que em Demo).
  - `5` Institutional -- rodando com capital real.

  Ex: `status: production` sozinho não diz se aquilo foi validado por 20
  ou 200.000 snapshots -- `maturity` responde isso.

### `type` e `owner.type` também são vocabulário aberto

Não há enum fechado -- validação exige só string não vazia. Vocabulário
recomendado hoje pra `type`: `feature`, `indicator`, `brain`, `synthesis`,
`engine`, `idea`, e futuramente `experiment`/`paper`/`benchmark`/`dataset`/
`model`. Pra `owner.type`: `internal`, `external`, `paper`, `community`.

### `metrics` por fase

`replay`/`paperTrading`/`live` são chaves reconhecidas mas não fechadas --
uma 4ª fase não quebra a validação. Dentro de cada fase, os campos
`accuracy`/`precision`/`recall`/`snapshots`/`winrate`/`avgRR`/`profitFactor`
são validados como número **se presentes**; chaves extras continuam
permitidas.

### `history` é gerado automaticamente

`upsertResearchObject` (usado tanto pela CLI `add` quanto por qualquer
código futuro) grava uma entrada sempre que `status` ou `maturity` mudam
entre a versão antiga e a nova (ex: `"maturity: 1 → 2"`), mais uma entrada
`"created"` na primeira inserção. Não é campo solto pra alguém lembrar de
preencher à mão -- `note` (opcional) captura o porquê (`--note=` na CLI).

### `usedBy`/consumidores -- derivado, não armazenado

Não existe campo `usedBy` gravado no objeto. Quem consome um Research
Object é computado sob consulta a partir de `dependsOn` de todos os
objetos (`registryStore.js::listConsumers`, com opção `transitive`) --
evita duplicar a aresta e ela dessincronizar de `dependsOn` com o tempo.
Mesmo princípio já usado no projeto pra `market_phase`
(`lib/collectors/knowledge/marketPhase.js`): calculado na consulta, nunca
persistido.

## Armazenamento

Um único arquivo JSON versionado em git, `registry/research-objects.json`
(array, ordenado por `id`). **Não** é gitignored -- ao contrário de
`data/`/`runtime/`/`logs/` (dado runtime/derivado), isto é conteúdo curado
à mão. Sem tabela SQLite: escrita rara e curada, precisa ser legível/
diffável em PR -- perfil de acesso oposto aos coletores de alta frequência
que justificam `market.db`.

## CLI (`npm run registry -- <subcomando>`)

- `list [--type=x] [--status=y]` -- tabela.
- `show <id>` -- objeto completo + `dependsOn` quebrado + consumidores
  (direto e transitivo).
- `validate` -- schema de cada objeto + integridade do registro inteiro
  (ids duplicados, `dependsOn` pra id inexistente). `process.exit(1)` se
  houver erro.
- `add --id=.. --type=.. --name=.. --status=.. [--maturity=N]
  [--owner-type=] [--owner-name=] [--reference=type:url:note (repetível)]
  [--description=] [--tags=a,b] [--depends=x,y] [--note=]` -- cria ou
  atualiza (substitui o objeto, preservando `createdAt`/`history`).

## Roadmap -- documentado, não implementado

Critério usado pra decidir o que entra nesta versão: **um campo só vira
código quando algum consumidor real (Replay, Analytics, Dashboard ou CLI)
precisar dele.** Os itens abaixo foram discutidos e conscientemente
adiados -- não são esquecimento:

- **`confidenceSource`** (`internal`/`external`/`mixed`) -- rastrear uma
  feature "deixando de ser externa" conforme é implementada, validada em
  Replay, Paper Trading e produção.
- **`origin`** (`Original`/`Inspired`/`Imported`/`Experimental`) -- ex: BOS
  `origin: SMC`, um indicador de Footprint importado de outra plataforma
  `origin: Imported`.
- **Namespace hierárquico de ids** (`feature.bos` em vez de
  `feature-bos`) -- ids kebab-case atuais continuam válidos.
- **Versionamento de schema, lineage, aliases, herança entre tipos,
  taxonomia hierárquica.**

O Experiments Engine (próxima entrega) é quem vai revelar quais desses
metadados realmente fazem falta -- construir antes disso seria desenhar
sem consumidor real.

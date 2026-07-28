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

## Por que não virou uma reorganização de pasta

`registry/` e `experiments/` já têm código real apontando pros caminhos
atuais (`lib/registry/registryStore.js`, `scripts/registry.js`,
`scripts/experiments.js`, testes) -- mover isso pra dentro de `research/`
seria uma mudança estrutural sem ganho real, só pra bater com o desenho
visual da pasta. `research/` é a camada de conhecimento/documentação;
`registry/` e `experiments/` continuam sendo a camada funcional, no lugar
onde o código já espera encontrá-los.

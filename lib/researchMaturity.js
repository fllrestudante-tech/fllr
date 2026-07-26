// Research Maturity — não é um Brain novo nem muda nada de nenhum
// algoritmo existente (pedido explícito do usuário: "não mexa em
// absolutamente nenhum algoritmo"). É só uma leitura derivada do que já
// está persistido em data/replay/stats.json (Replay Engine + Brain
// Analytics, ambos intocados aqui), pra responder objetivamente "em que
// nível de maturidade cada Brain está" — evita que alguém decida colocar
// algo em produção achando que já passou de um nível que na verdade não
// passou.
//
// Level 0 Ideia -- nem existe no código.
// Level 1 Implementado -- existe no código, mas o Replay Engine ainda não
//         validou (nunca rodou, ou rodou e não produziu nenhuma aposta
//         julgável desse Brain).
// Level 2 Replay validado -- já tem accuracy/precision/recall reais
//         (mesmo que a amostra ainda seja pequena).
// Level 3 20.000 snapshots -- amostra bate o critério objetivo de
//         lib/brainAnalytics.js::evaluateDecisionBrainReadiness
//         (config.replay.minSnapshotsForDecisionBrain).
// Level 4 Paper Trading / Level 5 Capital Real -- NUNCA promovidos
//         automaticamente por dado nenhum (index.js::cycle() continua no
//         signal.js antigo, nenhum Brain decide trade ainda) -- só via
//         MANUAL_PROMOTIONS abaixo, quando alguém de fato tomar essa
//         decisão operacional. Hoje está vazio -- ninguém foi promovido.
const MATURITY_LEVELS = {
  0: "Ideia",
  1: "Implementado",
  2: "Replay validado",
  3: "20.000 snapshots",
  4: "Paper Trading",
  5: "Capital Real",
};

// Brains que existem de fato no código hoje -- "decision" fica de fora
// de propósito (Decision Brain ainda não foi implementado).
const IMPLEMENTED_BRAINS = ["market", "structure", "liquidity", "context", "fvg", "orderBlock", "institutional"];

// Registro manual de promoção operacional -- ex: { fvg: 4 } no dia em que
// alguém de fato decidir rodar o FVG Brain em paper trading. Vazio hoje.
const MANUAL_PROMOTIONS = {};

function computeMaturityLevel(brainKey, stats, minSnapshotsForDecisionBrain) {
  if (MANUAL_PROMOTIONS[brainKey] != null) return MANUAL_PROMOTIONS[brainKey];
  if (!IMPLEMENTED_BRAINS.includes(brainKey)) return 0;
  if (!stats) return 1;

  const accuracyEntry = (stats.brainAccuracy || []).find((b) => b.brainKey === brainKey);
  if (!accuracyEntry || accuracyEntry.totalCalls === 0) return 1;

  const gradedCount = stats.decisionBrainReadiness?.checks?.sampleSize?.count ?? 0;
  if (gradedCount < minSnapshotsForDecisionBrain) return 2;

  return 3;
}

function computeAllMaturityLevels(stats, minSnapshotsForDecisionBrain) {
  const brainKeys = [...IMPLEMENTED_BRAINS, "decision"];
  return brainKeys.map((brainKey) => {
    const level = computeMaturityLevel(brainKey, stats, minSnapshotsForDecisionBrain);
    return { brainKey, level, label: MATURITY_LEVELS[level] };
  });
}

module.exports = { MATURITY_LEVELS, computeMaturityLevel, computeAllMaturityLevels };

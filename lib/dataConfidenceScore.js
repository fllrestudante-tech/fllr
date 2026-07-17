// Data Confidence Score: um único 0-100 por domínio, combinando os 3 pilares
// do Market Quality Engine (coverage, gaps, sanity). Pesos iniciais/
// hipótese, não travados -- mesma disciplina já aplicada ao score de 100
// pontos do roadmap geral (ajustar com dado real depois, não travar por
// intuição). Cada pilar ausente (null, ex: domínio orientado a evento) sai
// da média em vez de contar como 0 -- não penalizar o que não se aplica.
const WEIGHTS = { coverage: 0.4, gaps: 0.3, sanity: 0.3 };

function gapsToScore(gapsCount) {
  if (typeof gapsCount !== "number") return null;
  if (gapsCount === 0) return 100;
  return Math.max(0, 100 - gapsCount * 15); // cada gap desconta 15 pontos, mesma lógica de "não travar" -- calibrar depois
}

function computeDataConfidenceScore({ coveragePct = null, gapsCount = null, sanityPassRate = null } = {}) {
  const gapsScore = gapsToScore(gapsCount);
  const parts = [
    { value: coveragePct, weight: WEIGHTS.coverage },
    { value: gapsScore, weight: WEIGHTS.gaps },
    { value: sanityPassRate, weight: WEIGHTS.sanity },
  ].filter((p) => typeof p.value === "number");

  if (parts.length === 0) return { score: null, reason: "nenhum pilar disponível pra esse domínio" };

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const weightedSum = parts.reduce((sum, p) => sum + p.value * p.weight, 0);
  return { score: Math.round(weightedSum / totalWeight), gapsScore, partsUsed: parts.map((p) => p.value) };
}

module.exports = { computeDataConfidenceScore, gapsToScore, WEIGHTS };

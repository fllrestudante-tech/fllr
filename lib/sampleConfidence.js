// Sample Confidence -- evita a tentação de otimizar a estratégia (ou
// promover mudanças na mecânica de saída, Fase D) em cima de poucas dezenas
// de trades reais. Pura, sem I/O -- lib/tradingHealth.js já sabe quantos
// trades reais (fechados, com pnlPct) existem em data/trades.jsonl.
const DEFAULT_TARGET_TRADES = 100;
const MEDIUM_THRESHOLD_TRADES = 50; // "mínimo aceitável" citado pelo usuário -- abaixo disso é só ruído

function computeSampleConfidence(totalTrades, { target = DEFAULT_TARGET_TRADES, mediumThreshold = MEDIUM_THRESHOLD_TRADES } = {}) {
  const pct = target > 0 ? Math.round((totalTrades / target) * 100) : 0;
  const status = totalTrades >= target ? "HIGH_CONFIDENCE" : totalTrades >= mediumThreshold ? "MEDIUM_CONFIDENCE" : "LOW_CONFIDENCE";
  return { totalTrades, target, pct, status };
}

module.exports = { computeSampleConfidence, DEFAULT_TARGET_TRADES, MEDIUM_THRESHOLD_TRADES };

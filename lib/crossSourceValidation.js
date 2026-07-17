// Validação cruzada entre fontes de mercado (ex: Bybit vs. Binance) --
// completamente desacoplada de qual coletor é qual. Hoje só existe 1
// provider de dado de mercado (Bybit), então isso sempre avalia como "N/A"
// na prática -- mas a lógica já nasce pronta pra quando o Binance Collector
// existir, sem precisar reescrever nada, só passar dois conjuntos de valores
// reais em vez de um só.
//
// 3 estados possíveis (regra explícita do usuário, pra nunca confundir
// "ainda não dá" com "deu errado"):
// - N/A: só existe 1 provider pra esse domínio -- estado esperado hoje, não é erro nem warning.
// - WARNING: existem 2 providers, mas um está temporariamente indisponível.
// - ERROR: existem 2 providers, ambos operacionais, mas os dados divergem além do limite.
// - (implícito) "ok": 2 providers operacionais, divergência dentro do limite.
const DEFAULT_MAX_DIVERGENCE_PCT = 0.5;

/**
 * Compara dois arrays de valores JÁ alinhados por índice/timestamp (quem
 * chama é responsável por casar os pontos -- isso aqui só faz matemática,
 * não sabe o que é Bybit/Binance/candle/funding).
 */
function compareValues(valuesA, valuesB) {
  if (valuesA.length === 0 || valuesB.length === 0 || valuesA.length !== valuesB.length) {
    return { avgDivergencePct: null, maxDivergencePct: null, sampleSize: 0, reason: "amostras vazias ou de tamanhos diferentes" };
  }
  const diffs = valuesA.map((a, i) => {
    const b = valuesB[i];
    const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
    return (Math.abs(a - b) / denom) * 100;
  });
  return {
    avgDivergencePct: diffs.reduce((sum, d) => sum + d, 0) / diffs.length,
    maxDivergencePct: Math.max(...diffs),
    sampleSize: diffs.length,
  };
}

function evaluateCrossSourceStatus({ providersAvailable, providersOperational, divergencePct = null, maxDivergencePct = DEFAULT_MAX_DIVERGENCE_PCT }) {
  if (providersAvailable < 2) {
    return { status: "N/A", reason: "Only one market data provider available." };
  }
  if (providersOperational < 2) {
    return { status: "WARNING", reason: "Um dos providers está temporariamente indisponível." };
  }
  if (typeof divergencePct === "number" && divergencePct > maxDivergencePct) {
    return { status: "ERROR", reason: `Divergência de ${divergencePct.toFixed(2)}% excede o limite configurado de ${maxDivergencePct}%.` };
  }
  return { status: "ok", reason: null };
}

/**
 * Ponto de entrada único: dado o estado de disponibilidade dos providers +
 * (se aplicável) os valores a comparar, devolve o status final + a
 * comparação numérica bruta (útil pro dashboard mostrar o número, não só o
 * veredito).
 */
function compareProviders(providerAValues, providerBValues, { providersAvailable, providersOperational, maxDivergencePct = DEFAULT_MAX_DIVERGENCE_PCT } = {}) {
  const shouldCompare = providersAvailable >= 2 && providersOperational >= 2;
  const comparison = shouldCompare ? compareValues(providerAValues, providerBValues) : { avgDivergencePct: null, maxDivergencePct: null, sampleSize: 0 };
  const statusResult = evaluateCrossSourceStatus({
    providersAvailable,
    providersOperational,
    divergencePct: comparison.avgDivergencePct,
    maxDivergencePct,
  });
  return { ...statusResult, comparison };
}

module.exports = { compareValues, evaluateCrossSourceStatus, compareProviders, DEFAULT_MAX_DIVERGENCE_PCT };

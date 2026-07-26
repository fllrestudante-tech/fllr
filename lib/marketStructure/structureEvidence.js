// Extrai evidência de estrutura de mercado a partir dos swings já
// detectados -- BOS (Break of Structure) e CHOCH (Change of Character)
// nesta versão. Nome genérico de propósito ("evidence", não "events"):
// Equal Highs/Lows, Liquidity Sweep, FVG, Order Blocks, Breaker/Mitigation
// Blocks entram na mesma função/mesma forma de retorno nos próximos
// incrementos, sem precisar renomear de novo.
//
// Próxima evolução prevista (documentado, não implementada nesta versão):
// um "Swing Graph" poderia generalizar esta varredura sequencial se/quando
// múltiplos tipos de evidência precisarem consultar a mesma estrutura de
// formas muito diferentes entre si -- hoje só BOS/CHOCH existem, então uma
// varredura direta resolve sem essa camada extra.
const { detectSwingHighs, detectSwingLows, classifySwingHighs, classifySwingLows, DEFAULT_LOOKBACK } = require("./swingDetector");

// bullish só quando ambos concordam (HH+HL); bearish só quando ambos
// concordam (LH+LL); null quando misto -- nunca fabrica bias de um par
// ambíguo.
function computeBias(highLabel, lowLabel) {
  if (highLabel === "HH" && lowLabel === "HL") return "bullish";
  if (highLabel === "LH" && lowLabel === "LL") return "bearish";
  return null;
}

function groupByConfirmIndex(swings, lookback) {
  const map = new Map();
  for (const s of swings) {
    const confirmIndex = s.index + lookback;
    if (!map.has(confirmIndex)) map.set(confirmIndex, []);
    map.get(confirmIndex).push(s);
  }
  return map;
}

/**
 * Varre os candles em ordem cronológica: confirma swings quando chegam
 * (atualizando o bias vigente -- um par ambíguo mantém o último bias
 * conhecido em vez de resetar pra null, mesmo princípio de "estrutura
 * persiste até prova em contrário" do SMC), e checa se o close de cada
 * candle rompe algum nível ainda não rompido. Rompimento a favor do bias
 * vigente **na hora do rompimento** = BOS; contra = CHOCH. Só emite
 * evento depois que o bias já foi estabelecido pelo menos 1 vez.
 */
function extractStructureEvidence(candles, { lookback = DEFAULT_LOOKBACK } = {}) {
  const swingHighs = classifySwingHighs(detectSwingHighs(candles, lookback));
  const swingLows = classifySwingLows(detectSwingLows(candles, lookback));

  const highsByConfirmIndex = groupByConfirmIndex(swingHighs, lookback);
  const lowsByConfirmIndex = groupByConfirmIndex(swingLows, lookback);

  let lastHigh = null;
  let lastLow = null;
  let bias = null;
  const unbrokenLevels = [];
  const events = [];

  for (let i = 0; i < candles.length; i++) {
    for (const s of highsByConfirmIndex.get(i) || []) {
      lastHigh = s;
      unbrokenLevels.push({ price: s.price, type: "high", swing: s });
    }
    for (const s of lowsByConfirmIndex.get(i) || []) {
      lastLow = s;
      unbrokenLevels.push({ price: s.price, type: "low", swing: s });
    }
    if (lastHigh?.label && lastLow?.label) {
      bias = computeBias(lastHigh.label, lastLow.label) ?? bias;
    }

    const close = parseFloat(candles[i][4]);
    for (let k = unbrokenLevels.length - 1; k >= 0; k--) {
      const level = unbrokenLevels[k];
      const broke = level.type === "high" ? close > level.price : close < level.price;
      if (!broke) continue;
      if (bias) {
        const direction = level.type === "high" ? "bullish" : "bearish";
        const type = direction === bias ? "BOS" : "CHOCH";
        events.push({ index: i, type, direction, level: level.price, brokenSwing: level.swing });
      }
      unbrokenLevels.splice(k, 1);
    }
  }

  return { swingHighs, swingLows, events, bias };
}

module.exports = { extractStructureEvidence, computeBias };

// Detecção de swing highs/lows (fractal simples) e sua classificação
// HH/LH/HL/LL -- a base de tudo mais que o Structure Brain constrói em
// cima (BOS/CHOCH hoje; Equal Highs/Lows, Liquidity Sweep, Order Blocks,
// FVG depois usam os mesmos swings).
//
// Próxima evolução prevista (documentado, não implementado nesta versão):
// um "Swing Graph" (nodes/edges) poderia substituir estes arrays simples
// se/quando muitos tipos de evidência precisarem consultar a mesma
// estrutura de formas diferentes -- por ora, arrays simples resolvem o
// que o Structure Brain v1 precisa, sem especular uma abstração maior
// antes de existir um segundo consumidor real que a justifique.
const DEFAULT_LOOKBACK = 5;

// Um swing só é confirmado depois que `lookback` candles à frente existem
// -- os últimos `lookback` candles da série nunca têm swing confirmado
// (não fabricado, mesmo espírito de "amostra insuficiente" já usado em
// lib/volatilityRegime.js).
function detectSwingHighs(candles, lookback = DEFAULT_LOOKBACK) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const high = parseFloat(candles[i][2]);
    let isSwing = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (parseFloat(candles[j][2]) >= high) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) swings.push({ index: i, openTime: candles[i][0], price: high });
  }
  return swings;
}

function detectSwingLows(candles, lookback = DEFAULT_LOOKBACK) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const low = parseFloat(candles[i][3]);
    let isSwing = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (parseFloat(candles[j][3]) <= low) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) swings.push({ index: i, openTime: candles[i][0], price: low });
  }
  return swings;
}

// Rotula cada swing (a partir do 2º do mesmo tipo) comparando com o
// anterior -- HH/LH pra highs, HL/LL pra lows. O primeiro de cada tipo
// fica label:null (não tem o que comparar ainda).
function classifySwingHighs(swingHighs) {
  return swingHighs.map((s, i) => (i === 0 ? { ...s, label: null } : { ...s, label: s.price > swingHighs[i - 1].price ? "HH" : "LH" }));
}

function classifySwingLows(swingLows) {
  return swingLows.map((s, i) => (i === 0 ? { ...s, label: null } : { ...s, label: s.price > swingLows[i - 1].price ? "HL" : "LL" }));
}

// Conta quantos swings seguidos, contando do mais recente pra trás, têm o
// mesmo label -- "quantos HH consecutivos", não só se o último é HH ou
// não. Para no primeiro que diverge ou é null.
function computeTrailingStreak(classifiedSwings, label) {
  let streak = 0;
  for (let i = classifiedSwings.length - 1; i >= 0; i--) {
    if (classifiedSwings[i].label !== label) break;
    streak++;
  }
  return streak;
}

module.exports = { detectSwingHighs, detectSwingLows, classifySwingHighs, classifySwingLows, computeTrailingStreak, DEFAULT_LOOKBACK };

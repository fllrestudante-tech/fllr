const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyTrend, classifySentiment, classifyRisk, combineOverall, analyzeMarket } = require("../lib/brains/marketBrain");

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tendência de alta clara e sustentada -- preço sobe de forma consistente
// por 300 candles, bem acima de onde EMA50/EMA200 conseguem acompanhar.
function bullishCloses(n = 300, seed = 1) {
  const rand = mulberry32(seed);
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price += 0.3 + rand() * 0.1; // deriva de alta constante, ruído pequeno
    out.push(price);
  }
  return out;
}

function bearishCloses(n = 300, seed = 2) {
  const rand = mulberry32(seed);
  const out = [];
  let price = 300;
  for (let i = 0; i < n; i++) {
    price -= 0.3 + rand() * 0.1;
    out.push(Math.max(price, 1));
  }
  return out;
}

// Lateral: oscila em torno de um preço fixo, sem deriva -- EMA50≈EMA200.
function rangingCloses(n = 300, seed = 3) {
  const rand = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(100 + Math.sin(i / 10) * 0.5 + (rand() - 0.5) * 0.2);
  }
  return out;
}

test("classifyTrend: dado insuficiente (< 200 candles) -- RANGING, confiança 0, nunca julgamento precoce", () => {
  const result = classifyTrend({ closes: bullishCloses(150) });
  assert.equal(result.state, "RANGING");
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.reasons, ["dado histórico insuficiente"]);
  assert.ok(result.missingEvidence.includes("ADX"));
});

test("classifyTrend: tendência de alta sustentada -- TRENDING_BULL com reasons ricos", () => {
  const result = classifyTrend({ closes: bullishCloses() });
  assert.equal(result.state, "TRENDING_BULL");
  assert.ok(result.confidence > 0);
  assert.ok(result.reasons.some((r) => r.includes("EMA50 acima da EMA200")));
  assert.ok(result.reasons.some((r) => r.includes("Preço acima da EMA200")));
  assert.ok(result.reasons.some((r) => r.includes("Tendência mantida há")));
  assert.ok(result.missingEvidence.includes("Market Structure (BOS/CHOCH)"));
});

test("classifyTrend: tendência de baixa sustentada -- TRENDING_BEAR", () => {
  const result = classifyTrend({ closes: bearishCloses() });
  assert.equal(result.state, "TRENDING_BEAR");
  assert.ok(result.reasons.some((r) => r.includes("EMA50 abaixo da EMA200")));
  assert.ok(result.reasons.some((r) => r.includes("Preço abaixo da EMA200")));
});

test("classifyTrend: série lateral sem deriva -- RANGING", () => {
  const result = classifyTrend({ closes: rangingCloses() });
  assert.equal(result.state, "RANGING");
});

test("classifySentiment: sem histórico -- NEUTRAL, confiança 0", () => {
  const result = classifySentiment({ history: [] });
  assert.equal(result.state, "NEUTRAL");
  assert.equal(result.confidence, 0);
});

test("classifySentiment: Extreme Fear -- PANIC, alta confiança", () => {
  const result = classifySentiment({ history: [{ value: 10, classification: "Extreme Fear", snapshot_time: 1000 }] });
  assert.equal(result.state, "PANIC");
  assert.equal(result.confidence, 80); // |10-50|/50*100
  assert.ok(result.reasons[0].includes("10"));
  assert.ok(result.reasons[0].includes("Extreme Fear"));
});

test("classifySentiment: Extreme Greed -- EUPHORIA", () => {
  const result = classifySentiment({ history: [{ value: 92, classification: "Extreme Greed", snapshot_time: 1000 }] });
  assert.equal(result.state, "EUPHORIA");
  assert.equal(result.confidence, 84);
});

test("classifySentiment: Neutral no valor 50 -- confiança mínima", () => {
  const result = classifySentiment({ history: [{ value: 50, classification: "Neutral", snapshot_time: 1000 }] });
  assert.equal(result.state, "NEUTRAL");
  assert.equal(result.confidence, 0);
});

test("classifySentiment: histórico todo no mesmo bucket -- reason de estabilidade", () => {
  const history = [
    { value: 25, classification: "Fear", snapshot_time: 5000 },
    { value: 28, classification: "Fear", snapshot_time: 4000 },
    { value: 22, classification: "Extreme Fear", snapshot_time: 3000 },
  ];
  const result = classifySentiment({ history });
  assert.ok(result.reasons.some((r) => r.includes("estável")));
});

test("classifyRisk: nenhum pilar disponível -- RISK_OFF, confiança 0", () => {
  const result = classifyRisk({});
  assert.equal(result.state, "RISK_OFF");
  assert.equal(result.confidence, 0);
});

test("classifyRisk: todos os pilares apontando risk-on -- RISK_ON com reasons corretos", () => {
  const result = classifyRisk({ fundingRate: 0.0003, oiTrendPct: 5, longShortSkew: 0.2, dominanceTrendPct: -2 });
  assert.equal(result.state, "RISK_ON");
  assert.equal(result.confidence, 100);
  assert.ok(result.reasons.some((r) => r.includes("Funding positivo")));
  assert.ok(result.reasons.some((r) => r.includes("Open Interest subindo")));
  assert.ok(result.reasons.some((r) => r.includes("Maioria comprada")));
  assert.ok(result.reasons.some((r) => r.includes("Dominância BTC caindo")));
});

test("classifyRisk: todos os pilares apontando risk-off -- RISK_OFF", () => {
  const result = classifyRisk({ fundingRate: -0.0003, oiTrendPct: -5, longShortSkew: -0.1, dominanceTrendPct: 2 });
  assert.equal(result.state, "RISK_OFF");
  assert.ok(result.reasons.some((r) => r.includes("Funding negativo")));
  assert.ok(result.reasons.some((r) => r.includes("Maioria vendida")));
});

test("classifyRisk: só 1 pilar disponível -- ainda funciona, sem fabricar os outros", () => {
  const result = classifyRisk({ fundingRate: 0.0003 });
  assert.equal(result.state, "RISK_ON");
  assert.equal(result.reasons.length, 1);
});

test("combineOverall: 3 eixos favoráveis -- MARKET_FAVORABLE, reasons prefixados por eixo", () => {
  const trend = { state: "TRENDING_BULL", confidence: 90, reasons: ["r1"], missingEvidence: ["ADX"] };
  const sentiment = { state: "EUPHORIA", confidence: 80, reasons: ["r2"], missingEvidence: ["Narrativa"] };
  const risk = { state: "RISK_ON", confidence: 70, reasons: ["r3"], missingEvidence: ["Liquidez"] };
  const result = combineOverall({ trend, sentiment, risk });
  assert.equal(result.state, "MARKET_FAVORABLE");
  assert.equal(result.confidence, 80);
  assert.deepEqual(result.reasons, ["Tendência: r1", "Sentimento: r2", "Risco: r3"]);
  assert.deepEqual(result.missingEvidence, ["ADX", "Narrativa", "Liquidez"]);
});

test("combineOverall: 3 eixos desfavoráveis -- MARKET_UNFAVORABLE", () => {
  const trend = { state: "TRENDING_BEAR", confidence: 90, reasons: ["r1"], missingEvidence: [] };
  const sentiment = { state: "PANIC", confidence: 80, reasons: ["r2"], missingEvidence: [] };
  const risk = { state: "RISK_OFF", confidence: 70, reasons: ["r3"], missingEvidence: [] };
  const result = combineOverall({ trend, sentiment, risk });
  assert.equal(result.state, "MARKET_UNFAVORABLE");
});

test("combineOverall: eixos neutros/mistos com baixa confiança -- MARKET_NEUTRAL", () => {
  const trend = { state: "RANGING", confidence: 0, reasons: [], missingEvidence: [] };
  const sentiment = { state: "NEUTRAL", confidence: 0, reasons: [], missingEvidence: [] };
  const risk = { state: "RISK_OFF", confidence: 0, reasons: ["dado de risco indisponível"], missingEvidence: [] };
  const result = combineOverall({ trend, sentiment, risk });
  assert.equal(result.state, "MARKET_NEUTRAL");
});

test("combineOverall: missingEvidence deduplicado entre eixos", () => {
  const trend = { state: "RANGING", confidence: 10, reasons: ["r"], missingEvidence: ["ADX", "Liquidez"] };
  const sentiment = { state: "NEUTRAL", confidence: 10, reasons: ["r"], missingEvidence: ["Liquidez"] };
  const risk = { state: "RISK_ON", confidence: 10, reasons: ["r"], missingEvidence: ["Volume Profile"] };
  const result = combineOverall({ trend, sentiment, risk });
  assert.deepEqual(result.missingEvidence, ["ADX", "Liquidez", "Volume Profile"]);
});

test("analyzeMarket: orquestra os 3 eixos + overall a partir dos inputs brutos", () => {
  const result = analyzeMarket({
    closes: bullishCloses(),
    fearGreedHistory: [{ value: 80, classification: "Greed", snapshot_time: 1000 }],
    fundingRate: 0.0002,
    oiTrendPct: 3,
    longShortSkew: 0.05,
    dominanceTrendPct: -1,
  });
  assert.equal(result.trend.state, "TRENDING_BULL");
  assert.equal(result.sentiment.state, "EUPHORIA");
  assert.equal(result.risk.state, "RISK_ON");
  assert.ok(["MARKET_FAVORABLE", "MARKET_NEUTRAL"].includes(result.overall.state));
  assert.ok(Array.isArray(result.overall.reasons));
  assert.ok(Array.isArray(result.overall.missingEvidence));
});

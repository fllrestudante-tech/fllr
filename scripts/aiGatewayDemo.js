// Runner manual do AI Gateway (Fase 1, scaffold) -- execução única, não é um
// daemon. Monta um contexto sintético (não lê market.db nem chama a Bybit) só
// pra exercitar o Gateway isolado. Quando (fase futura, fora deste escopo) o
// Gateway for chamado de verdade, o contexto virá do Context Fusion real.
const config = require("../config");
const { getAssessment } = require("../lib/aiGateway/aiGateway");

const sampleContext = {
  symbol: config.symbol,
  interval: config.interval,
  price: 150.23,
  market: {
    state: "TRENDING_BULL",
    confidence: 72,
    score: 65,
    reasons: ["EMA50 acima da EMA200"],
    metadata: { sourceDataTime: new Date().toISOString() },
  },
  structure: {
    state: "STRONG",
    confidence: 60,
    score: 55,
    reasons: ["BOS de alta confirmado"],
    metadata: {},
  },
  liquidity: {
    state: "LIQUIDITY_ABOVE",
    confidence: 50,
    score: 40,
    reasons: ["Liquidez acima do preço atual"],
    metadata: {},
  },
  fusion: {
    state: "FUSED_BULLISH",
    confidence: 68,
    score: 60,
    reasons: ["Maioria dos Brains aponta alta"],
    metadata: {},
  },
};

process.on("SIGINT", () => {
  console.log("🤖 AI Gateway demo encerrado (SIGINT).");
  process.exit(0);
});

async function main() {
  console.log(`🤖 AI Gateway demo -- primário: ${config.ai.primaryProvider}, secundário: ${config.ai.secondaryProvider}`);
  const result = await getAssessment(sampleContext);
  console.log(JSON.stringify(result, null, 2));
  console.log(`📝 Auditoria gravada em ${config.paths.aiAssessmentsLog}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("⚠️  AI Gateway demo falhou:", err.message);
    process.exit(1);
  });

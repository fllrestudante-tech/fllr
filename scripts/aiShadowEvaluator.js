// AI Shadow Evaluation (Fase 2) -- processo standalone, observação-apenas.
// Não registrado em scripts/supervisor.js ainda (execução manual, por
// decisão explícita: só entra no supervisor depois que um ciclo completo de
// previsão+conciliação real for validado à mão). Nunca importa/é importado
// por index.js ou lib/risk.js.
const path = require("path");
const config = require("../config");
const { openDb, DEFAULT_DB_PATH } = require("../lib/infra/db");
const { getAssessment, hashContext } = require("../lib/aiGateway/aiGateway");
const { startHeartbeat } = require("../lib/heartbeatWriter");
const { computeRealContext, recordPrediction, reconcileDue, getLatestContextHash } = require("../lib/shadowEvaluation");

const HEALTH_FILE = path.join(__dirname, "..", "runtime", "heartbeats", "ai-shadow-evaluator.json");
const { symbol, interval } = config;

const db = openDb();
let lastTickStats = null;

async function tick() {
  const stats = { at: new Date().toISOString(), reconciled: 0, predicted: false, skipped: false, error: null };
  try {
    const reconciled = reconcileDue(db, { symbol, interval, now: Date.now() });
    stats.reconciled = reconciled.length;
    if (reconciled.length) console.log(`🔎 AI Shadow Eval: ${reconciled.length} horizonte(s) reconciliado(s).`);

    const real = computeRealContext(db, { symbol, interval });
    if (real.price == null) {
      console.log("⚠️  AI Shadow Eval: sem candle recente em market.db, pulando previsão desta rodada.");
      lastTickStats = stats;
      return;
    }

    const context = {
      symbol,
      interval,
      price: real.price,
      market: real.market,
      structure: real.structure,
      liquidity: real.liquidity,
      fusion: real.fusion,
    };
    const newHash = hashContext(context);
    const lastHash = getLatestContextHash(db, { symbol, interval });

    if (lastHash && lastHash === newHash) {
      console.log("⏭️  AI Shadow Eval: contexto sem mudança desde a última rodada, pulando chamada à IA (cost-guard).");
      stats.skipped = true;
      lastTickStats = stats;
      return;
    }

    const aiResult = await getAssessment(context);
    recordPrediction(db, { aiResult, price: real.price, symbol, interval });
    stats.predicted = true;
    console.log(`🤖 AI Shadow Eval: previsão registrada (${aiResult.state}, score ${aiResult.score}, provider ${aiResult.ai.provider || "nenhum"}).`);
  } catch (err) {
    stats.error = err.message;
    console.error("⚠️  AI Shadow Eval: tick falhou, ciclo pulado (sem corromper histórico):", err.message);
  }
  lastTickStats = stats;
}

console.log(
  `🔮 AI Shadow Evaluator iniciando -- ${symbol} ${interval}m, tick a cada ${config.ai.shadowIntervalMs / 60000}min, DB ${DEFAULT_DB_PATH}. NÃO registrado no supervisor -- execução manual.`
);

tick(); // roda uma vez já no boot, não espera o 1º intervalo inteiro
const tickTimer = setInterval(tick, config.ai.shadowIntervalMs);
const heartbeat = startHeartbeat(HEALTH_FILE, () => ({ lastTickStats }));

process.on("SIGINT", () => {
  console.log("🔮 AI Shadow Evaluator encerrado (SIGINT).");
  clearInterval(tickTimer);
  heartbeat.stop();
  db.close();
  process.exit(0);
});

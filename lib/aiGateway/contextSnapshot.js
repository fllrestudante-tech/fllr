// Monta o snapshot estruturado de contexto entregue ao AI Gateway a cada
// ciclo em que lib/aiGateway/decisionCyclePolicy.js decide que vale a pena
// avaliar. Só usa dado já computado neste ciclo (analysis/regime/botState --
// gratuito, zero I/O extra) ou já persistido em disco pelo Runtime Metrics
// Engine (runtime/metrics/context.json e quality.json, ambos slow-tier/
// 15min, escritos por scripts/metricsSampler.js) -- NUNCA recalcula Brains
// nem abre o market.db a partir daqui. O loop de trading roda a cada 10s
// (config.loopIntervalMs); recomputar Structure/Liquidity/FVG a esse ritmo
// competiria por I/O com o coletor e atrasaria a checagem de SL/TP/trailing,
// que é sempre prioridade sobre qualquer leitura de IA.
const fs = require("fs");
const path = require("path");
const config = require("../../config");

const METRICS_DIR = path.join(__dirname, "..", "..", "runtime", "metrics");

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function findEvidencePayload(contextFusion, type) {
  const entry = (contextFusion?.evidence || []).find((e) => e.type === type);
  return entry ? entry.payload : null;
}

function buildRiskState({ botState, regime, now = Date.now() }) {
  const circuitBreakerActive = !!(botState.circuitBreakerUntil && now < botState.circuitBreakerUntil);
  return {
    volatilityRegime: regime,
    circuitBreakerActive,
    circuitBreakerRemainingMs: circuitBreakerActive ? botState.circuitBreakerUntil - now : 0,
    consecutiveLosses: botState.consecutiveLosses || 0,
    consecutiveLossesLimit: config.circuitBreakerLossStreak,
    dailyLossPct: botState.dailyLoss || 0,
    dailyLossLimitPct: config.dailyLossLimitPct,
  };
}

function buildPositionSnapshot(botState) {
  if (!botState.isOpened) return { isOpened: false };
  return {
    isOpened: true,
    side: botState.side,
    entryPrice: botState.entryPrice,
    qty: botState.qty,
    stopLossPrice: botState.stopLossPrice,
    takeProfitPrice: botState.takeProfitPrice,
    breakEvenApplied: !!botState.breakEvenApplied,
    trailingActivated: !!botState.trailingActivated,
    tpLevelsTotal: (botState.tpLevels || []).length,
    tpLevelsFilled: botState.tpLevelsFilled || 0,
    holdMs: botState.openedAt ? Date.now() - botState.openedAt : null,
  };
}

function buildQuantSignal(analysis) {
  return {
    signal: analysis.signal,
    reasons: analysis.reasons,
    price: analysis.price,
    indicators: {
      emaShort: analysis.ema8,
      emaLong: analysis.ema56,
      rsi: analysis.rsi,
      stochRsi: analysis.stoch,
      obv: analysis.obv,
      atr: analysis.atr,
    },
    params: analysis.params,
  };
}

/**
 * market/structure/liquidity aqui são só {state, score, confidence} (o que
 * o Context Fusion persiste em evidence[].payload) -- mais enxuto que os
 * BrainResult completos que lib/shadowEvaluation.js recomputa direto do
 * market.db (aqueles têm `reasons`; este não). Tradeoff deliberado: o loop
 * de trading paga zero custo de I/O/CPU extra por isso, e
 * lib/aiGateway/promptBuilder.js já tolera a ausência de `reasons`.
 */
// contextFusion/quality são injetáveis (testabilidade, mesmo padrão de
// lib/backtest.js::run({db, bybitClient})) -- por padrão lê os snapshots
// reais do Runtime Metrics Engine.
function buildContextSnapshot({ analysis, regime, botState, now = Date.now(), contextFusion, quality } = {}) {
  if (contextFusion === undefined) contextFusion = readJsonSafe(path.join(METRICS_DIR, "context.json"));
  if (quality === undefined) quality = readJsonSafe(path.join(METRICS_DIR, "quality.json"));

  return {
    symbol: config.symbol,
    interval: config.interval,
    price: analysis.price,
    quant: buildQuantSignal(analysis),
    position: buildPositionSnapshot(botState),
    riskState: buildRiskState({ botState, regime, now }),
    market: findEvidencePayload(contextFusion, "MARKET_BRAIN"),
    structure: findEvidencePayload(contextFusion, "STRUCTURE_BRAIN"),
    liquidity: findEvidencePayload(contextFusion, "LIQUIDITY_BRAIN"),
    fusion: contextFusion
      ? {
          state: contextFusion.state,
          confidence: contextFusion.confidence,
          score: contextFusion.score,
          reasons: contextFusion.reasons,
          dominantNarrative: contextFusion.dominantNarrative,
          secondaryNarrative: contextFusion.secondaryNarrative,
        }
      : null,
    marketQuality: quality?.quality || null,
    crossSourceValidation: quality?.crossSourceValidation || null,
    sourceReliability: quality?.sourceReliability || null,
    contextFusionSampledAt: contextFusion?.sampledAt || null,
    qualitySampledAt: quality?.sampledAt || null,
    snapshotAt: new Date(now).toISOString(),
  };
}

module.exports = { buildContextSnapshot, buildRiskState, buildPositionSnapshot, buildQuantSignal, readJsonSafe, findEvidencePayload };

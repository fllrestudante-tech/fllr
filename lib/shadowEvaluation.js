// AI Shadow Evaluation (Fase 2) -- observa contexto real e o que a IA disse
// sobre ele, sem nenhuma autoridade de execução (ver lib/aiGateway/aiGateway.js
// pra Fase 1). Este módulo só grava/concilia dado; a análise "a IA tem edge
// financeiro?" é fase futura, depois de acumular amostra suficiente.
const marketBrainData = require("./brains/marketBrainData");
const marketBrain = require("./brains/marketBrain");
const structureBrainData = require("./brains/structureBrainData");
const structureBrain = require("./brains/structureBrain");
const liquidityBrainData = require("./brains/liquidityBrainData");
const liquidityBrain = require("./brains/liquidityBrain");
const { fuseContext } = require("./brains/contextFusion");
const { readCandlesFromDb } = require("./candleHistory");

const HORIZON_MINUTES = [15, 30, 60, 240]; // fixo por spec do usuário, não configurável via env
const RECONCILE_TOLERANCE_MS = 5 * 60 * 1000; // ver justificativa no plano: coletor faz poll a cada 60s, candle costuma chegar em ~1-2min do open_time
const PRICE_LOOKBACK_MS = 10 * 60 * 1000;

const BIAS_BY_STATE = { AI_BULLISH: "bullish", AI_BEARISH: "bearish", AI_NEUTRAL: "neutral" };

// Duplica de propósito as ~4 linhas de scripts/metricsSampler.js::runContextSample
// (mesmas funções puras dos Brains) em vez de importar dali -- evita qualquer
// risco a um processo que já roda em produção por um ganho de DRY pequeno.
function computeRealContext(db, { symbol, interval }) {
  const market = marketBrain.analyzeMarket(marketBrainData.gatherMarketBrainInputs(db, { symbol, interval }));
  const structure = structureBrain.analyzeStructure(structureBrainData.gatherStructureBrainInputs(db, { symbol, interval }));
  const liquidity = liquidityBrain.analyzeLiquidity(liquidityBrainData.gatherLiquidityBrainInputs(db, { symbol, interval }));
  const fusion = fuseContext({ market, structure, liquidity });

  const nowMs = Date.now();
  const recent = readCandlesFromDb(db, { symbol, interval, sinceMs: nowMs - PRICE_LOOKBACK_MS, untilMs: nowMs });
  const latest = recent.length ? recent[recent.length - 1] : null;

  return {
    market,
    structure,
    liquidity,
    fusion,
    price: latest ? latest.close : null,
    sourceDataTime: latest ? new Date(latest.open_time).toISOString() : null,
  };
}

// INSERT único e atômico -- é isso que garante que uma falha de API nunca
// deixa a série histórica pela metade. Chamada incondicionalmente (sucesso OU
// AI_UNAVAILABLE): aiResult.ai.requestId/contextHash sempre existem, gerados
// no topo de getAssessment antes do loop de providers.
function recordPrediction(db, { aiResult, price, symbol, interval }) {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const row = {
    request_id: aiResult.ai.requestId,
    context_hash: aiResult.ai.contextHash,
    symbol,
    interval,
    t0: nowIso,
    t0_ms: nowMs,
    price_t0: price,
    is_valid_prediction: aiResult.state !== "AI_UNAVAILABLE" ? 1 : 0,
    provider: aiResult.ai.provider,
    model: aiResult.ai.model,
    bias: BIAS_BY_STATE[aiResult.state] || null,
    state: aiResult.state,
    score: aiResult.score,
    confidence: aiResult.confidence,
    risk_flags: JSON.stringify(aiResult.ai.riskFlags || []),
    rationale: aiResult.reasons && aiResult.reasons.length ? aiResult.reasons.join(" | ") : null,
    created_at: nowIso,
    updated_at: nowIso,
  };
  const info = db
    .prepare(
      `INSERT INTO ai_shadow_predictions
         (request_id, context_hash, symbol, interval, t0, t0_ms, price_t0, is_valid_prediction,
          provider, model, bias, state, score, confidence, risk_flags, rationale,
          created_at, updated_at)
       VALUES (@request_id, @context_hash, @symbol, @interval, @t0, @t0_ms, @price_t0, @is_valid_prediction,
               @provider, @model, @bias, @state, @score, @confidence, @risk_flags, @rationale,
               @created_at, @updated_at)`
    )
    .run(row);
  return { id: info.lastInsertRowid, ...row };
}

function findClosestCandle(db, { symbol, interval, targetMs, toleranceMs }) {
  const rows = readCandlesFromDb(db, { symbol, interval, sinceMs: targetMs - toleranceMs, untilMs: targetMs + toleranceMs });
  if (!rows.length) return null;
  return rows.reduce((best, r) => (Math.abs(r.open_time - targetMs) < Math.abs(best.open_time - targetMs) ? r : best));
}

// Concilia horizontes já vencidos com o preço real. `now` é parâmetro
// explícito (default Date.now()) exatamente pra permitir testar a guarda
// anti-look-ahead sem depender do relógio da máquina.
function reconcileDue(db, { symbol, interval, now = Date.now() }) {
  const pending = db
    .prepare(
      `SELECT * FROM ai_shadow_predictions
       WHERE symbol = ? AND interval = ?
         AND (reconciled_t15 = 0 OR reconciled_t30 = 0 OR reconciled_t60 = 0 OR reconciled_t240 = 0)`
    )
    .all(symbol, interval);

  const reconciled = [];
  for (const row of pending) {
    for (const h of HORIZON_MINUTES) {
      if (row[`reconciled_t${h}`]) continue; // já feito -- idempotente
      const dueAtMs = row.t0_ms + h * 60000;
      if (now < dueAtMs) continue; // *** guarda anti-look-ahead: nunca concilia antes do tempo real ter passado ***

      const candle = findClosestCandle(db, { symbol, interval, targetMs: dueAtMs, toleranceMs: RECONCILE_TOLERANCE_MS });
      if (!candle) continue; // gap de dado -- tenta de novo no próximo tick

      const returnPct = ((candle.close - row.price_t0) / row.price_t0) * 100;
      const nowIso = new Date(now).toISOString();
      db.prepare(
        `UPDATE ai_shadow_predictions
         SET price_t${h} = ?, return_pct_t${h} = ?, reconciled_t${h} = 1, reconciled_at_t${h} = ?, updated_at = ?
         WHERE id = ? AND reconciled_t${h} = 0`
      ).run(candle.close, returnPct, nowIso, nowIso, row.id);

      reconciled.push({ id: row.id, horizonMin: h, price: candle.close, returnPct });
    }
  }
  return reconciled;
}

// Chave do cost-guard: script compara isso com o hash do contexto recém
// computado (lib/aiGateway/aiGateway.js::hashContext) antes de gastar uma
// chamada de IA paga.
function getLatestContextHash(db, { symbol, interval }) {
  const row = db
    .prepare(`SELECT context_hash FROM ai_shadow_predictions WHERE symbol = ? AND interval = ? ORDER BY t0_ms DESC LIMIT 1`)
    .get(symbol, interval);
  return row ? row.context_hash : null;
}

module.exports = { HORIZON_MINUTES, computeRealContext, recordPrediction, reconcileDue, getLatestContextHash };

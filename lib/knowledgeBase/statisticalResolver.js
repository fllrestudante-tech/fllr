// Statistical Resolver -- lê o que lib/knowledgeBase/statisticsComputer.js
// já calculou e INTERPRETA (nunca a Storage -- Statistical Fact e
// Statistical Interpretation são camadas separadas de propósito).
// NÃO CONECTADO A NENHUM BRAIN NESTA RODADA -- nenhum *BrainData.js chama
// isto. Existe pra já ter o encaixe certo (mesmo raciocínio de
// lib/knowledgeBase/resolver.js na camada 1) quando houver plano de
// validação via Replay/Experiments confirmado.
//
// Forma de saída: Observation (fato bruto lido, sem julgamento) ->
// Interpretation (nível/direção categórico, ex: "funding está
// extremamente alto") -> Confidence (o quanto confiar nisso) -> Evidence
// (os números concretos por trás do julgamento, pra nunca virar uma
// caixa preta). Um Brain futuro consumiria `interpretation`, nunca
// calcularia percentil/zscore sozinho -- se amanhã o critério mudar de
// percentil pra MAD, só esta função muda, nenhum consumidor.
const { getAssetStatistics } = require("./assetStatisticsStore");

const LEVEL_THRESHOLDS = { extreme: 95, high: 80, low: 20, extremeLow: 5 };

/**
 * Hipótese de 1ª versão, documentada como tal (mesmo espírito de
 * qualquer outro limiar simples já aceito no projeto): baseado em
 * percentil, não em zscore -- percentil já é robusto a outlier por
 * natureza, zscore fica como evidência de apoio, não como critério
 * principal.
 */
function interpretLevel(percentile) {
  if (percentile == null) return { level: null, direction: null };
  if (percentile >= LEVEL_THRESHOLDS.extreme) return { level: "EXTREME", direction: "above" };
  if (percentile >= LEVEL_THRESHOLDS.high) return { level: "HIGH", direction: "above" };
  if (percentile <= LEVEL_THRESHOLDS.extremeLow) return { level: "EXTREME", direction: "below" };
  if (percentile <= LEVEL_THRESHOLDS.low) return { level: "LOW", direction: "below" };
  return { level: "NORMAL", direction: "neutral" };
}

function listAvailableWindows(db, symbol, scope) {
  return db.prepare(`SELECT window_days, sample_size FROM asset_statistics_window WHERE symbol = ? AND statistics_scope = ? ORDER BY window_days ASC`).all(symbol, scope);
}

/**
 * Heurística de 1ª versão, documentada como tal: prefere a janela de 90
 * dias se tiver dado real, senão 30, senão a maior janela disponível com
 * dado, senão a maior janela existente mesmo sem dado (nunca inventa uma
 * janela que não foi computada). Escolha "de verdade" (qual janela prediz
 * melhor) fica pra quando houver validação estatística real via
 * Replay/Experiments -- este é só o encaixe.
 */
function pickDefaultWindow(availableWindows) {
  if (!availableWindows || availableWindows.length === 0) return null;
  const hasData = (w) => w.sample_size > 0;

  const w90 = availableWindows.find((w) => w.window_days === 90 && hasData(w));
  if (w90) return 90;

  const w30 = availableWindows.find((w) => w.window_days === 30 && hasData(w));
  if (w30) return 30;

  const withData = availableWindows.filter(hasData);
  if (withData.length > 0) return withData[withData.length - 1].window_days;

  return availableWindows[availableWindows.length - 1].window_days;
}

function resolveMetricSignal(db, symbol, metric, { scope = "global", windowDays } = {}) {
  let resolvedWindowDays = windowDays;
  if (resolvedWindowDays == null) {
    resolvedWindowDays = pickDefaultWindow(listAvailableWindows(db, symbol, scope));
    if (resolvedWindowDays == null) return null;
  }

  const stats = getAssetStatistics(db, symbol, scope, resolvedWindowDays);
  if (!stats || !stats.metrics[metric]) return null;
  const m = stats.metrics[metric];

  const observation = {
    value: m.current_value,
    zscore: m.zscore_current,
    percentile: m.percentile_current,
    driftPct: m.drift_pct,
    trend: m.trend,
    velocity: m.velocity,
    stabilityScore: m.stability_score,
    compressionExpansion: m.compression_expansion,
  };

  const interpretation = interpretLevel(observation.percentile);

  const confidence = { value: m.confidence, quality: m.quality };

  const evidence = {
    percentile: observation.percentile,
    zscore: observation.zscore,
    sampleSize: m.sample_size,
    windowDaysUsed: resolvedWindowDays,
  };

  return { observation, interpretation, confidence, evidence };
}

module.exports = { resolveMetricSignal, pickDefaultWindow, listAvailableWindows };

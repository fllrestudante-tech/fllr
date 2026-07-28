// Statistical Resolver -- lê o que lib/knowledgeBase/statisticsComputer.js
// já calculou e devolve num formato pronto pro que um Brain consumiria.
// NÃO CONECTADO A NENHUM BRAIN NESTA RODADA -- nenhum *BrainData.js chama
// isto. Existe pra já ter o encaixe certo (mesmo raciocínio de
// lib/knowledgeBase/resolver.js na camada 1) quando houver plano de
// validação via Replay/Experiments confirmado.
const { getAssetStatistics } = require("./assetStatisticsStore");

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

  return {
    value: m.current_value,
    zscore: m.zscore_current,
    percentile: m.percentile_current,
    driftPct: m.drift_pct,
    trend: m.trend,
    velocity: m.velocity,
    stabilityScore: m.stability_score,
    compressionExpansion: m.compression_expansion,
    quality: m.quality,
    confidence: m.confidence,
    windowDaysUsed: resolvedWindowDays,
  };
}

module.exports = { resolveMetricSignal, pickDefaultWindow, listAvailableWindows };

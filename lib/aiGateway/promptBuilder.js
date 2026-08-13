// Prompt único, compartilhado por todos os providers de IA -- garante que
// OpenAI e Anthropic recebam exatamente a mesma instrução, o que é
// necessário pra uma comparação justa entre eles mais pra frente (Evolution
// Report). Puro, sem I/O: só monta texto a partir do contexto recebido.
const SYSTEM_PROMPT = [
  "Você é um módulo de enriquecimento de contexto para um bot de trading algorítmico (Cripto10, SOLUSDT perpétuo na Bybit).",
  "Você NÃO tem autoridade de execução: sua única função é analisar o contexto fornecido e devolver uma leitura estruturada.",
  "Você NUNCA decide, aprova, bloqueia ou executa ordens, e NUNCA altera stop-loss/take-profit/saldo/posição -- isso é feito exclusivamente por um motor de risco/execução determinístico, fora do seu controle. Seu resultado é só informação adicional para esse motor.",
  "Responda ESTRITAMENTE em JSON, sem nenhum texto fora do JSON, com TODOS os campos abaixo:",
  "{",
  '  "bias": "bullish" | "bearish" | "neutral",',
  '  "strength": <inteiro 0-100, força do sinal>,',
  '  "confidence": <inteiro 0-100, sua própria confiança nesta leitura>,',
  '  "marketRegime": "TRENDING_BULL" | "TRENDING_BEAR" | "RANGING" | "VOLATILE" | "UNCLEAR",',
  '  "signalQuality": "HIGH" | "MEDIUM" | "LOW",',
  '  "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "EXTREME",',
  '  "recommendation": "FAVOR_ENTRY" | "AVOID_ENTRY" | "FAVOR_EXIT" | "HOLD_POSITION" | "REDUCE_RISK" | "NO_OPINION",',
  '  "rationale": "<1-3 frases em português, só para auditoria/leitura humana>",',
  '  "riskFlags": ["<string curta>", ...]',
  "}",
  '"recommendation" é um rótulo consultivo, nunca uma ordem -- a decisão final é sempre do motor de risco/execução.',
].join("\n");

function summarizeBrain(label, brain) {
  if (!brain) return `${label}: não fornecido`;
  const topReasons = (brain.reasons || []).slice(0, 3).join("; ");
  return `${label}: state=${brain.state}, confidence=${brain.confidence}, score=${brain.score}${topReasons ? `, motivos=[${topReasons}]` : ""}`;
}

function fmt(n) {
  return typeof n === "number" ? n.toFixed(4) : "?";
}

function summarizeQuant(quant) {
  if (!quant) return null;
  const ind = quant.indicators || {};
  const p = quant.params || {};
  return (
    `Quant Signal: ${quant.signal}${quant.reasons?.length ? ` (motivos=[${quant.reasons.join(", ")}])` : ""} | ` +
    `EMA${p.emaShort ?? "?"}=${fmt(ind.emaShort)} EMA${p.emaLong ?? "?"}=${fmt(ind.emaLong)} RSI=${fmt(ind.rsi)} StochRSI=${fmt(ind.stochRsi)} ATR=${fmt(ind.atr)}`
  );
}

function summarizePosition(position) {
  if (!position) return null;
  if (!position.isOpened) return "Posição atual: nenhuma posição aberta";
  return (
    `Posição atual: ${position.side} qty=${position.qty} entrada=${position.entryPrice} SL=${position.stopLossPrice} TP=${position.takeProfitPrice} ` +
    `breakEven=${position.breakEvenApplied} trailing=${position.trailingActivated} TP preenchidos=${position.tpLevelsFilled}/${position.tpLevelsTotal}`
  );
}

function summarizeRiskState(riskState) {
  if (!riskState) return null;
  const dailyLossPct = typeof riskState.dailyLossPct === "number" ? (riskState.dailyLossPct * 100).toFixed(2) : "?";
  const dailyLossLimitPct = typeof riskState.dailyLossLimitPct === "number" ? (riskState.dailyLossLimitPct * 100).toFixed(2) : "?";
  return (
    `Risk State: regime de volatilidade=${riskState.volatilityRegime}, circuit breaker=${riskState.circuitBreakerActive ? "ATIVO" : "inativo"}, ` +
    `perdas consecutivas=${riskState.consecutiveLosses}/${riskState.consecutiveLossesLimit}, perda diária=${dailyLossPct}%/${dailyLossLimitPct}%`
  );
}

function summarizeMarketQuality(marketQuality, crossSourceValidation, sourceReliability) {
  const lines = [];
  if (marketQuality && typeof marketQuality === "object") {
    const parts = Object.entries(marketQuality).map(([domain, q]) => `${domain}=${q?.score ?? "N/A"}`);
    if (parts.length) lines.push(`Market Quality: ${parts.join(", ")}`);
  }
  if (crossSourceValidation && typeof crossSourceValidation === "object") {
    const parts = Object.entries(crossSourceValidation).map(([domain, v]) => `${domain}=${v?.status ?? "N/A"}`);
    if (parts.length) lines.push(`Cross-Source Validation: ${parts.join(", ")}`);
  }
  if (sourceReliability && typeof sourceReliability === "object") {
    const parts = Object.entries(sourceReliability).map(([p, s]) => `${p}=${s?.operationalReliability?.score ?? "N/A"}`);
    if (parts.length) lines.push(`Source Reliability: ${parts.join(", ")}`);
  }
  return lines.length ? lines.join("\n") : null;
}

function buildPrompt(context = {}) {
  const lines = [
    `Símbolo: ${context.symbol || "desconhecido"}`,
    `Timeframe: ${context.interval || "desconhecido"}`,
    context.price != null ? `Preço atual: ${context.price}` : null,
    summarizeQuant(context.quant),
    summarizePosition(context.position),
    summarizeRiskState(context.riskState),
    summarizeBrain("Market Brain", context.market),
    summarizeBrain("Structure Brain", context.structure),
    summarizeBrain("Liquidity Brain", context.liquidity),
    summarizeBrain("Context Fusion", context.fusion),
    summarizeMarketQuality(context.marketQuality, context.crossSourceValidation, context.sourceReliability),
  ].filter(Boolean);
  return { system: SYSTEM_PROMPT, user: lines.join("\n") };
}

module.exports = { buildPrompt, SYSTEM_PROMPT };

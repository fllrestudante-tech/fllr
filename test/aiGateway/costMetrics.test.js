const test = require("node:test");
const assert = require("node:assert/strict");
const { computeAiCostMetrics, estimateCostUsd, resolvePricing, extractUsableUsage, extractUsableUsageFromAttempt } = require("../../lib/aiGateway/costMetrics");

const NOW = Date.parse("2026-08-11T22:00:00.000Z");

function iso(hoursAgo) {
  return new Date(NOW - hoursAgo * 60 * 60 * 1000).toISOString();
}

function fallbackSuccessEntry(overrides = {}) {
  return {
    time: iso(1),
    provider: "openai",
    model: "gpt-4o-mini-2024-07-18",
    attempted: ["anthropic", "openai"],
    status: "success",
    usage: { promptTokens: 735, completionTokens: 117 },
    ...overrides,
  };
}

function plainSuccessEntry(overrides = {}) {
  // Sucesso SEM fallback -- attempted tem só o provider vencedor, 0
  // tentativas falhas. Fixture pra cenários "sem nenhuma lacuna de custo",
  // já que fallbackSuccessEntry() tem 1 tentativa falha embutida por design.
  return {
    time: iso(1),
    provider: "openai",
    model: "gpt-4o-mini-2024-07-18",
    attempted: ["openai"],
    status: "success",
    usage: { promptTokens: 302, completionTokens: 80 },
    ...overrides,
  };
}

function noProviderEntry(overrides = {}) {
  return { time: iso(1), provider: null, model: null, attempted: [], status: "no_provider_available", usage: null, ...overrides };
}

function providerErrorEntry(overrides = {}) {
  return { time: iso(1), provider: null, model: null, attempted: ["anthropic", "openai"], status: "provider_error", usage: null, ...overrides };
}

// --- Cached/reasoning tokens (migração gpt-5.6-luna, 2026-08-13) ---

test("computeAiCostMetrics: agrega AI_CACHED_INPUT_TOKENS_24H/AI_REASONING_TOKENS_24H como subconjuntos, total e por provider", () => {
  const entry = fallbackSuccessEntry({ usage: { promptTokens: 2615, completionTokens: 986, cachedTokens: 500, reasoningTokens: 20 } });
  const m = computeAiCostMetrics({ now: NOW, entries: [entry] });
  assert.equal(m.AI_INPUT_TOKENS_24H, 2615);
  assert.equal(m.AI_CACHED_INPUT_TOKENS_24H, 500);
  assert.equal(m.AI_OUTPUT_TOKENS_24H, 986);
  assert.equal(m.AI_REASONING_TOKENS_24H, 20);
  assert.equal(m.byProvider.openai.cachedInputTokens, 500);
  assert.equal(m.byProvider.openai.reasoningTokens, 20);
});

test("computeAiCostMetrics: usage sem cachedTokens/reasoningTokens (log antigo, pré-migração) não quebra e conta como 0", () => {
  const entry = fallbackSuccessEntry({ usage: { promptTokens: 100, completionTokens: 50 } }); // sem os campos novos
  const m = computeAiCostMetrics({ now: NOW, entries: [entry] });
  assert.equal(m.AI_CACHED_INPUT_TOKENS_24H, 0);
  assert.equal(m.AI_REASONING_TOKENS_24H, 0);
});

// --- Bloqueador 1: assessment x tentativa de provider ---

test("computeAiCostMetrics: fallback (anthropic falha -> openai sucesso) = 1 assessment + 2 tentativas (1 falha + 1 sucesso)", () => {
  const m = computeAiCostMetrics({ now: NOW, entries: [fallbackSuccessEntry()] });
  assert.equal(m.AI_ASSESSMENTS_24H, 1);
  assert.equal(m.AI_ASSESSMENTS_24H_SUCCESS, 1);
  assert.equal(m.AI_PROVIDER_ATTEMPTS_24H, 2);
  assert.equal(m.AI_PROVIDER_ATTEMPTS_24H_SUCCESS, 1);
  assert.equal(m.AI_PROVIDER_ATTEMPTS_24H_FAILED, 1);
  assert.equal(m.byProvider.anthropic.attempts, 1);
  assert.equal(m.byProvider.anthropic.failedAttempts, 1);
  assert.equal(m.byProvider.anthropic.successAttempts, 0);
  assert.equal(m.byProvider.openai.attempts, 1);
  assert.equal(m.byProvider.openai.successAttempts, 1);
});

test("computeAiCostMetrics: no_provider_available = 1 assessment + 0 tentativas", () => {
  const m = computeAiCostMetrics({ now: NOW, entries: [noProviderEntry()] });
  assert.equal(m.AI_ASSESSMENTS_24H, 1);
  assert.equal(m.AI_ASSESSMENTS_24H_NO_PROVIDER, 1);
  assert.equal(m.AI_PROVIDER_ATTEMPTS_24H, 0);
  assert.deepEqual(m.byProvider, {});
});

test("computeAiCostMetrics: provider_error (todos falharam) conta as tentativas como falha, não soma no sucesso", () => {
  const m = computeAiCostMetrics({ now: NOW, entries: [providerErrorEntry()] });
  assert.equal(m.AI_ASSESSMENTS_24H, 1);
  assert.equal(m.AI_ASSESSMENTS_24H_PROVIDER_ERROR, 1);
  assert.equal(m.AI_PROVIDER_ATTEMPTS_24H, 2);
  assert.equal(m.AI_PROVIDER_ATTEMPTS_24H_SUCCESS, 0);
  assert.equal(m.AI_PROVIDER_ATTEMPTS_24H_FAILED, 2);
  assert.equal(m.byProvider.anthropic.failedAttempts, 1);
  assert.equal(m.byProvider.openai.failedAttempts, 1);
});

test("computeAiCostMetrics: 3 assessments (fallback + no_provider + provider_error) somam corretamente sem se confundir", () => {
  const m = computeAiCostMetrics({ now: NOW, entries: [fallbackSuccessEntry(), noProviderEntry(), providerErrorEntry()] });
  assert.equal(m.AI_ASSESSMENTS_24H, 3);
  assert.equal(m.AI_PROVIDER_ATTEMPTS_24H, 4); // 2 (fallback) + 0 (no_provider) + 2 (provider_error)
});

// --- Bloqueador 2: preço/tokens desconhecidos ---

test("computeAiCostMetrics: model sem preço configurado marca AI_COST_ESTIMATE_INCOMPLETE e não fabrica custo, mas soma tokens", () => {
  const m = computeAiCostMetrics({
    now: NOW,
    entries: [fallbackSuccessEntry({ model: "modelo-desconhecido-v9", provider: "openai" })],
  });
  assert.equal(m.AI_COST_ESTIMATE_INCOMPLETE, true);
  assert.equal(m.AI_UNPRICED_ATTEMPTS_24H, 1);
  assert.equal(m.AI_COST_ESTIMATE_24H, 0); // nenhum preço conhecido -- não inventa
  assert.equal(m.AI_INPUT_TOKENS_24H, 735); // tokens reais continuam contados
  assert.deepEqual(m.unpricedModels, ["openai:modelo-desconhecido-v9"]);
});

test("computeAiCostMetrics: sucesso sem usage no log marca AI_MISSING_TOKEN_USAGE_24H, não conta como tentativa sem custo silenciosa", () => {
  const m = computeAiCostMetrics({ now: NOW, entries: [fallbackSuccessEntry({ usage: null })] });
  assert.equal(m.AI_COST_ESTIMATE_INCOMPLETE, true);
  assert.equal(m.AI_MISSING_TOKEN_USAGE_24H, 1);
  assert.equal(m.AI_INPUT_TOKENS_24H, 0);
  assert.equal(m.byProvider.openai.missingUsageAttempts, 1);
});

test("computeAiCostMetrics: sem nenhuma lacuna (sucesso sem fallback, 0 tentativas falhas), AI_COST_ESTIMATE_INCOMPLETE fica false", () => {
  const m = computeAiCostMetrics({ now: NOW, entries: [plainSuccessEntry()] });
  assert.equal(m.AI_COST_ESTIMATE_INCOMPLETE, false);
  assert.equal(m.AI_UNPRICED_ATTEMPTS_24H, 0);
  assert.equal(m.AI_MISSING_TOKEN_USAGE_24H, 0);
  assert.equal(m.AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H, 0);
});

// --- Correção de revisão: tentativa falha = custo DESCONHECIDO, nunca $0 silencioso ---

test("computeAiCostMetrics: tentativa Anthropic falha dentro de um fallback marca AI_COST_ESTIMATE_INCOMPLETE=true e AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H=1, mesmo com o assessment tendo sucesso", () => {
  const m = computeAiCostMetrics({ now: NOW, entries: [fallbackSuccessEntry()] });
  assert.equal(m.AI_ASSESSMENTS_24H_SUCCESS, 1); // o assessment em si teve sucesso (via fallback)
  assert.equal(m.AI_COST_ESTIMATE_INCOMPLETE, true); // mas ainda assim é PARCIAL -- a tentativa Anthropic que falhou tem custo desconhecido
  assert.equal(m.AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H, 1);
  assert.equal(m.AI_UNPRICED_ATTEMPTS_24H, 0); // não é problema de preço -- é ausência de dado
  assert.equal(m.AI_MISSING_TOKEN_USAGE_24H, 0); // não é "sucesso sem usage" -- é tentativa que nem chegou a ter usage possível
});

test("computeAiCostMetrics: 7 falhas Anthropic (cenário real do checkpoint) somam em AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H, custo fica com '+' implícito (INCOMPLETE=true)", () => {
  const entries = [];
  for (let i = 0; i < 7; i++) entries.push(fallbackSuccessEntry({ time: iso(1 + i * 0.1) }));
  const m = computeAiCostMetrics({ now: NOW, entries });
  assert.equal(m.AI_ASSESSMENTS_24H, 7);
  assert.equal(m.AI_PROVIDER_ATTEMPTS_24H_FAILED, 7); // as 7 tentativas Anthropic
  assert.equal(m.AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H, 7);
  assert.equal(m.AI_COST_ESTIMATE_INCOMPLETE, true);
  assert.equal(m.byProvider.anthropic.failedAttempts, 7);
  assert.equal(m.byProvider.anthropic.costUsd, 0); // nunca fabrica custo pra tentativa sem usage
  // custo conhecido (só o lado OpenAI que venceu) continua correto -- o
  // "+" é responsabilidade de quem formata pro dashboard, não do cálculo
  assert.ok(m.AI_COST_ESTIMATE_24H > 0);
});

test("computeAiCostMetrics: provider_error (todas as tentativas falham, nenhuma vence) também marca custo como desconhecido, não zero", () => {
  const m = computeAiCostMetrics({ now: NOW, entries: [providerErrorEntry()] });
  assert.equal(m.AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H, 2);
  assert.equal(m.AI_COST_ESTIMATE_INCOMPLETE, true);
  assert.equal(m.AI_COST_ESTIMATE_24H, 0); // nenhum token conhecido -- 0 é o mínimo sabido, não uma afirmação de que custou 0
});

// --- Bloqueador 3: soma por usage válido, não por status ---

test("extractUsableUsage: só depende de usage numérico + provider presentes, não olha status", () => {
  const withUsage = { status: "provider_error", provider: "openai", model: "gpt-4o-mini", usage: { promptTokens: 10, completionTokens: 5 } };
  assert.deepEqual(extractUsableUsage(withUsage), {
    provider: "openai",
    model: "gpt-4o-mini",
    promptTokens: 10,
    completionTokens: 5,
    cachedTokens: 0,
    reasoningTokens: 0,
  });

  assert.equal(extractUsableUsage({ status: "success", provider: "openai", usage: null }), null);
  assert.equal(extractUsableUsage({ status: "success", provider: null, usage: { promptTokens: 1, completionTokens: 1 } }), null);
  assert.equal(extractUsableUsage({ status: "success", provider: "openai", usage: { promptTokens: "x", completionTokens: 1 } }), null);
});

test("computeAiCostMetrics: se uma entrada tiver usage válido mesmo com status != success, ainda soma (regra por usage, não por status)", () => {
  // Cenário hipotético (não ocorre no schema atual, mas a regra não pode
  // depender disso continuar assim pra sempre -- ver comentário de topo do
  // módulo): um registro com status "provider_error" que ainda assim carrega
  // usage válido (ex: formato do log evoluir pra capturar tentativa faturada
  // que falhou depois). Deve ser somado igual a um sucesso.
  const hypothetical = providerErrorEntry({ provider: "openai", model: "gpt-4o-mini-2024-07-18", usage: { promptTokens: 100, completionTokens: 50 } });
  const m = computeAiCostMetrics({ now: NOW, entries: [hypothetical] });
  assert.equal(m.AI_INPUT_TOKENS_24H, 100);
  assert.equal(m.AI_OUTPUT_TOKENS_24H, 50);
  assert.ok(m.AI_COST_ESTIMATE_24H > 0);
});

// --- Preço / matemática de custo ---

test("resolvePricing: casa por prefixo do model versionado", () => {
  assert.deepEqual(resolvePricing("openai", "gpt-4o-mini-2024-07-18"), { inputPer1M: 0.15, cachedInputPer1M: 0.075, outputPer1M: 0.6 });
  assert.deepEqual(resolvePricing("openai", "gpt-5.6-luna"), { inputPer1M: 0.2, cachedInputPer1M: 0.02, outputPer1M: 1.2 });
  assert.deepEqual(resolvePricing("anthropic", "claude-3-5-haiku-20241022"), { inputPer1M: 0.8, outputPer1M: 4.0 });
  assert.deepEqual(resolvePricing("anthropic", "claude-haiku-4-5-20251001"), { inputPer1M: 1.0, outputPer1M: 5.0 });
  assert.equal(resolvePricing("openai", "gpt-5-desconhecido"), null);
  assert.equal(resolvePricing("provider-inexistente", "qualquer"), null);
});

test("estimateCostUsd: matemática exata pro par gpt-4o-mini (735 in / 117 out), sem cache", () => {
  const cost = estimateCostUsd({ provider: "openai", model: "gpt-4o-mini-2024-07-18", promptTokens: 735, completionTokens: 117 });
  const expected = (735 / 1e6) * 0.15 + (117 / 1e6) * 0.6;
  assert.ok(Math.abs(cost - expected) < 1e-12);
});

test("estimateCostUsd: matemática exata pro par gpt-5.6-luna (2615 in / 986 out), sem cache -- mesmos números do teste real comparativo", () => {
  const cost = estimateCostUsd({ provider: "openai", model: "gpt-5.6-luna", promptTokens: 2615, completionTokens: 986 });
  const expected = (2615 / 1e6) * 0.2 + (986 / 1e6) * 1.2;
  assert.ok(Math.abs(cost - expected) < 1e-12);
  assert.ok(Math.abs(cost - 0.001706) < 1e-6); // valor observado no teste real, registrado como baseline
});

test("estimateCostUsd: cachedTokens usa cachedInputPer1M (mais barato), só pro subconjunto em cache", () => {
  // 2560 dos 2616 tokens de entrada vieram do cache -- mesmo cenário real
  // observado com gpt-4o-mini durante o teste comparativo.
  const cost = estimateCostUsd({ provider: "openai", model: "gpt-4o-mini-2024-07-18", promptTokens: 2616, completionTokens: 315, cachedTokens: 2560 });
  const nonCached = 2616 - 2560;
  const expected = (nonCached / 1e6) * 0.15 + (2560 / 1e6) * 0.075 + (315 / 1e6) * 0.6;
  assert.ok(Math.abs(cost - expected) < 1e-12);
  // cache mais barato que entrada normal -- custo com cache deve ser menor
  // que o mesmo cálculo tratando tudo como entrada normal (sem desconto)
  const costWithoutCacheDiscount = (2616 / 1e6) * 0.15 + (315 / 1e6) * 0.6;
  assert.ok(cost < costWithoutCacheDiscount);
});

test("estimateCostUsd: cachedTokens além do preço de cache configurado (ex: anthropic) cobra como entrada normal, nunca inventa desconto", () => {
  const cost = estimateCostUsd({ provider: "anthropic", model: "claude-3-5-haiku-20241022", promptTokens: 100, completionTokens: 10, cachedTokens: 50 });
  const expected = (100 / 1e6) * 0.8 + (10 / 1e6) * 4.0; // sem desconto -- cachedInputPer1M não existe pra esse par
  assert.ok(Math.abs(cost - expected) < 1e-12);
});

test("estimateCostUsd: cachedTokens maior que promptTokens é clampado (nunca gera custo negativo/absurdo)", () => {
  const cost = estimateCostUsd({ provider: "openai", model: "gpt-4o-mini-2024-07-18", promptTokens: 100, completionTokens: 10, cachedTokens: 99999 });
  const expected = (100 / 1e6) * 0.075 + (10 / 1e6) * 0.6; // tudo tratado como cache, nunca "entrada negativa"
  assert.ok(Math.abs(cost - expected) < 1e-12);
});

test("estimateCostUsd: sem pricing/tokens inválidos devolve null, nunca NaN", () => {
  assert.equal(estimateCostUsd({ provider: "openai", model: "desconhecido", promptTokens: 1, completionTokens: 1 }), null);
  assert.equal(estimateCostUsd({ provider: "openai", model: "gpt-4o-mini", promptTokens: null, completionTokens: 1 }), null);
});

// --- Janela de tempo ---

test("computeAiCostMetrics: entradas fora da janela de 24h são ignoradas", () => {
  const dentro = fallbackSuccessEntry({ time: iso(1) });
  const fora = fallbackSuccessEntry({ time: iso(30) });
  const m = computeAiCostMetrics({ now: NOW, windowMs: 24 * 60 * 60 * 1000, entries: [dentro, fora] });
  assert.equal(m.AI_ASSESSMENTS_24H, 1);
});

test("computeAiCostMetrics: isFullWindow=false quando o log mais antigo é mais recente que a janela pedida", () => {
  const m = computeAiCostMetrics({ now: NOW, entries: [fallbackSuccessEntry({ time: iso(3) })] });
  assert.equal(m.isFullWindow, false);
  assert.equal(m.sampleWindowHours, 3);
});

test("computeAiCostMetrics: isFullWindow=true quando existe log mais antigo que a janela pedida", () => {
  const m = computeAiCostMetrics({ now: NOW, entries: [fallbackSuccessEntry({ time: iso(48) })] });
  assert.equal(m.isFullWindow, true);
  assert.equal(m.sampleWindowHours, 24);
});

test("computeAiCostMetrics: log vazio/inexistente não lança, devolve zeros honestos", () => {
  const m = computeAiCostMetrics({ now: NOW, entries: [] });
  assert.equal(m.AI_ASSESSMENTS_24H, 0);
  assert.equal(m.AI_COST_ESTIMATE_24H, 0);
  assert.equal(m.isFullWindow, false);
  assert.deepEqual(m.byProvider, {});
});

test("computeAiCostMetrics: linhas JSON corrompidas no arquivo real não derrubam o cálculo (readAssessmentLines filtra)", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmpFile = path.join(os.tmpdir(), `ai-assessments-test-${Date.now()}.jsonl`);
  fs.writeFileSync(tmpFile, JSON.stringify(fallbackSuccessEntry()) + "\n" + "{linha corrompida" + "\n");
  try {
    const { readAssessmentLines } = require("../../lib/aiGateway/costMetrics");
    const lines = readAssessmentLines(tmpFile);
    assert.equal(lines.length, 1);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// --- providerAttempts (formato novo) -- parse_error, cache-write, anti-dupla-contagem, regressão legada ---

test("computeAiCostMetrics: parse_error COM usage conhecido não aumenta AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H", () => {
  const entry = {
    time: new Date(NOW).toISOString(),
    status: "success",
    provider: "anthropic",
    providerAttempts: [
      { provider: "agentrouter", status: "parse_error", model: "gpt-5.6-sol", usage: { promptTokens: 100, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
      { provider: "anthropic", status: "success", model: "claude-haiku-4-5", usage: { promptTokens: 50, completionTokens: 10, cachedTokens: 0, reasoningTokens: 0 } },
    ],
  };
  const m = computeAiCostMetrics({ now: NOW, entries: [entry] });
  assert.equal(m.AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H, 0);
});

test("computeAiCostMetrics: parse_error SEM usage aumenta AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H", () => {
  const entry = {
    time: new Date(NOW).toISOString(),
    status: "provider_error",
    providerAttempts: [{ provider: "agentrouter", status: "parse_error", model: null, usage: null }],
  };
  const m = computeAiCostMetrics({ now: NOW, entries: [entry] });
  assert.equal(m.AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H, 1);
  assert.equal(m.AI_COST_ESTIMATE_INCOMPLETE, true);
});

test("computeAiCostMetrics: formato novo NÃO conta duas vezes um provider (attempted legado ignorado quando providerAttempts existe)", () => {
  const entry = {
    time: new Date(NOW).toISOString(),
    status: "success",
    provider: "anthropic",
    attempted: ["agentrouter", "anthropic"], // campo legado presente, mas providerAttempts tem prioridade
    providerAttempts: [
      { provider: "agentrouter", status: "parse_error", usage: null },
      { provider: "anthropic", status: "success", model: "claude-haiku-4-5", usage: { promptTokens: 50, completionTokens: 10, cachedTokens: 0, reasoningTokens: 0 } },
    ],
  };
  const m = computeAiCostMetrics({ now: NOW, entries: [entry] });
  assert.equal(m.byProvider.anthropic.attempts, 1);
  assert.equal(m.AI_PROVIDER_ATTEMPTS_24H, 2);
});

test("computeAiCostMetrics: cacheWriteTokens somado no acumulador global e por provider", () => {
  const entry = {
    time: new Date(NOW).toISOString(),
    status: "success",
    provider: "agentrouter",
    providerAttempts: [
      { provider: "agentrouter", status: "success", model: "gpt-5.6-sol", usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 0, cacheWriteTokens: 30, reasoningTokens: 0 } },
    ],
  };
  const m = computeAiCostMetrics({ now: NOW, entries: [entry] });
  assert.equal(m.AI_CACHE_WRITE_INPUT_TOKENS_24H, 30);
  assert.equal(m.byProvider.agentrouter.cacheWriteInputTokens, 30);
});

test("computeAiCostMetrics: unpricedModels usa modelRequested só quando model efetivo está ausente, nunca resolve pricing com ele", () => {
  const entry = {
    time: new Date(NOW).toISOString(),
    status: "provider_error",
    providerAttempts: [
      { provider: "agentrouter", status: "parse_error", modelRequested: "gpt-5.6-sol", model: null, usage: { promptTokens: 10, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
    ],
  };
  const m = computeAiCostMetrics({ now: NOW, entries: [entry] });
  assert.ok(m.unpricedModels.includes("agentrouter:gpt-5.6-sol (requested_unverified)"));
});

test("extractUsableUsageFromAttempt: rejeita negativo/NaN/Infinity em promptTokens/completionTokens", () => {
  assert.equal(extractUsableUsageFromAttempt({ provider: "agentrouter", usage: { promptTokens: -1, completionTokens: 5 } }), null);
  assert.equal(extractUsableUsageFromAttempt({ provider: "agentrouter", usage: { promptTokens: NaN, completionTokens: 5 } }), null);
  assert.equal(extractUsableUsageFromAttempt({ provider: "agentrouter", usage: { promptTokens: Infinity, completionTokens: 5 } }), null);
  assert.equal(extractUsableUsageFromAttempt({ provider: "agentrouter", usage: { promptTokens: 10, completionTokens: -5 } }), null);
});

test("extractUsableUsageFromAttempt: aceita usage válido com os 5 campos, inclusive cacheWriteTokens", () => {
  const valid = extractUsableUsageFromAttempt({
    provider: "agentrouter",
    model: "gpt-5.6-sol",
    usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 2, cacheWriteTokens: 3, reasoningTokens: 0 },
  });
  assert.deepEqual(valid, { provider: "agentrouter", model: "gpt-5.6-sol", promptTokens: 10, completionTokens: 5, cachedTokens: 2, cacheWriteTokens: 3, reasoningTokens: 0 });
});

test("extractUsableUsageFromAttempt: campos opcionais ausentes/negativos/NaN caem pro default 0, nunca propagam valor inválido", () => {
  const semOpcionais = extractUsableUsageFromAttempt({ provider: "agentrouter", usage: { promptTokens: 10, completionTokens: 5 } });
  assert.equal(semOpcionais.cachedTokens, 0);
  assert.equal(semOpcionais.cacheWriteTokens, 0);
  assert.equal(semOpcionais.reasoningTokens, 0);

  const invalidos = extractUsableUsageFromAttempt({ provider: "agentrouter", usage: { promptTokens: 10, completionTokens: 5, cachedTokens: -1, cacheWriteTokens: NaN, reasoningTokens: Infinity } });
  assert.equal(invalidos.cachedTokens, 0);
  assert.equal(invalidos.cacheWriteTokens, 0);
  assert.equal(invalidos.reasoningTokens, 0);
});

test("REGRESSÃO: entrada 100% legada produz exatamente os mesmos números de antes, incluindo AI_CACHE_WRITE_INPUT_TOKENS_24H=0", () => {
  const entry = {
    time: new Date(NOW).toISOString(),
    status: "success",
    provider: "openai",
    model: "gpt-4o-mini-2024-07-18",
    attempted: ["openai"],
    usage: { promptTokens: 735, completionTokens: 117 },
  };
  const m = computeAiCostMetrics({ now: NOW, entries: [entry] });
  assert.equal(m.AI_INPUT_TOKENS_24H, 735);
  assert.equal(m.AI_OUTPUT_TOKENS_24H, 117);
  assert.equal(m.AI_CACHE_WRITE_INPUT_TOKENS_24H, 0);
  assert.ok(m.AI_COST_ESTIMATE_24H > 0);
  assert.equal(m.byProvider.openai.attempts, 1);
});

test("REGRESSÃO: extractUsableUsage (legada) mantém o shape EXATO de antes -- sem cacheWriteTokens", () => {
  const withUsage = { status: "provider_error", provider: "openai", model: "gpt-4o-mini", usage: { promptTokens: 10, completionTokens: 5 } };
  assert.deepEqual(extractUsableUsage(withUsage), {
    provider: "openai",
    model: "gpt-4o-mini",
    promptTokens: 10,
    completionTokens: 5,
    cachedTokens: 0,
    reasoningTokens: 0,
  });
});

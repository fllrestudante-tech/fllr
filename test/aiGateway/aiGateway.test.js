const test = require("node:test");
const assert = require("node:assert/strict");
const { getAssessment, computeContextCompleteness, hashContext, sanitizeErrorCode } = require("../../lib/aiGateway/aiGateway");

function fakeProvider(name, { normalized, shouldThrow } = {}) {
  return {
    provider: {
      name,
      callProvider: async () => {
        if (shouldThrow) throw new Error(`${name} indisponível`);
        return { raw: true };
      },
      normalize: () => normalized,
    },
    client: {},
    hasKey: () => true,
  };
}

function fakeProviderNoKey(name) {
  return { provider: { name, callProvider: async () => ({}), normalize: () => ({}) }, client: {}, hasKey: () => false };
}

const bullishAssessment = { bias: "bullish", strength: 70, rationale: "alta forte", riskFlags: [], parseError: null, model: "m1", usage: null, rawResponseText: "{}" };
const bearishAssessment = { bias: "bearish", strength: 55, rationale: "queda", riskFlags: ["baixa liquidez"], parseError: null, model: "m2", usage: null, rawResponseText: "{}" };

test("getAssessment: primário responde -> BrainResult AI_BULLISH com provider correto e loga sucesso", async () => {
  const logs = [];
  const result = await getAssessment(
    { symbol: "SOLUSDT", market: { state: "X", confidence: 1, score: 1, reasons: [] } },
    {
      providers: { openai: fakeProvider("openai", { normalized: bullishAssessment }), anthropic: fakeProvider("anthropic", { normalized: bearishAssessment }) },
      primaryProvider: "openai",
      secondaryProvider: "anthropic",
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.state, "AI_BULLISH");
  assert.equal(result.score, 70);
  assert.equal(result.ai.provider, "openai");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, "success");
  assert.equal(logs[0].provider, "openai");
});

test("getAssessment: primário falha, secundário responde -> cai pro fallback e attempted inclui os dois", async () => {
  const logs = [];
  const result = await getAssessment(
    {},
    {
      providers: { openai: fakeProvider("openai", { shouldThrow: true }), anthropic: fakeProvider("anthropic", { normalized: bearishAssessment }) },
      primaryProvider: "openai",
      secondaryProvider: "anthropic",
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.state, "AI_BEARISH");
  assert.equal(result.ai.provider, "anthropic");
  assert.deepEqual(logs[0].attempted, ["openai", "anthropic"]);
});

test("getAssessment: fallback bem-sucedido ainda registra o motivo da falha do primário no log (não fica escondido)", async () => {
  const logs = [];
  await getAssessment(
    {},
    {
      providers: {
        anthropic: fakeProvider("anthropic", { shouldThrow: true }),
        openai: fakeProvider("openai", { normalized: bullishAssessment }),
      },
      primaryProvider: "anthropic",
      secondaryProvider: "openai",
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(logs[0].status, "success");
  assert.equal(logs[0].provider, "openai");
  assert.ok(logs[0].error.includes("anthropic: anthropic indisponível"));
});

test("getAssessment: ambos falham -> AI_UNAVAILABLE, confidence/score 0, loga provider_error", async () => {
  const logs = [];
  const result = await getAssessment(
    {},
    {
      providers: { openai: fakeProvider("openai", { shouldThrow: true }), anthropic: fakeProvider("anthropic", { shouldThrow: true }) },
      primaryProvider: "openai",
      secondaryProvider: "anthropic",
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.state, "AI_UNAVAILABLE");
  assert.equal(result.confidence, 0);
  assert.equal(result.score, 0);
  assert.equal(logs[0].status, "provider_error");
  assert.ok(logs[0].error.includes("openai"));
  assert.ok(logs[0].error.includes("anthropic"));
});

test("getAssessment: nenhuma key configurada -> no_provider_available sem tentar chamada", async () => {
  const logs = [];
  const result = await getAssessment(
    {},
    {
      providers: { openai: fakeProviderNoKey("openai"), anthropic: fakeProviderNoKey("anthropic") },
      primaryProvider: "openai",
      secondaryProvider: "anthropic",
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.state, "AI_UNAVAILABLE");
  assert.equal(logs[0].status, "no_provider_available");
  assert.deepEqual(logs[0].attempted, []);
});

test("computeContextCompleteness: contexto cheio=100, vazio=0, parcial=fração correta", () => {
  assert.equal(computeContextCompleteness({ market: {}, structure: {}, liquidity: {}, fusion: {} }), 100);
  assert.equal(computeContextCompleteness({}), 0);
  assert.equal(computeContextCompleteness({ market: {}, structure: {} }), 50);
});

test("getAssessment: carrega os campos estruturados novos (confidence/marketRegime/signalQuality/riskLevel/recommendation) em result.ai", async () => {
  const fullNormalized = {
    bias: "bullish",
    strength: 70,
    confidence: 85,
    marketRegime: "TRENDING_BULL",
    signalQuality: "HIGH",
    riskLevel: "LOW",
    recommendation: "FAVOR_ENTRY",
    rationale: "alta forte",
    riskFlags: ["volatilidade baixa"],
    parseError: null,
    model: "m1",
    usage: null,
    rawResponseText: "{}",
  };
  const logs = [];
  const result = await getAssessment(
    {},
    {
      providers: { openai: fakeProvider("openai", { normalized: fullNormalized }) },
      primaryProvider: "openai",
      secondaryProvider: "openai",
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.ai.aiConfidence, 85);
  assert.equal(result.ai.marketRegime, "TRENDING_BULL");
  assert.equal(result.ai.signalQuality, "HIGH");
  assert.equal(result.ai.riskLevel, "LOW");
  assert.equal(result.ai.recommendation, "FAVOR_ENTRY");
  assert.equal(logs[0].assessment.marketRegime, "TRENDING_BULL");
  assert.equal(logs[0].assessment.recommendation, "FAVOR_ENTRY");
});

test("hashContext: mesmo conteúdo em ordem de chaves diferente gera hash idêntico; conteúdo diferente gera hash diferente", () => {
  const a = hashContext({ symbol: "SOLUSDT", price: 1 });
  const b = hashContext({ price: 1, symbol: "SOLUSDT" });
  const c = hashContext({ symbol: "SOLUSDT", price: 2 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// --- providerAttempts / parseError-como-falha / registro único / safeWrite ---

test("getAssessment: parseError no primário NÃO é sucesso -- cai pro secundário", async () => {
  const logs = [];
  const result = await getAssessment(
    { symbol: "SOLUSDT" },
    {
      providers: {
        agentrouter: fakeProvider("agentrouter", {
          normalized: {
            bias: "neutral",
            strength: 0,
            parseError: "invalid_json",
            riskFlags: [],
            usage: { promptTokens: 10, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
            model: "gpt-5.6-sol",
            modelRequested: "gpt-5.6-sol",
            modelAttribution: "requested_unverified",
            rawResponseText: "not json",
          },
        }),
        anthropic: fakeProvider("anthropic", { normalized: bullishAssessment }),
      },
      providerOrder: ["agentrouter", "anthropic"],
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.state, "AI_BULLISH"); // veio do anthropic, não ficou preso no parseError do agentrouter
  assert.equal(result.ai.provider, "anthropic");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].provider, "anthropic");
  assert.equal(logs[0].providerAttempts.length, 2);
  assert.equal(logs[0].providerAttempts[0].provider, "agentrouter");
  assert.equal(logs[0].providerAttempts[0].status, "parse_error");
  assert.deepEqual(logs[0].providerAttempts[0].usage, { promptTokens: 10, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 });
  assert.equal(logs[0].providerAttempts[1].status, "success");
});

test("getAssessment: UM único write por requestId, mesmo com 3 tentativas (error -> parse_error -> success)", async () => {
  const logs = [];
  await getAssessment(
    {},
    {
      providers: {
        agentrouter: fakeProvider("agentrouter", { shouldThrow: true }),
        anthropic: fakeProvider("anthropic", { normalized: { bias: "neutral", strength: 0, parseError: "invalid_json", riskFlags: [], usage: null, model: null } }),
        openai: fakeProvider("openai", { normalized: bearishAssessment }),
      },
      providerOrder: ["agentrouter", "anthropic", "openai"],
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].providerAttempts.length, 3);
  assert.deepEqual(logs[0].providerAttempts.map((a) => a.status), ["error", "parse_error", "success"]);
});

test("getAssessment: buildPrompt() lançando faz o provider virar 'error' e o próximo ser tentado", async () => {
  const logs = [];
  const brokenBuildPrompt = {
    provider: {
      name: "agentrouter",
      buildPrompt: () => {
        throw new Error("prompt quebrado");
      },
      callProvider: async () => ({}),
      normalize: () => bullishAssessment,
    },
    client: {},
    hasKey: () => true,
  };
  const result = await getAssessment(
    {},
    {
      providers: { agentrouter: brokenBuildPrompt, anthropic: fakeProvider("anthropic", { normalized: bearishAssessment }) },
      providerOrder: ["agentrouter", "anthropic"],
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.ai.provider, "anthropic");
  assert.equal(logs[0].providerAttempts[0].provider, "agentrouter");
  assert.equal(logs[0].providerAttempts[0].status, "error");
  assert.ok(logs[0].providerAttempts[0].error.includes("prompt quebrado"));
});

test("getAssessment: buildBrainResult() lançando produz UMA única entrada 'error' pro provider, nunca 'success' + 'error'", async () => {
  const logs = [];
  // riskFlags ausente faz buildBrainResult lançar de verdade (for...of em
  // undefined) -- cenário real de normalize() fora do contrato esperado,
  // não um mock artificial da função interna.
  const brokenNormalized = { bias: "bullish", strength: 70, rationale: "x", riskFlags: undefined, parseError: null, model: "m", usage: null };
  const result = await getAssessment(
    {},
    {
      providers: {
        agentrouter: fakeProvider("agentrouter", { normalized: brokenNormalized }),
        anthropic: fakeProvider("anthropic", { normalized: bearishAssessment }),
      },
      providerOrder: ["agentrouter", "anthropic"],
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.ai.provider, "anthropic"); // agentrouter falhou, caiu pro próximo
  const agentrouterAttempts = logs[0].providerAttempts.filter((a) => a.provider === "agentrouter");
  assert.equal(agentrouterAttempts.length, 1);
  assert.equal(agentrouterAttempts[0].status, "error");
});

test("getAssessment: safeWrite protege o resultado contra logAssessment que lança SÍNCRONO", async () => {
  const result = await getAssessment(
    {},
    {
      providers: { anthropic: fakeProvider("anthropic", { normalized: bullishAssessment }) },
      providerOrder: ["anthropic"],
      logAssessment: () => {
        throw new Error("disco cheio");
      },
    }
  );
  assert.equal(result.state, "AI_BULLISH"); // resultado intacto apesar do log ter lançado
});

test("getAssessment: safeWrite protege o resultado contra logAssessment que devolve Promise REJEITADA", async () => {
  const result = await getAssessment(
    {},
    {
      providers: { anthropic: fakeProvider("anthropic", { normalized: bullishAssessment }) },
      providerOrder: ["anthropic"],
      logAssessment: () => Promise.reject(new Error("writer assíncrono quebrado")),
    }
  );
  assert.equal(result.state, "AI_BULLISH");
});

// --- sanitizeErrorCode / errorCode em providerAttempts ---

test("sanitizeErrorCode: preserva código no formato esperado (ex: AGENTROUTER_EXIT_NONZERO)", () => {
  assert.equal(sanitizeErrorCode({ code: "AGENTROUTER_EXIT_NONZERO" }), "AGENTROUTER_EXIT_NONZERO");
});

test("sanitizeErrorCode: erro sem code produz null", () => {
  assert.equal(sanitizeErrorCode(new Error("x")), null); // Error real, .code nunca setado
  assert.equal(sanitizeErrorCode({}), null);
  assert.equal(sanitizeErrorCode(null), null);
  assert.equal(sanitizeErrorCode(undefined), null);
});

test("sanitizeErrorCode: código fora do formato (minúsculo, espaço, símbolo, tamanho, não-string) é rejeitado", () => {
  assert.equal(sanitizeErrorCode({ code: "agentrouter_exit_nonzero" }), null);
  assert.equal(sanitizeErrorCode({ code: "ERROR WITH SPACE" }), null);
  assert.equal(sanitizeErrorCode({ code: "ERROR;rm -rf /" }), null);
  assert.equal(sanitizeErrorCode({ code: "A".repeat(129) }), null);
  assert.equal(sanitizeErrorCode({ code: 12345 }), null);
});

test("getAssessment: providerAttempts registra errorCode, preservando 'error' por compatibilidade", async () => {
  const logs = [];
  const throwingProvider = {
    provider: {
      name: "agentrouter",
      callProvider: async () => {
        const err = new Error("codex process exited with a non-zero code");
        err.code = "AGENTROUTER_EXIT_NONZERO";
        throw err;
      },
      normalize: () => ({}),
    },
    client: {},
    hasKey: () => true,
  };
  await getAssessment(
    {},
    {
      providers: { agentrouter: throwingProvider, anthropic: fakeProvider("anthropic", { normalized: bearishAssessment }) },
      providerOrder: ["agentrouter", "anthropic"],
      logAssessment: (record) => logs.push(record),
    }
  );
  const attempt = logs[0].providerAttempts[0];
  assert.equal(attempt.errorCode, "AGENTROUTER_EXIT_NONZERO");
  assert.equal(attempt.error, "codex process exited with a non-zero code");
});

test("getAssessment: erro sem .code produz errorCode null, fallback continua funcionando normalmente", async () => {
  const logs = [];
  const result = await getAssessment(
    {},
    {
      providers: { agentrouter: fakeProvider("agentrouter", { shouldThrow: true }), anthropic: fakeProvider("anthropic", { normalized: bearishAssessment }) },
      providerOrder: ["agentrouter", "anthropic"],
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.ai.provider, "anthropic");
  assert.equal(logs[0].providerAttempts[0].errorCode, null);
});

// =====================================================================
// Fase 10 / Commit 4c2 -- gate do orçamento do AgentRouter (identidade +
// wrapper orçamentado). Todo teste abaixo injeta opts.agentRouterGate
// (fakes de dbProvider/policy/createBudgetedClient/realRunAgentRouterPrompt)
// -- ZERO SQLite real, ZERO transporte real, ZERO rede em qualquer teste
// deste bloco (exceto o de isolamento estrutural, que roda em subprocesso
// isolado e nunca chega perto de I/O real -- ver mais abaixo).
// =====================================================================

function validGatedContext(overrides = {}) {
  return {
    symbol: "SOLUSDT",
    interval: "1",
    riskState: { volatilityRegime: "NORMAL" },
    position: { isOpened: false },
    quant: {
      signal: "wait",
      price: 150.5,
      indicators: { emaShort: 150.1, emaLong: 149.8, rsi: 55, stochRsi: 40, obv: 1000, atr: 0.8 },
    },
    ...overrides,
  };
}

function validAssessmentMeta(overrides = {}) {
  return { triggerReason: "quant_signal", lastClosedCandleTimestampMs: 1_756_000_000_000, ...overrides };
}

/** dbProvider fake -- nunca abre nada de verdade, só conta chamadas a closeDb() (fechamento determinístico). */
function fakeDbProvider() {
  const provider = { getDb: () => ({ marker: "fake-db-never-real" }), closeDb: () => {}, closeDbCalls: 0 };
  const realClose = provider.closeDb;
  provider.closeDb = () => {
    provider.closeDbCalls += 1;
    realClose();
  };
  return provider;
}

/** transporte fake que FALHA IMEDIATAMENTE se chamado -- prova de "zero rede" por construção, não por inspeção. */
function neverCallTransport() {
  return async () => {
    throw new Error("POISON: transporte real não deveria ser alcançado neste teste");
  };
}

/** policy/createBudgetedClient fakes que nunca tocam SQLite/rede -- devolvem/lançam exatamente o que o teste configurar. */
function fakeAgentRouterGate({ runAgentRouterPromptImpl } = {}) {
  const dbProvider = fakeDbProvider();
  const createBudgetedClientCalls = [];
  return {
    dbProvider,
    policy: { marker: "fake-policy-never-real" },
    createBudgetedClient: (args) => {
      createBudgetedClientCalls.push(args);
      return { runAgentRouterPrompt: runAgentRouterPromptImpl || (async () => ({ text: "{}", usage: null })) };
    },
    createBudgetedClientCalls,
    realRunAgentRouterPrompt: neverCallTransport(), // nunca chamado DIRETAMENTE -- só createBudgetedClient's fake runAgentRouterPrompt é chamado
  };
}

function fakeAgentRouterProviderEntry(overrides = {}) {
  return {
    provider: { name: "agentrouter", callProvider: async (client, ctx) => client.runAgentRouterPrompt({ system: "sys", user: "usr", model: client.model }), normalize: () => bullishAssessment },
    client: { model: "gpt-5.6-sol", marker: "ORIGINAL_UNWRAPPED_CLIENT" },
    hasKey: () => true,
    ...overrides,
  };
}

test("gate desligado (padrão): objeto de client ORIGINAL chega por identidade de referência ao provider -- nenhum wrapper construído", async () => {
  const originalClient = { model: "gpt-5.6-sol", marker: "ORIGINAL" };
  let receivedClient = null;
  const logs = [];
  await getAssessment(
    validGatedContext(),
    {
      providers: {
        agentrouter: {
          provider: { name: "agentrouter", callProvider: async (client) => { receivedClient = client; return {}; }, normalize: () => bullishAssessment },
          client: originalClient,
          hasKey: () => true,
        },
      },
      providerOrder: ["agentrouter"],
      // agentRouterBudgetEnabled OMITIDO -- default false (config.ai.agentRouterBudgetEnabled)
      assessmentMeta: validAssessmentMeta(), // fornecido "por acidente" -- deve ser ignorado
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(receivedClient, originalClient); // === , nunca um wrapper
  assert.equal(logs[0].providerAttempts[0].status, "success");
  assert.equal(Object.hasOwn(logs[0].providerAttempts[0], "taskClass"), false);
  assert.equal(Object.hasOwn(logs[0].providerAttempts[0], "assessmentKey"), false);
  assert.equal(Object.hasOwn(logs[0].providerAttempts[0], "attemptId"), false);
});

test("gate desligado: erro do agentrouter mantém status:\"error\" e o fallback legado continua (mesmo com assessmentMeta acidental)", async () => {
  const logs = [];
  const result = await getAssessment(
    validGatedContext(),
    {
      providers: { agentrouter: fakeProvider("agentrouter", { shouldThrow: true }), anthropic: fakeProvider("anthropic", { normalized: bearishAssessment }) },
      providerOrder: ["agentrouter", "anthropic"],
      assessmentMeta: validAssessmentMeta(),
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.ai.provider, "anthropic");
  assert.equal(logs[0].providerAttempts[0].status, "error");
  assert.notEqual(logs[0].providerAttempts[0].status, "agentrouter_fatal");
});

test("gate ligado: assessmentMeta ausente -> agentrouter_fatal, nenhum provider seguinte tentado, status superior provider_error", async () => {
  const logs = [];
  const openaiCalls = [];
  const gate = fakeAgentRouterGate();
  const result = await getAssessment(
    validGatedContext(),
    {
      providers: {
        agentrouter: fakeAgentRouterProviderEntry(),
        openai: { provider: { name: "openai", callProvider: async () => { openaiCalls.push(1); return {}; }, normalize: () => bullishAssessment }, client: {}, hasKey: () => true },
      },
      providerOrder: ["agentrouter", "openai"],
      agentRouterBudgetEnabled: true,
      agentRouterGate: gate,
      // assessmentMeta OMITIDO de propósito
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.ai.provider, null);
  assert.equal(logs[0].status, "provider_error");
  assert.deepEqual(logs[0].attempted, ["agentrouter"]); // openai nunca chega a ser "attempted"
  assert.equal(openaiCalls.length, 0);
  assert.equal(logs[0].providerAttempts.length, 1);
  const attempt = logs[0].providerAttempts[0];
  assert.equal(attempt.status, "agentrouter_fatal");
  assert.equal(attempt.errorCode, "MISSING_ASSESSMENT_META");
  assert.equal(attempt.taskClass, null);
  assert.equal(attempt.assessmentKey, null);
  assert.equal(attempt.attemptId, null);
  assert.equal(gate.dbProvider.closeDbCalls, 1); // fechamento determinístico mesmo na falha
  assert.equal(gate.createBudgetedClientCalls.length, 0); // nunca chegou a construir o wrapper
});

test("gate ligado: trigger desconhecido -> agentrouter_fatal com errorCode UNKNOWN_TRIGGER_REASON, fallback não tentado", async () => {
  const logs = [];
  const gate = fakeAgentRouterGate();
  const result = await getAssessment(
    validGatedContext(),
    {
      providers: { agentrouter: fakeAgentRouterProviderEntry(), openai: fakeProvider("openai", { normalized: bullishAssessment }) },
      providerOrder: ["agentrouter", "openai"],
      agentRouterBudgetEnabled: true,
      agentRouterGate: gate,
      assessmentMeta: validAssessmentMeta({ triggerReason: "nunca_visto" }),
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.ai.provider, null);
  assert.equal(logs[0].providerAttempts[0].status, "agentrouter_fatal");
  assert.equal(logs[0].providerAttempts[0].errorCode, "UNKNOWN_TRIGGER_REASON");
  assert.deepEqual(logs[0].attempted, ["agentrouter"]);
});

test("gate ligado: candle ausente/inválido -> agentrouter_fatal com errorCode INVALID_ASSESSMENT_KEY_INPUT", async () => {
  const logs = [];
  const gate = fakeAgentRouterGate();
  await getAssessment(
    validGatedContext(),
    {
      providers: { agentrouter: fakeAgentRouterProviderEntry() },
      providerOrder: ["agentrouter"],
      agentRouterBudgetEnabled: true,
      agentRouterGate: gate,
      assessmentMeta: validAssessmentMeta({ lastClosedCandleTimestampMs: null }),
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(logs[0].providerAttempts[0].status, "agentrouter_fatal");
  assert.equal(logs[0].providerAttempts[0].errorCode, "INVALID_ASSESSMENT_KEY_INPUT");
});

test("gate ligado: context.quant ausente -> agentrouter_fatal com errorCode MISSING_QUANT_FINGERPRINT", async () => {
  const logs = [];
  const gate = fakeAgentRouterGate();
  await getAssessment(
    validGatedContext({ quant: null }),
    {
      providers: { agentrouter: fakeAgentRouterProviderEntry() },
      providerOrder: ["agentrouter"],
      agentRouterBudgetEnabled: true,
      agentRouterGate: gate,
      assessmentMeta: validAssessmentMeta(),
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(logs[0].providerAttempts[0].status, "agentrouter_fatal");
  assert.equal(logs[0].providerAttempts[0].errorCode, "MISSING_QUANT_FINGERPRINT");
});

test("gate ligado: fallbackAllowed===true (orçamento esgotado) -> status \"error\" (NÃO fatal), fallback CONTINUA e pode vencer", async () => {
  const logs = [];
  const gate = fakeAgentRouterGate({
    runAgentRouterPromptImpl: async () => {
      const err = new Error("orçamento esgotado -- mensagem interna nunca deveria aparecer no log sanitizado do caminho fatal (mas este NÃO é o caminho fatal)");
      err.code = "GLOBAL_BUDGET_EXHAUSTED";
      err.fallbackAllowed = true;
      throw err;
    },
  });
  const result = await getAssessment(
    validGatedContext(),
    {
      providers: { agentrouter: fakeAgentRouterProviderEntry(), openai: fakeProvider("openai", { normalized: bullishAssessment }) },
      providerOrder: ["agentrouter", "openai"],
      agentRouterBudgetEnabled: true,
      agentRouterGate: gate,
      assessmentMeta: validAssessmentMeta(),
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.ai.provider, "openai"); // fallback venceu
  assert.deepEqual(logs[0].attempted, ["agentrouter", "openai"]);
  const attempt = logs[0].providerAttempts[0];
  assert.equal(attempt.status, "error"); // nunca "agentrouter_fatal"
  assert.equal(attempt.errorCode, "GLOBAL_BUDGET_EXHAUSTED");
  // G) taskClass/assessmentKey/attemptId preservados mesmo no caminho de fallback permitido
  assert.equal(attempt.taskClass, "normal_analysis");
  assert.match(attempt.assessmentKey, /^ar-ak:v1:[0-9a-f]{64}$/);
  assert.equal(typeof attempt.attemptId, "string");
  // G) openai recebe só seu client/contexto legados -- nunca metadata do agentrouter
  assert.equal(Object.hasOwn(logs[0].providerAttempts[1], "taskClass"), false);
  assert.equal(Object.hasOwn(logs[0].providerAttempts[1], "assessmentKey"), false);
  assert.equal(Object.hasOwn(logs[0].providerAttempts[1], "attemptId"), false);
});

test("gate ligado: fallbackAllowed===false (ex.: claim SQLITE_BUSY) -> agentrouter_fatal, fallback NÃO tentado", async () => {
  const logs = [];
  const openaiCalls = [];
  const gate = fakeAgentRouterGate({
    runAgentRouterPromptImpl: async () => {
      const err = new Error("claim busy -- nunca deve vazar");
      err.code = "ATOMIC_CLAIM_UNAVAILABLE";
      err.fallbackAllowed = false;
      throw err;
    },
  });
  const result = await getAssessment(
    validGatedContext(),
    {
      providers: {
        agentrouter: fakeAgentRouterProviderEntry(),
        openai: { provider: { name: "openai", callProvider: async () => { openaiCalls.push(1); return {}; }, normalize: () => bullishAssessment }, client: {}, hasKey: () => true },
      },
      providerOrder: ["agentrouter", "openai"],
      agentRouterBudgetEnabled: true,
      agentRouterGate: gate,
      assessmentMeta: validAssessmentMeta(),
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.ai.provider, null);
  assert.equal(openaiCalls.length, 0);
  assert.deepEqual(logs[0].attempted, ["agentrouter"]);
  const attempt = logs[0].providerAttempts[0];
  assert.equal(attempt.status, "agentrouter_fatal");
  assert.equal(attempt.errorCode, "ATOMIC_CLAIM_UNAVAILABLE");
  assert.ok(!attempt.error.includes("nunca deve vazar")); // A) mensagem real do erro nunca vaza
  assert.equal(attempt.error, "AgentRouter call rejected: send-intent claim busy"); // mensagem pública fixa
});

test("gate ligado: erro fatal com código desconhecido -> AGENTROUTER_FATAL genérico, mensagem real (com caminho local/SQL/segredo simulado) NUNCA aparece no log", async () => {
  const logs = [];
  // Valor propositalmente NÃO parecido com uma credencial real -- só
  // sensível o bastante (caminho local, SQL, token rotulado como interno)
  // pra provar que o caminho fatal nunca serializa err.message no log.
  const dangerousMessage =
    'falha em C:\\Users\\Universo\\Desktop\\bot-cripto10\\data\\market.db -- DELETE FROM agentrouter_budget_ledger -- internal_token=DO-NOT-LEAK-THIS-INTERNAL-VALUE-1234567890';
  const gate = fakeAgentRouterGate({
    runAgentRouterPromptImpl: async () => {
      const err = new Error(dangerousMessage);
      err.code = "SOME_CODE_NOT_IN_ANY_ALLOWLIST";
      throw err;
    },
  });
  await getAssessment(
    validGatedContext(),
    {
      providers: { agentrouter: fakeAgentRouterProviderEntry() },
      providerOrder: ["agentrouter"],
      agentRouterBudgetEnabled: true,
      agentRouterGate: gate,
      assessmentMeta: validAssessmentMeta(),
      logAssessment: (record) => logs.push(record),
    }
  );
  const attempt = logs[0].providerAttempts[0];
  assert.equal(attempt.status, "agentrouter_fatal");
  assert.equal(attempt.errorCode, "AGENTROUTER_FATAL");
  assert.equal(attempt.error, "AgentRouter call rejected: internal error");
  const serializedLog = JSON.stringify(logs[0]);
  assert.ok(!serializedLog.includes("DO-NOT-LEAK"));
  assert.ok(!serializedLog.includes("C:\\Users"));
  assert.ok(!serializedLog.includes("DELETE FROM"));
  assert.ok(!serializedLog.includes(dangerousMessage));
});

test("gate ligado: caminho fatal ainda é PERSISTIDO pelo fluxo normal de log -- UM write, mesmo formato do fluxo de sucesso/erro legado", async () => {
  const logs = [];
  const gate = fakeAgentRouterGate();
  await getAssessment(
    validGatedContext(),
    {
      providers: { agentrouter: fakeAgentRouterProviderEntry() },
      providerOrder: ["agentrouter"],
      agentRouterBudgetEnabled: true,
      agentRouterGate: gate,
      // assessmentMeta ausente -> fatal garantido
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(logs.length, 1); // exatamente 1 write, igual ao contrato legado
  assert.equal(logs[0].status, "provider_error");
  assert.ok(Array.isArray(logs[0].providerAttempts));
  assert.equal(logs[0].providerAttempts[0].status, "agentrouter_fatal");
});

test("gate ligado: nenhuma exceção escapa de getAssessment() no caminho fatal -- resolve normalmente com AI_UNAVAILABLE", async () => {
  const gate = fakeAgentRouterGate();
  await assert.doesNotReject(() =>
    getAssessment(validGatedContext(), {
      providers: { agentrouter: fakeAgentRouterProviderEntry() },
      providerOrder: ["agentrouter"],
      agentRouterBudgetEnabled: true,
      agentRouterGate: gate,
      logAssessment: () => {},
    })
  );
});

test("gate ligado: caminho feliz -- providerAttempts carrega taskClass/assessmentKey/attemptId, mas context/prompt/rawResponseText/resultado decisório NUNCA os recebem", async () => {
  const logs = [];
  const gate = fakeAgentRouterGate({
    runAgentRouterPromptImpl: async () => ({ text: JSON.stringify(bullishAssessment), usage: { promptTokens: 10, completionTokens: 5 } }),
  });
  const context = validGatedContext();
  const result = await getAssessment(context, {
    providers: {
      agentrouter: {
        provider: {
          name: "agentrouter",
          buildPrompt: (ctx) => ({ system: "sys", user: JSON.stringify(ctx) }),
          callProvider: async (client) => client.runAgentRouterPrompt({ system: "sys", user: "usr", model: client.model }),
          normalize: (raw) => ({ ...bullishAssessment, rawResponseText: raw.text, usage: raw.usage }),
        },
        client: { model: "gpt-5.6-sol" },
        hasKey: () => true,
      },
    },
    providerOrder: ["agentrouter"],
    agentRouterBudgetEnabled: true,
    agentRouterGate: gate,
    assessmentMeta: validAssessmentMeta(),
    logAssessment: (record) => logs.push(record),
  });

  assert.equal(result.ai.provider, "agentrouter");
  // context original nunca ganhou nenhuma chave nova
  assert.deepEqual(Object.keys(context).sort(), ["interval", "position", "quant", "riskState", "symbol"]);

  const attempt = logs[0].providerAttempts[0];
  assert.equal(attempt.status, "success");
  assert.equal(attempt.taskClass, "normal_analysis");
  assert.match(attempt.assessmentKey, /^ar-ak:v1:[0-9a-f]{64}$/);
  assert.equal(typeof attempt.attemptId, "string");

  // nem prompt nem rawResponseText carregam a identidade do gate
  assert.ok(!logs[0].prompt.user.includes("assessmentKey"));
  assert.ok(!logs[0].prompt.user.includes("taskClass"));
  assert.ok(!(logs[0].rawResponseText || "").includes("assessmentKey"));
  assert.equal(gate.dbProvider.closeDbCalls, 1);
});

// =====================================================================
// Isolamento estrutural do gate desligado -- subprocesso Node ISOLADO
// (mesmo padrão de test/aiGateway/agentRouterBudgetedClient.test.js,
// que já usa child_process.spawn pra testes que exigem estado de
// processo limpo). Prova via require.cache que os módulos pesados
// (SQLite/policy/wrapper/gate) NUNCA chegam a ser carregados com a flag
// desligada -- não só "não usados", carregados de verdade nunca.
// =====================================================================

const { spawnSync } = require("child_process");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");

function gateOffIsolationScript() {
  return `
    const path = require("path");
    const { getAssessment } = require(path.join(process.cwd(), "lib", "aiGateway", "aiGateway.js"));
    async function main() {
      const providers = {
        agentrouter: {
          provider: { name: "agentrouter", callProvider: async () => ({}), normalize: () => ({ bias: "neutral", strength: 0, rationale: "", riskFlags: [], parseError: null, model: null, usage: null, rawResponseText: "{}" }) },
          client: { model: "gpt-5.6-sol" },
          hasKey: () => true,
        },
      };
      await getAssessment({ symbol: "SOLUSDT" }, {
        providers,
        providerOrder: ["agentrouter"],
        agentRouterBudgetEnabled: false,
        logAssessment: () => {},
      });
      const targets = {
        agentRouterBudgetedClient: require.resolve(path.join(process.cwd(), "lib", "aiGateway", "agentRouterBudgetedClient.js")),
        agentRouterBudgetPolicy: require.resolve(path.join(process.cwd(), "lib", "aiGateway", "agentRouterBudgetPolicy.js")),
        agentRouterGate: require.resolve(path.join(process.cwd(), "lib", "aiGateway", "agentRouterGate.js")),
        infraDb: require.resolve(path.join(process.cwd(), "lib", "infra", "db.js")),
      };
      const loaded = {};
      for (const [key, resolved] of Object.entries(targets)) {
        loaded[key] = Object.prototype.hasOwnProperty.call(require.cache, resolved);
      }
      process.stdout.write(JSON.stringify(loaded));
    }
    main().catch((err) => { console.error("SCRIPT_ERROR:" + err.stack); process.exit(1); });
  `;
}

test("ISOLAMENTO ESTRUTURAL (subprocesso limpo): gate desligado nunca carrega agentRouterBudgetedClient/agentRouterBudgetPolicy/agentRouterGate/infra-db", () => {
  const res = spawnSync(process.execPath, ["-e", gateOffIsolationScript()], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(res.status, 0, `subprocesso falhou: ${res.stderr}`);
  const loaded = JSON.parse(res.stdout);
  assert.deepEqual(loaded, {
    agentRouterBudgetedClient: false,
    agentRouterBudgetPolicy: false,
    agentRouterGate: false,
    infraDb: false,
  });
});

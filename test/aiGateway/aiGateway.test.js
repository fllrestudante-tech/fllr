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

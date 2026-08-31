const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { getAssessment, computeContextCompleteness, hashContext, sanitizeErrorCode, DEFAULT_PROVIDERS, isAgentRouterConfigured } = require("../../lib/aiGateway/aiGateway");
const config = require("../../config");
// Provider real (produção) -- usado só no teste de lifecycle/prompt legado
// do gate (mais abaixo) pra capturar o prompt de verdade construído por
// lib/aiGateway/promptBuilder.js, em vez de inventar uma estrutura de
// prompt no teste. Só client.chatCompletion (fronteira de rede) é fake.
const openaiProviderReal = require("../../lib/aiGateway/providers/openaiProvider");

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

/** dbProvider fake -- nunca abre nada de verdade, só conta chamadas a closeDb() (fechamento determinístico).
 * getDb() expõe um `.prepare().get()` mínimo (gasto mensal sempre 0) só pra
 * satisfazer a checagem de teto mensal (agentRouterEnvBudget.js) que roda
 * ANTES da policy fake entrar em cena -- nunca toca SQLite de verdade. */
function fakeDbProvider() {
  const provider = {
    getDb: () => ({ marker: "fake-db-never-real", prepare: () => ({ get: () => ({ total: 0 }) }) }),
    closeDb: () => {},
    closeDbCalls: 0,
  };
  const realClose = provider.closeDb;
  provider.closeDb = () => {
    provider.closeDbCalls += 1;
    realClose();
  };
  return provider;
}

/** env de orçamento fake, válido e coerente (5 USD/dia, 100 USD/mês) -- satisfaz
 * a nova checagem fail-closed de agentRouterEnvBudget.js sem depender de
 * process.env real nem escolher limites de produção. */
function fakeEnvBudget(overrides = {}) {
  return { env: { AGENTROUTER_DAILY_BUDGET_USD: "5", AGENTROUTER_MONTHLY_BUDGET_USD: "100", ...overrides } };
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
    envBudget: fakeEnvBudget(),
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
  // Regressão: caminho NÃO gateado preserva err.message bruto exatamente
  // como sempre foi -- a sanitização nova (fix pós-4c2) só se aplica a
  // isAgentRouterGated && fallbackAllowed===true, nunca aqui.
  assert.equal(logs[0].providerAttempts[0].error, "agentrouter indisponível");
});

// =====================================================================
// CRÍTICO -- achado da re-verificação pós-implementação (round de auditoria
// do coordenador): isAgentRouterGated (usado no loop mais abaixo) SÓ
// controlava se o WRAPPER de orçamento era aplicado -- nunca controlava se
// "agentrouter" era sequer TENTADO. Com AI_PROVIDER_ORDER incluindo
// "agentrouter" (que é exatamente o .env real deste projeto hoje) e
// ~/.codex/config.toml presente, DEFAULT_PROVIDERS.agentrouter.hasKey()
// retornava true mesmo com a flag de orçamento desligada -- o loop de
// getAssessment() chamaria o provider pelo caminho LEGADO/NÃO-GATEADO
// (client cru, sem orçamento), alcançando de verdade
// agentrouterClientWithConfig.runAgentRouterPrompt -> processo Codex CLI
// real. Corrigido em DEFAULT_PROVIDERS.agentrouter.hasKey (agora exige
// config.ai.agentRouterBudgetEnabled). Os testes abaixo traçam a cadeia
// COMPLETA até isAgentRouterConfigured() (a função que checa
// ~/.codex/config.toml, o único portão antes do processo Codex CLI em si),
// não só até o "gate" lógico -- exatamente o cenário real de produção
// (AI_PROVIDER_ORDER=agentrouter,anthropic,openai, config.toml presente).
// =====================================================================

// config.ai.agentRouterBudgetEnabled é uma propriedade de DADO (não
// getter/setter) -- t.mock.method exige uma função de implementação e não
// se aplica aqui; save/restore manual do valor original é o padrão correto
// pra este caso (mesmo efeito de mock, sem a API de mock).
function withAgentRouterBudgetEnabled(value, fn) {
  const original = config.ai.agentRouterBudgetEnabled;
  config.ai.agentRouterBudgetEnabled = value;
  try {
    return fn();
  } finally {
    config.ai.agentRouterBudgetEnabled = original;
  }
}

test("DEFAULT_PROVIDERS.agentrouter.hasKey(): flag de orçamento OFF -> false SEMPRE, mesmo com ~/.codex/config.toml presente (isAgentRouterConfigured()=true simulado)", (t) => {
  t.mock.method(fs, "existsSync", () => true); // simula ~/.codex/config.toml presente
  withAgentRouterBudgetEnabled(false, () => {
    assert.equal(isAgentRouterConfigured(), true, "precondição: config.toml simulado como presente");
    assert.equal(DEFAULT_PROVIDERS.agentrouter.hasKey(), false, "hasKey() deveria ser false com a flag de orçamento desligada, independente de isAgentRouterConfigured()");
  });
});

test("DEFAULT_PROVIDERS.agentrouter.hasKey(): flag de orçamento ON + config.toml presente -> true (comportamento inalterado quando a flag está ligada)", (t) => {
  t.mock.method(fs, "existsSync", () => true);
  withAgentRouterBudgetEnabled(true, () => {
    assert.equal(DEFAULT_PROVIDERS.agentrouter.hasKey(), true);
  });
});

test("getAssessment (produção real, DEFAULT_PROVIDERS, SEM providers/agentRouterGate injetados): providerOrder com agentrouter primeiro + config.toml presente + flag OFF -> ZERO tentativa de agentrouter, prova ATIVA até isAgentRouterConfigured() -- cenário real de produção (.env deste projeto tem AI_PROVIDER_ORDER=agentrouter,anthropic,openai)", async (t) => {
  t.mock.method(fs, "existsSync", () => true); // ~/.codex/config.toml "presente"

  // providerOrder restrito a SÓ "agentrouter" de propósito -- prova exatamente
  // o que precisa ser provado (agentrouter nunca é tentado) sem depender de
  // anthropic/openai não terem chave real configurada no .env deste projeto
  // (que TÊM -- ver .env real), o que arriscaria alcançar callProvider() de
  // um client de rede de verdade se o providerOrder incluísse esses nomes
  // aqui. DEFAULT_PROVIDERS.agentrouter continua sendo o objeto de produção
  // real e não-mockado (só isAgentRouterConfigured()/fs.existsSync acima).
  await withAgentRouterBudgetEnabled(false, async () => {
    const logs = [];
    const result = await getAssessment(
      { symbol: "SOLUSDT", interval: "1", riskState: {}, position: {}, quant: { signal: "wait", price: 1, indicators: {} } },
      {
        providerOrder: ["agentrouter"],
        // providers OMITIDO -- usa DEFAULT_PROVIDERS de verdade (produção real)
        logAssessment: (record) => logs.push(record),
      }
    );

    assert.equal(result.ai.provider, null);
    assert.equal(logs[0].status, "no_provider_available");
    assert.deepEqual(logs[0].attempted, [], "agentrouter não deveria ter sido tentado -- hasKey() teria que ser false");
  });
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

test("gate ligado: fallbackAllowed===true (orçamento esgotado) -> status \"error\" (NÃO fatal), fallback CONTINUA e pode vencer, com gate_close ANTES do próximo provider", async () => {
  const logs = [];
  // Mensagem interna "perigosa" simulada -- caminho local fictício, SQL
  // fictício e texto interno neutro (nunca algo parecido com credencial
  // real), mesmo padrão de test/aiGateway/agentRouterGate.test.js. Prova que
  // NENHUM pedaço disso -- nem a mensagem inteira, nem a stack sintética --
  // sobrevive no caminho de fallback permitido (fallbackAllowed===true),
  // que é DIFERENTE do caminho fatal (já sanitizado desde o 4c2).
  const INTERNAL_ERROR_MESSAGE =
    "orçamento esgotado -- consulta em C:\\Users\\Universo\\Desktop\\bot-cripto10\\data\\market.db -- SELECT balance FROM agentrouter_budget_ledger WHERE window='daily' -- mensagem interna nunca deveria aparecer no log sanitizado (mas este NÃO é o caminho fatal)";
  const INTERNAL_FAKE_STACK = `Error: ${INTERNAL_ERROR_MESSAGE}\n    at fakeInternalLedgerCheck (C:\\Users\\Universo\\Desktop\\bot-cripto10\\lib\\aiGateway\\agentRouterBudgetPolicy.js:999:1)\n    at Object.runAgentRouterPromptImpl (test-fixture:1:1)`;
  const PUBLIC_MESSAGE = "AgentRouter budget is exhausted."; // mensagem pública esperada, mapeada em agentRouterGate.js::KNOWN_FATAL_ERROR_MESSAGES
  // Array de eventos local e determinístico -- prova a ORDEM OBSERVADA nesta
  // execução, registrando cada evento no ponto real do fluxo aguardado por
  // getAssessment() (agentrouter falha -> gate fecha no finally -> só então
  // o próximo provider é chamado), sem depender de relógio/sleep. O
  // isolamento de produção NÃO decorre de Node ser single-threaded (Promises
  // e callbacks podem intercalar execução) -- decorre de cada avaliação
  // gateada criar seu próprio createLazyDbProvider(), nunca compartilhado
  // entre chamadas (ver lib/aiGateway/agentRouterBudgetedClient.js).
  const events = [];
  const gate = fakeAgentRouterGate({
    runAgentRouterPromptImpl: async () => {
      events.push("agentrouter_call");
      const err = new Error(INTERNAL_ERROR_MESSAGE);
      err.stack = INTERNAL_FAKE_STACK; // stack sintética -- prova que nem ela vaza
      err.code = "GLOBAL_BUDGET_EXHAUSTED";
      err.fallbackAllowed = true;
      throw err;
    },
  });
  // Envolve o closeDb() já criado por fakeAgentRouterGate() (mesmo contador
  // closeDbCalls de sempre) só pra também registrar a ORDEM em `events`.
  const originalCloseDb = gate.dbProvider.closeDb;
  gate.dbProvider.closeDb = () => {
    events.push("gate_close");
    originalCloseDb();
  };

  // openai REAL (buildPrompt + callProvider de
  // lib/aiGateway/providers/openaiProvider.js) -- só client.chatCompletion
  // (fronteira de rede) é fake. Prova que o prompt recebido pelo transporte
  // é o prompt legado de produção de verdade, não uma estrutura inventada
  // pelo teste. normalize continua fake (não é o que este teste verifica).
  let capturedCallProviderArgs = null;
  let capturedChatCompletionArgs = null;
  const fakeOpenaiClient = {
    chatCompletion: async ({ system, user }) => {
      capturedChatCompletionArgs = { system, user };
      return { choices: [{ message: { content: JSON.stringify(bullishAssessment) } }], usage: null, model: "gpt-fake-not-a-real-model" };
    },
  };
  const openaiEntry = {
    provider: {
      name: "openai",
      buildPrompt: openaiProviderReal.buildPrompt,
      callProvider: async (client, ctx) => {
        capturedCallProviderArgs = { client, context: ctx };
        events.push("openai_call");
        return openaiProviderReal.callProvider(client, ctx);
      },
      normalize: () => bullishAssessment,
    },
    client: fakeOpenaiClient,
    hasKey: () => true,
  };

  const context = validGatedContext();
  // Cópia profunda determinística -- fixture é 100% JSON-safe (só strings/
  // números/booleans/objetos planos aninhados, confirmado por leitura de
  // validGatedContext() acima), mesmo padrão já usado em
  // test/aiGateway/contextSnapshot.test.js e test/aiGateway/promptBuilderEnglish.test.js.
  const contextBefore = JSON.parse(JSON.stringify(context));

  const result = await getAssessment(
    context,
    {
      providers: { agentrouter: fakeAgentRouterProviderEntry(), openai: openaiEntry },
      providerOrder: ["agentrouter", "openai"],
      agentRouterBudgetEnabled: true,
      agentRouterGate: gate,
      assessmentMeta: validAssessmentMeta(),
      logAssessment: (record) => logs.push(record),
    }
  );

  // Ordem operacional exata e única possível: AgentRouter falha -> gate fecha
  // -> só então OpenAI é chamado.
  assert.deepEqual(events, ["agentrouter_call", "gate_close", "openai_call"]);
  assert.equal(gate.dbProvider.closeDbCalls, 1); // exatamente uma vez, nunca 0 nem 2+

  assert.equal(result.ai.provider, "openai"); // fallback venceu
  assert.deepEqual(logs[0].attempted, ["agentrouter", "openai"]);
  assert.equal(logs[0].providerAttempts.length, 2); // nenhum provider adicional foi chamado
  const attempt = logs[0].providerAttempts[0];
  assert.equal(attempt.status, "error"); // nunca "agentrouter_fatal"
  assert.equal(attempt.errorCode, "GLOBAL_BUDGET_EXHAUSTED"); // código conhecido, preservado (reaproveita sanitizeAgentRouterFatalError)
  assert.equal(attempt.error, PUBLIC_MESSAGE); // mensagem pública exata, nunca err.message
  // G) taskClass/assessmentKey/attemptId preservados mesmo no caminho de fallback permitido
  assert.equal(attempt.taskClass, "normal_analysis");
  assert.match(attempt.assessmentKey, /^ar-ak:v1:[0-9a-f]{64}$/);
  assert.equal(typeof attempt.attemptId, "string");
  // G) openai recebe só seu client/contexto legados -- nunca metadata do agentrouter
  assert.equal(Object.hasOwn(logs[0].providerAttempts[1], "taskClass"), false);
  assert.equal(Object.hasOwn(logs[0].providerAttempts[1], "assessmentKey"), false);
  assert.equal(Object.hasOwn(logs[0].providerAttempts[1], "attemptId"), false);

  // Contexto INTEIRO (não só as chaves de primeiro nível) permanece
  // byte-a-byte idêntico -- detecta mutação em valores ou objetos aninhados,
  // não só chaves novas no topo.
  assert.deepEqual(context, contextBefore);
  assert.deepEqual(Object.keys(context).sort(), ["interval", "position", "quant", "riskState", "symbol"]); // prova complementar, não principal

  // callProvider(client, context) do openai recebeu exatamente o client e o
  // context legados desta chamada -- mesma referência, nenhum wrapper.
  assert.equal(capturedCallProviderArgs.client, fakeOpenaiClient);
  assert.equal(capturedCallProviderArgs.context, context);

  // O prompt recebido pelo transporte é EXATAMENTE o que a função real de
  // produção constrói para este context -- não uma estrutura inventada pelo
  // teste.
  const expectedPrompt = openaiProviderReal.buildPrompt(context);
  assert.deepEqual(capturedChatCompletionArgs, expectedPrompt);

  // O prompt legado não pode conter NADA de metadata do gate (nem os nomes
  // de campo, nem valores, nem a mensagem/stack/SQL/caminho internos
  // simulados) -- lista ampla, porque o prompt é texto puro pra LLM, nunca
  // deveria carregar nenhum destes fragmentos.
  const promptText = capturedChatCompletionArgs.system + "\n" + capturedChatCompletionArgs.user;
  const PROMPT_FORBIDDEN_FRAGMENTS = [
    "assessmentMeta",
    "triggerReason",
    "lastClosedCandleTimestampMs",
    "taskClass",
    "assessmentKey",
    "attemptId",
    attempt.assessmentKey, // valor real do fingerprint/identidade computado nesta chamada
    "GLOBAL_BUDGET_EXHAUSTED",
    INTERNAL_ERROR_MESSAGE,
    INTERNAL_FAKE_STACK,
    "SELECT balance FROM agentrouter_budget_ledger", // fragmento do SQL fictício
    "C:\\Users\\Universo\\Desktop\\bot-cripto10\\data\\market.db", // fragmento do caminho fictício
    "agentRouterBudgetPolicy.js:999:1", // fragmento da stack fictícia
  ];
  for (const forbidden of PROMPT_FORBIDDEN_FRAGMENTS) {
    assert.ok(!promptText.includes(forbidden), `prompt não deveria conter "${forbidden}"`);
  }

  // Resultado final e log persistido: lista ESTRITA -- só o conteúdo
  // sensível de verdade (mensagem/stack/SQL/caminho internos simulados).
  // NÃO inclui taskClass/assessmentKey/attemptId/GLOBAL_BUDGET_EXHAUSTED,
  // porque esses SÃO campos legítimos de providerAttempts[0] por contrato
  // (já asserido acima com valores reais) -- o que não pode acontecer é
  // eles vazarem PRO PRÓXIMO provider (já asserido também, providerAttempts[1]).
  // Esta é a asserção que falhou antes da correção e agora prova que o
  // vazamento foi fechado.
  const LEAK_FORBIDDEN_FRAGMENTS = [
    INTERNAL_ERROR_MESSAGE,
    INTERNAL_FAKE_STACK,
    "SELECT balance FROM agentrouter_budget_ledger",
    "C:\\Users\\Universo\\Desktop\\bot-cripto10\\data\\market.db",
    "agentRouterBudgetPolicy.js:999:1",
  ];
  const serializedResult = JSON.stringify(result);
  const serializedLog = JSON.stringify(logs[0]);
  for (const forbidden of LEAK_FORBIDDEN_FRAGMENTS) {
    assert.ok(!serializedResult.includes(forbidden), `result não deveria conter "${forbidden}"`);
    assert.ok(!serializedLog.includes(forbidden), `log não deveria conter "${forbidden}"`);
  }

  // "razão agregada" -- logs[0].error (nível superior, distinto de
  // providerAttempts[0].error) é a junção de errorMessages -- também precisa
  // usar a mensagem pública, nunca err.message bruto.
  assert.equal(logs[0].error, `agentrouter: ${PUBLIC_MESSAGE}`);
});

test("gate ligado: fallbackAllowed===true com código DESCONHECIDO (fora da allowlist) -> degrada para AGENTROUTER_FATAL genérico, sem vazar a mensagem real, fallback ainda continua", async () => {
  const logs = [];
  const dangerousMessage = "erro interno não catalogado -- caminho C:\\Users\\Universo\\segredo.txt, SQL: DROP TABLE agentrouter_budget_ledger";
  const gate = fakeAgentRouterGate({
    runAgentRouterPromptImpl: async () => {
      const err = new Error(dangerousMessage);
      err.code = "SOME_CODE_NOT_IN_ANY_ALLOWLIST";
      err.fallbackAllowed = true; // fallback permitido, mas código fora da allowlist do sanitizador
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
  assert.equal(result.ai.provider, "openai"); // fallback ainda venceu -- degradar o código não vira fatal
  const attempt = logs[0].providerAttempts[0];
  assert.equal(attempt.status, "error"); // nunca "agentrouter_fatal"
  assert.equal(attempt.errorCode, "AGENTROUTER_FATAL"); // genérico -- mesmo código do caminho fatal pra código desconhecido
  assert.equal(attempt.error, "AgentRouter call rejected: internal error"); // GENERIC_FATAL_ERROR_MESSAGE
  assert.ok(!attempt.error.includes(dangerousMessage));
  assert.equal(logs[0].error, "agentrouter: AgentRouter call rejected: internal error");
  const serializedLog = JSON.stringify(logs[0]);
  assert.ok(!serializedLog.includes(dangerousMessage));
  assert.ok(!serializedLog.includes("segredo.txt"));
  assert.ok(!serializedLog.includes("DROP TABLE"));
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
// gate ligado + agentRouterEnvBudget.js -- camada fail-closed adicional
// (AGENTROUTER_DAILY_BUDGET_USD/AGENTROUTER_MONTHLY_BUDGET_USD), roda ANTES
// de qualquer chamada ao AgentRouter, mesmo com policy/dbProvider fakes
// válidos injetados pelo teste.
// =====================================================================

test("gate ligado: AGENTROUTER_DAILY_BUDGET_USD/AGENTROUTER_MONTHLY_BUDGET_USD ausentes do env -> ZERO chamadas a createBudgetedClient, agentrouter_fatal, fallback não tentado", async () => {
  const logs = [];
  const openaiCalls = [];
  const gate = fakeAgentRouterGate();
  gate.envBudget = { env: {} }; // nenhuma das duas variáveis setada
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
  assert.equal(logs[0].providerAttempts[0].status, "agentrouter_fatal");
  assert.equal(gate.createBudgetedClientCalls.length, 0);
  assert.equal(openaiCalls.length, 0); // caminho fatal PARA o loop, nunca degrada pro próximo provider
});

test("gate ligado: AGENTROUTER_MONTHLY_BUDGET_USD < AGENTROUTER_DAILY_BUDGET_USD (incoerente) -> ZERO chamadas a createBudgetedClient, agentrouter_fatal", async () => {
  const gate = fakeAgentRouterGate();
  gate.envBudget = { env: { AGENTROUTER_DAILY_BUDGET_USD: "10", AGENTROUTER_MONTHLY_BUDGET_USD: "5" } };
  const logs = [];
  const result = await getAssessment(
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
  assert.equal(result.ai.provider, null);
  assert.equal(logs[0].providerAttempts[0].status, "agentrouter_fatal");
  assert.equal(gate.createBudgetedClientCalls.length, 0);
});

test("gate ligado: gasto mensal já esgotado (SUM do ledger >= teto) -> ZERO chamadas a createBudgetedClient, agentrouter_fatal, mesmo com policy/ledger diário fake válidos", async () => {
  const gate = fakeAgentRouterGate();
  gate.dbProvider = {
    getDb: () => ({ prepare: () => ({ get: () => ({ total: 100_000_000 }) }) }), // gasto mensal já no teto
    closeDb: () => {},
    closeDbCalls: 0,
  };
  gate.envBudget = fakeEnvBudget(); // 5 USD/dia, 100 USD/mês -- 100 já gasto = esgotado
  const logs = [];
  const result = await getAssessment(
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
  assert.equal(result.ai.provider, null);
  assert.equal(logs[0].providerAttempts[0].status, "agentrouter_fatal");
  assert.equal(gate.createBudgetedClientCalls.length, 0);
});

// Prova end-to-end com SQLite REAL (não mock de db) -- responde diretamente
// à dúvida "o teto mensal é só validado na config e depois ignorado na
// prática, ou impede de verdade uma reserva?". Usa o MESMO
// runMigrations/schema real do ledger de produção (agentRouterLedger.js),
// insere uma linha 'confirmed' real que já esgota o teto mensal, e confirma
// que getAssessment() nunca chega em createBudgetedClient -- sem nenhum
// stub de `prepare`/`get`.
test("gate ligado: teto mensal REALMENTE aplicado contra um ledger SQLite real (schema de produção, sem nenhum mock de db) -- reserva é impedida de verdade quando o mês já gastou o suficiente", async (t) => {
  const fsReal = require("fs");
  const os = require("os");
  const path = require("path");
  const Database = require("better-sqlite3");
  const { runMigrations, MIGRATIONS_DIR } = require("../../lib/infra/db");

  const dir = fsReal.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-aigw-monthlyreal-"));
  const db = new Database(path.join(dir, "test.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db, MIGRATIONS_DIR);

  const monthStartMs = Date.UTC(2026, 7, 1, 0, 0, 0, 0); // agosto/2026 UTC
  db.prepare(
    `INSERT INTO agentrouter_budget_ledger
      (idempotency_key, correlation_id, model, task_class, status,
       estimated_micros_usd, reserved_micros_usd, confirmed_micros_usd,
       price_source_status, pricing_table_version,
       budget_window_start_ms, budget_window_end_ms, budget_window_timezone,
       created_at, created_at_ms, expires_at_ms)
     VALUES ('real-e2e-key-1', 'real-e2e-corr-1', 'gpt-5.6-sol', 'triage', 'confirmed',
       100000000, 100000000, 100000000,
       'observed', 'v1',
       ?, ?, 'America/Sao_Paulo',
       ?, ?, ?)`
  ).run(monthStartMs, monthStartMs + 86400000, new Date(monthStartMs).toISOString(), monthStartMs, monthStartMs + 300000);

  const gate = fakeAgentRouterGate();
  gate.dbProvider = { getDb: () => db, closeDb: () => db.close(), closeDbCalls: 0 };
  gate.envBudget = { env: { AGENTROUTER_DAILY_BUDGET_USD: "5", AGENTROUTER_MONTHLY_BUDGET_USD: "100" }, nowFn: () => monthStartMs + 5 * 86400000 }; // meio do mesmo mês, mês já gastou 100/100

  try {
    const logs = [];
    const result = await getAssessment(
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
    assert.equal(result.ai.provider, null);
    assert.equal(logs[0].providerAttempts[0].status, "agentrouter_fatal");
    assert.equal(gate.createBudgetedClientCalls.length, 0, "reserva não deveria ter sido tentada -- ledger real já mostra o mês esgotado");
  } finally {
    db.close();
    fsReal.rmSync(dir, { recursive: true, force: true });
  }
});

test("gate ligado: env de orçamento válido e coerente, gasto mensal abaixo do teto -> checagem passa, createBudgetedClient É chamado normalmente (fail-closed não bloqueia o caminho são)", async () => {
  const gate = fakeAgentRouterGate({ runAgentRouterPromptImpl: async () => ({ text: JSON.stringify(bullishAssessment), usage: null }) });
  const logs = [];
  const result = await getAssessment(
    validGatedContext(),
    {
      providers: { agentrouter: fakeAgentRouterProviderEntry({ provider: { name: "agentrouter", callProvider: async (client) => client.runAgentRouterPrompt({}), normalize: (raw) => ({ ...bullishAssessment, rawResponseText: raw.text }) } }) },
      providerOrder: ["agentrouter"],
      agentRouterBudgetEnabled: true,
      agentRouterGate: gate,
      assessmentMeta: validAssessmentMeta(),
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.ai.provider, "agentrouter");
  assert.equal(gate.createBudgetedClientCalls.length, 1);
  assert.equal(logs[0].providerAttempts[0].status, "success");
});

test("gate ligado: dailyMicrosUsd validado é usado pra CONSTRUIR a policy real via createAgentRouterBudgetPolicy quando gateOverrides.policy NÃO é injetado (sem mock de policy, só de db/env)", async () => {
  const dbProvider = fakeDbProvider();
  const createBudgetedClientCalls = [];
  const gate = {
    dbProvider,
    // policy OMITIDA de propósito -- força o código real de
    // buildDailyPolicyOptionsFromMicros + createAgentRouterBudgetPolicy a rodar.
    envBudget: fakeEnvBudget({ AGENTROUTER_DAILY_BUDGET_USD: "1", AGENTROUTER_MONTHLY_BUDGET_USD: "20" }),
    createBudgetedClient: (args) => {
      createBudgetedClientCalls.push(args);
      return { runAgentRouterPrompt: async () => ({ text: JSON.stringify(bullishAssessment), usage: null }) };
    },
    realRunAgentRouterPrompt: neverCallTransport(),
  };
  const logs = [];
  const result = await getAssessment(
    validGatedContext(),
    {
      providers: { agentrouter: fakeAgentRouterProviderEntry({ provider: { name: "agentrouter", callProvider: async (client) => client.runAgentRouterPrompt({}), normalize: (raw) => ({ ...bullishAssessment, rawResponseText: raw.text }) } }) },
      providerOrder: ["agentrouter"],
      agentRouterBudgetEnabled: true,
      agentRouterGate: gate,
      assessmentMeta: validAssessmentMeta(),
      logAssessment: (record) => logs.push(record),
    }
  );
  assert.equal(result.ai.provider, "agentrouter");
  assert.equal(createBudgetedClientCalls.length, 1);
  const policyArg = createBudgetedClientCalls[0].policy;
  assert.equal(typeof policyArg, "object");
  assert.notEqual(policyArg.marker, "fake-policy-never-real"); // é a policy REAL, não um fake injetado
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

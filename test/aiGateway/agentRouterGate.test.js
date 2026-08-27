const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildGatedAgentRouterInvocation,
  sanitizeAgentRouterFatalError,
  MissingQuantFingerprintError,
  MissingAssessmentMetaError,
  GENERIC_FATAL_ERROR_CODE,
  GENERIC_FATAL_ERROR_MESSAGE,
  KNOWN_FATAL_ERROR_MESSAGES,
} = require("../../lib/aiGateway/agentRouterGate");
const { UnknownTriggerReasonError } = require("../../lib/aiGateway/agentRouterTaskClassifier");
const { InvalidAssessmentKeyInputError, InvalidAttemptIdError } = require("../../lib/aiGateway/agentRouterAssessmentKey");

// Transporte/DB/policy SEMPRE fakes -- nenhum teste deste arquivo importa
// lib/agentrouterClient.js, ../infra/db ou ./agentRouterBudgetPolicy.
// realRunAgentRouterPrompt fake FALHA IMEDIATAMENTE se chamado num cenário
// onde não deveria ser alcançado (prova de "zero rede" por construção, não
// por grep).
function neverCallTransport() {
  return async () => {
    throw new Error("POISON: realRunAgentRouterPrompt não deveria ser chamado neste teste");
  };
}

function fakeCreateBudgetedClient(recordedCalls, transportFn) {
  return (args) => {
    recordedCalls.push(args);
    return {
      runAgentRouterPrompt: async (callArgs) => {
        return transportFn(callArgs);
      },
    };
  };
}

function validContext(overrides = {}) {
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

const FIXED_UUID = "11111111-1111-1111-1111-111111111111";

test("caminho feliz: devolve client adaptado, taskClass/assessmentKey/attemptId calculados, metadata fechado por clausura chega ao transporte", async () => {
  const dbProvider = { getDb: () => ({ marker: "fake-db" }), closeDb: () => {} };
  const policy = { marker: "fake-policy" };
  const createCalls = [];
  const transportCalls = [];
  const transportFn = async (callArgs) => {
    transportCalls.push(callArgs);
    return { text: "{}", usage: null };
  };

  const result = buildGatedAgentRouterInvocation({
    context: validContext(),
    assessmentMeta: validAssessmentMeta(),
    baseClient: { model: "gpt-5.6-sol" },
    dbProvider,
    policy,
    createBudgetedClient: fakeCreateBudgetedClient(createCalls, transportFn),
    realRunAgentRouterPrompt: neverCallTransport(), // nunca chamado DIRETAMENTE por este módulo
    timeoutMs: 60000,
    gracefulShutdownMs: 5000,
    codexCommand: "codex",
    nowFn: () => 1_756_000_000_000,
    randomUUIDFn: () => FIXED_UUID,
  });

  assert.equal(typeof result.taskClass, "string");
  assert.equal(result.taskClass, "normal_analysis"); // trigger "quant_signal" -> normal_analysis (Commit 4a)
  assert.match(result.assessmentKey, /^ar-ak:v1:[0-9a-f]{64}$/);
  assert.equal(result.attemptId, FIXED_UUID);
  assert.equal(result.client.model, "gpt-5.6-sol");

  // createBudgetedClient recebeu exatamente dbProvider/policy/transporte/timeouts/nowFn injetados
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].dbProvider, dbProvider);
  assert.equal(createCalls[0].policy, policy);
  assert.equal(createCalls[0].timeoutMs, 60000);
  assert.equal(createCalls[0].gracefulShutdownMs, 5000);
  assert.equal(createCalls[0].codexCommand, "codex");

  // client.runAgentRouterPrompt tem a MESMA assinatura que
  // agentrouterProvider.js chama hoje ({system,user,model}) -- metadata
  // chega ao transporte fake SEM que este teste o tenha passado explicitamente
  await result.client.runAgentRouterPrompt({ system: "sys", user: "usr", model: "gpt-5.6-sol" });
  assert.equal(transportCalls.length, 1);
  assert.equal(transportCalls[0].system, "sys");
  assert.equal(transportCalls[0].user, "usr");
  assert.deepEqual(transportCalls[0].metadata, { assessmentKey: result.assessmentKey, attemptId: result.attemptId, taskClass: result.taskClass });
});

test("assessmentMeta ausente -> MissingAssessmentMetaError, partialAgentRouterIdentity todo null, createBudgetedClient NUNCA chamado", () => {
  const createCalls = [];
  assert.throws(
    () =>
      buildGatedAgentRouterInvocation({
        context: validContext(),
        assessmentMeta: undefined,
        baseClient: { model: "m" },
        dbProvider: { getDb: () => ({}), closeDb: () => {} },
        policy: {},
        createBudgetedClient: fakeCreateBudgetedClient(createCalls, async () => {
          throw new Error("POISON");
        }),
        realRunAgentRouterPrompt: neverCallTransport(),
        timeoutMs: 1,
        gracefulShutdownMs: 1,
        codexCommand: "codex",
      }),
    (err) => {
      assert.ok(err instanceof MissingAssessmentMetaError);
      assert.deepEqual(err.partialAgentRouterIdentity, { taskClass: null, assessmentKey: null, attemptId: null });
      return true;
    }
  );
  assert.equal(createCalls.length, 0);
});

test("assessmentMeta malformado (array/string/número) -> MissingAssessmentMetaError", () => {
  for (const bad of [[], "x", 42, null]) {
    assert.throws(() =>
      buildGatedAgentRouterInvocation({
        context: validContext(),
        assessmentMeta: bad,
        baseClient: { model: "m" },
        dbProvider: { getDb: () => ({}), closeDb: () => {} },
        policy: {},
        createBudgetedClient: () => ({ runAgentRouterPrompt: async () => {} }),
        realRunAgentRouterPrompt: neverCallTransport(),
        timeoutMs: 1,
        gracefulShutdownMs: 1,
        codexCommand: "codex",
      })
    );
  }
});

test("trigger desconhecido -> UnknownTriggerReasonError, partialAgentRouterIdentity todo null", () => {
  assert.throws(
    () =>
      buildGatedAgentRouterInvocation({
        context: validContext(),
        assessmentMeta: validAssessmentMeta({ triggerReason: "algo_nunca_visto" }),
        baseClient: { model: "m" },
        dbProvider: { getDb: () => ({}), closeDb: () => {} },
        policy: {},
        createBudgetedClient: () => ({ runAgentRouterPrompt: async () => {} }),
        realRunAgentRouterPrompt: neverCallTransport(),
        timeoutMs: 1,
        gracefulShutdownMs: 1,
        codexCommand: "codex",
      }),
    (err) => {
      assert.ok(err instanceof UnknownTriggerReasonError);
      assert.deepEqual(err.partialAgentRouterIdentity, { taskClass: null, assessmentKey: null, attemptId: null });
      return true;
    }
  );
});

test("context.quant ausente/null -> MissingQuantFingerprintError (política MAIS ESTRITA que o compat do 4c1), taskClass já computado no partial", () => {
  assert.throws(
    () =>
      buildGatedAgentRouterInvocation({
        context: validContext({ quant: null }),
        assessmentMeta: validAssessmentMeta(),
        baseClient: { model: "m" },
        dbProvider: { getDb: () => ({}), closeDb: () => {} },
        policy: {},
        createBudgetedClient: () => ({ runAgentRouterPrompt: async () => {} }),
        realRunAgentRouterPrompt: neverCallTransport(),
        timeoutMs: 1,
        gracefulShutdownMs: 1,
        codexCommand: "codex",
      }),
    (err) => {
      assert.ok(err instanceof MissingQuantFingerprintError);
      assert.equal(err.partialAgentRouterIdentity.taskClass, "normal_analysis");
      assert.equal(err.partialAgentRouterIdentity.assessmentKey, null);
      assert.equal(err.partialAgentRouterIdentity.attemptId, null);
      return true;
    }
  );
});

test("context.quant malformado (signal inválido) -> propaga InvalidQuantSignalError do módulo do 4c1, inalterado", () => {
  assert.throws(
    () =>
      buildGatedAgentRouterInvocation({
        context: validContext({ quant: { signal: "hold", price: 1, indicators: {} } }),
        assessmentMeta: validAssessmentMeta(),
        baseClient: { model: "m" },
        dbProvider: { getDb: () => ({}), closeDb: () => {} },
        policy: {},
        createBudgetedClient: () => ({ runAgentRouterPrompt: async () => {} }),
        realRunAgentRouterPrompt: neverCallTransport(),
        timeoutMs: 1,
        gracefulShutdownMs: 1,
        codexCommand: "codex",
      }),
    /InvalidQuantSignalError|Invalid quant.signal/
  );
});

test("candle ausente/inválido (lastClosedCandleTimestampMs null) -> InvalidAssessmentKeyInputError, taskClass no partial, assessmentKey/attemptId null", () => {
  assert.throws(
    () =>
      buildGatedAgentRouterInvocation({
        context: validContext(),
        assessmentMeta: validAssessmentMeta({ lastClosedCandleTimestampMs: null }),
        baseClient: { model: "m" },
        dbProvider: { getDb: () => ({}), closeDb: () => {} },
        policy: {},
        createBudgetedClient: () => ({ runAgentRouterPrompt: async () => {} }),
        realRunAgentRouterPrompt: neverCallTransport(),
        timeoutMs: 1,
        gracefulShutdownMs: 1,
        codexCommand: "codex",
      }),
    (err) => {
      assert.ok(err instanceof InvalidAssessmentKeyInputError);
      assert.equal(err.partialAgentRouterIdentity.taskClass, "normal_analysis");
      assert.equal(err.partialAgentRouterIdentity.assessmentKey, null);
      assert.equal(err.partialAgentRouterIdentity.attemptId, null);
      return true;
    }
  );
});

test("createAttemptId falha (randomUUIDFn devolve algo inválido) -> InvalidAttemptIdError, taskClass E assessmentKey já no partial", () => {
  assert.throws(
    () =>
      buildGatedAgentRouterInvocation({
        context: validContext(),
        assessmentMeta: validAssessmentMeta(),
        baseClient: { model: "m" },
        dbProvider: { getDb: () => ({}), closeDb: () => {} },
        policy: {},
        createBudgetedClient: () => ({ runAgentRouterPrompt: async () => {} }),
        realRunAgentRouterPrompt: neverCallTransport(),
        timeoutMs: 1,
        gracefulShutdownMs: 1,
        codexCommand: "codex",
        randomUUIDFn: () => "not-a-uuid",
      }),
    (err) => {
      assert.ok(err instanceof InvalidAttemptIdError);
      assert.equal(err.partialAgentRouterIdentity.taskClass, "normal_analysis");
      assert.match(err.partialAgentRouterIdentity.assessmentKey, /^ar-ak:v1:[0-9a-f]{64}$/);
      assert.equal(err.partialAgentRouterIdentity.attemptId, null);
      return true;
    }
  );
});

// =====================================================================
// sanitizeAgentRouterFatalError -- NUNCA lê err.message/stack; prova com
// mensagens contendo caminho local, SQL e texto parecido com segredo.
// =====================================================================

test("sanitizeAgentRouterFatalError: código conhecido -> mensagem pública FIXA, nunca a mensagem real do erro", () => {
  // Valor propositalmente NÃO parecido com uma credencial real (nunca
  // "sk-..."/formato de chave real de provider) -- só precisa conter
  // conteúdo sensível o bastante (caminho local, SQL, token rotulado como
  // interno) pra provar que o sanitizador não olha pra `err.message`,
  // qualquer que seja o conteúdo.
  const dangerousMessage =
    'SQLite error at C:\\Users\\Universo\\Desktop\\bot-cripto10\\data\\market.db -- INSERT INTO agentrouter_budget_ledger VALUES (...) -- internal_token=DO-NOT-LEAK-THIS-INTERNAL-VALUE-1234567890';
  const err = new Error(dangerousMessage);
  err.code = "ATOMIC_CLAIM_UNAVAILABLE";
  const { errorCode, message } = sanitizeAgentRouterFatalError(err);
  assert.equal(errorCode, "ATOMIC_CLAIM_UNAVAILABLE");
  assert.equal(message, KNOWN_FATAL_ERROR_MESSAGES.ATOMIC_CLAIM_UNAVAILABLE);
  assert.ok(!message.includes("DO-NOT-LEAK"));
  assert.ok(!message.includes("C:\\Users"));
  assert.ok(!message.includes("INSERT INTO"));
  assert.ok(!message.includes(dangerousMessage));
});

test("sanitizeAgentRouterFatalError: código desconhecido (mesmo em formato válido) -> AGENTROUTER_FATAL genérico, mensagem nunca deriva do erro real", () => {
  const err = new Error("/etc/passwd leaked, password=hunter2, stack trace at /home/user/secret");
  err.code = "SOME_UNEXPECTED_CODE_NOT_IN_ALLOWLIST";
  const { errorCode, message } = sanitizeAgentRouterFatalError(err);
  assert.equal(errorCode, GENERIC_FATAL_ERROR_CODE);
  assert.equal(message, GENERIC_FATAL_ERROR_MESSAGE);
  assert.ok(!message.includes("password"));
  assert.ok(!message.includes("/etc/passwd"));
});

test("sanitizeAgentRouterFatalError: sem .code, .code não-string, ou objeto que não é Error -> genérico, nunca lança", () => {
  assert.deepEqual(sanitizeAgentRouterFatalError(new Error("sem code")), { errorCode: GENERIC_FATAL_ERROR_CODE, message: GENERIC_FATAL_ERROR_MESSAGE });
  const errNumCode = new Error("x");
  errNumCode.code = 12345;
  assert.deepEqual(sanitizeAgentRouterFatalError(errNumCode), { errorCode: GENERIC_FATAL_ERROR_CODE, message: GENERIC_FATAL_ERROR_MESSAGE });
  assert.deepEqual(sanitizeAgentRouterFatalError(null), { errorCode: GENERIC_FATAL_ERROR_CODE, message: GENERIC_FATAL_ERROR_MESSAGE });
  assert.deepEqual(sanitizeAgentRouterFatalError("plain string thrown"), { errorCode: GENERIC_FATAL_ERROR_CODE, message: GENERIC_FATAL_ERROR_MESSAGE });
});

test("sanitizeAgentRouterFatalError: código em minúsculo/formato inválido -> genérico (allowlist é estrita, não normaliza caixa)", () => {
  const err = new Error("x");
  err.code = "atomic_claim_unavailable";
  assert.deepEqual(sanitizeAgentRouterFatalError(err), { errorCode: GENERIC_FATAL_ERROR_CODE, message: GENERIC_FATAL_ERROR_MESSAGE });
});

test("sanitizeAgentRouterFatalError: TODOS os códigos conhecidos de todo o pipeline gateado têm entrada na allowlist e nunca colidem com AGENTROUTER_FATAL", () => {
  const codes = Object.keys(KNOWN_FATAL_ERROR_MESSAGES);
  assert.ok(codes.length >= 30);
  assert.ok(!codes.includes(GENERIC_FATAL_ERROR_CODE));
  for (const code of codes) {
    const err = new Error("qualquer coisa");
    err.code = code;
    assert.equal(sanitizeAgentRouterFatalError(err).errorCode, code);
  }
});

// =====================================================================
// GLOBAL_BUDGET_EXHAUSTED / CATEGORY_BUDGET_EXHAUSTED -- os únicos dois
// códigos desta allowlist que NUNCA alcançam o caminho fatal deste módulo
// (classifyPreflightError() em agentRouterBudgetedClient.js já marca
// fallbackAllowed=true pra eles, então em aiGateway.js caem no caminho de
// fallback permitido, não no `break` do "agentrouter_fatal"). Foram
// adicionados aqui só pra permitir que aiGateway.js reaproveite esta MESMA
// função/allowlist nesse caminho, sem duplicar uma segunda tabela de
// mensagens públicas (ver comentário de dívida de nomenclatura acima de
// KNOWN_FATAL_ERROR_MESSAGES).
// =====================================================================

test("sanitizeAgentRouterFatalError: GLOBAL_BUDGET_EXHAUSTED preserva o código e devolve a mensagem pública exata, nunca a mensagem real", () => {
  const dangerousMessage =
    'orçamento estourado -- consulta em C:\\Users\\Universo\\Desktop\\bot-cripto10\\data\\market.db -- SELECT SUM(amount) FROM agentrouter_budget_ledger WHERE window=... -- internal_balance=DO-NOT-LEAK-1234567890';
  const err = new Error(dangerousMessage);
  err.code = "GLOBAL_BUDGET_EXHAUSTED";
  const { errorCode, message } = sanitizeAgentRouterFatalError(err);
  assert.equal(errorCode, "GLOBAL_BUDGET_EXHAUSTED");
  assert.equal(message, "AgentRouter budget is exhausted.");
  assert.equal(message, KNOWN_FATAL_ERROR_MESSAGES.GLOBAL_BUDGET_EXHAUSTED);
  assert.ok(!message.includes("DO-NOT-LEAK"));
  assert.ok(!message.includes("C:\\Users"));
  assert.ok(!message.includes("SELECT SUM"));
  assert.ok(!message.includes(dangerousMessage));
});

test("sanitizeAgentRouterFatalError: CATEGORY_BUDGET_EXHAUSTED preserva o código e devolve a mensagem pública exata, nunca a mensagem real", () => {
  const dangerousMessage = "categoria 'triage' estourada -- reservedMicrosUsd=DO-NOT-LEAK-9988, cap=DO-NOT-LEAK-1122, path=/home/user/.secret";
  const err = new Error(dangerousMessage);
  err.code = "CATEGORY_BUDGET_EXHAUSTED";
  const { errorCode, message } = sanitizeAgentRouterFatalError(err);
  assert.equal(errorCode, "CATEGORY_BUDGET_EXHAUSTED");
  assert.equal(message, "AgentRouter category budget is exhausted.");
  assert.equal(message, KNOWN_FATAL_ERROR_MESSAGES.CATEGORY_BUDGET_EXHAUSTED);
  assert.ok(!message.includes("DO-NOT-LEAK"));
  assert.ok(!message.includes("/home/user/.secret"));
  assert.ok(!message.includes(dangerousMessage));
});

test("sanitizeAgentRouterFatalError: GLOBAL_BUDGET_EXHAUSTED -- mensagens brutas diferentes produzem sempre a MESMA saída pública", () => {
  const err1 = new Error("mensagem completamente diferente A");
  err1.code = "GLOBAL_BUDGET_EXHAUSTED";
  const err2 = new Error("mensagem completamente diferente B, com stack fictícia\n  at foo (/x/y.js:1:1)");
  err2.code = "GLOBAL_BUDGET_EXHAUSTED";
  assert.deepEqual(sanitizeAgentRouterFatalError(err1), sanitizeAgentRouterFatalError(err2));
});

// =====================================================================
// Integração ponta-a-ponta -- SQLite REAL em arquivo temporário, policy
// REAL (Commit 3), createBudgetedAgentRouterClient REAL (Commit 4b).
// Transporte continua SEMPRE fake (zero rede). Mesmo padrão de
// test/aiGateway/agentRouterBudgetedClient.test.js.
// =====================================================================

const fs = require("fs");
const fsPromises = require("fs/promises");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { runMigrations, MIGRATIONS_DIR } = require("../../lib/infra/db");
const realBudgetPolicy = require("../../lib/aiGateway/agentRouterBudgetPolicy");
const { createBudgetedAgentRouterClient } = require("../../lib/aiGateway/agentRouterBudgetedClient");

function createTempDbFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bot-cripto10-gate-${label}-`));
  return { dir, dbPath: path.join(dir, "test.db") };
}

function openTestDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 3000");
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

async function withRealTestDb(label, fn) {
  const { dir, dbPath } = createTempDbFile(label);
  const db = openTestDb(dbPath);
  const dbProvider = { getDb: () => db, closeDb: () => { try { db.close(); } catch { /* ja fechado */ } } };
  try {
    return await fn(db, dbProvider);
  } finally {
    try {
      db.close();
    } catch {
      /* ja pode ter fechado */
    }
    await fsPromises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("integração ponta-a-ponta: SQLite real + policy real + wrapper real -- reserva, claim, transporte fake, contabilização, retorno", async () => {
  await withRealTestDb("happy", async (db, dbProvider) => {
    const policy = realBudgetPolicy.createAgentRouterBudgetPolicy();
    const nowMs = 1_756_000_000_000;

    const result = buildGatedAgentRouterInvocation({
      context: validContext(),
      assessmentMeta: validAssessmentMeta(),
      baseClient: { model: "gpt-5.6-sol" },
      dbProvider,
      policy,
      createBudgetedClient: createBudgetedAgentRouterClient,
      realRunAgentRouterPrompt: async ({ system, user }) => {
        assert.equal(typeof system, "string");
        assert.equal(typeof user, "string");
        return { text: '{"bias":"neutral"}', usage: { input_tokens: 10, output_tokens: 5 } };
      },
      timeoutMs: 60000,
      gracefulShutdownMs: 5000,
      codexCommand: "codex-fake-not-a-real-command",
      nowFn: () => nowMs,
      randomUUIDFn: () => FIXED_UUID,
    });

    const raw = await result.client.runAgentRouterPrompt({ system: "sys", user: "usr", model: "gpt-5.6-sol" });
    assert.equal(raw.text, '{"bias":"neutral"}');

    const row = db.prepare("SELECT * FROM agentrouter_budget_ledger WHERE correlation_id = ?").get(result.assessmentKey);
    assert.ok(row, "linha de ledger deveria existir apos a reserva");
    assert.equal(row.status, "worst_case_charged");
    assert.equal(row.task_class, "normal_analysis");

    dbProvider.closeDb();
  });
});

test("integração: orçamento global esgotado -> GlobalBudgetExhaustedError com fallbackAllowed===true, transporte NUNCA chamado", async () => {
  await withRealTestDb("exhausted", async (db, dbProvider) => {
    // teto operacional 0 -- qualquer reserva estoura o orçamento global imediatamente
    const policy = realBudgetPolicy.createAgentRouterBudgetPolicy({
      nominalCapMicrosUsd: 1_000_000,
      operationalCapMicrosUsd: 0,
      reconciliationMarginMicrosUsd: 1_000_000,
      categoryCapsMicrosUsd: { triage: 0, recurring_analysis: 0, research_innovation: 0, event_review_reserve: 0 },
    });
    const nowMs = 1_756_000_000_000;

    const result = buildGatedAgentRouterInvocation({
      context: validContext(),
      assessmentMeta: validAssessmentMeta(),
      baseClient: { model: "gpt-5.6-sol" },
      dbProvider,
      policy,
      createBudgetedClient: createBudgetedAgentRouterClient,
      realRunAgentRouterPrompt: neverCallTransport(),
      timeoutMs: 60000,
      gracefulShutdownMs: 5000,
      codexCommand: "codex-fake-not-a-real-command",
      nowFn: () => nowMs,
      randomUUIDFn: () => FIXED_UUID,
    });

    await assert.rejects(
      () => result.client.runAgentRouterPrompt({ system: "sys", user: "usr", model: "gpt-5.6-sol" }),
      (err) => {
        assert.equal(err.fallbackAllowed, true);
        assert.equal(err.code, "GLOBAL_BUDGET_EXHAUSTED");
        return true;
      }
    );

    dbProvider.closeDb();
  });
});

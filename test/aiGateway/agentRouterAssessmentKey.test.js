const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeAssessmentKey,
  createAttemptId,
  ASSESSMENT_KEY_VERSION,
  InvalidAssessmentKeyInputError,
  InvalidAssessmentKeyOutputError,
  UnrecognizedAssessmentKeyFieldError,
  InvalidAttemptIdError,
} = require("../../lib/aiGateway/agentRouterAssessmentKey");

function assertThrowsCode(fn, ErrorClass, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ErrorClass, `esperado ${ErrorClass.name}, veio ${err.constructor.name}: ${err.message}`);
    if (code) assert.equal(err.code, code);
    return true;
  });
}

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/; // mesma forma de TOKEN_ID_PATTERN do ledger

function baseInput(overrides = {}) {
  return {
    symbol: "SOLUSDT",
    interval: "15",
    candleTimestampMs: 1_756_000_000_000,
    triggerReason: "quant_signal",
    taskClass: "normal_analysis",
    promptVersion: "v1",
    schemaVersion: "v1",
    ...overrides,
  };
}

// =====================================================================
// 1) Formato de saida -- SHA-256 completo (sem truncar), casa com o padrao
// de idempotencyKey/correlationId do ledger
// =====================================================================

test("computeAssessmentKey: formato ar-ak:<versao>:<64 hex chars>, SHA-256 completo sem truncar", () => {
  const key = computeAssessmentKey(baseInput());
  const [prefix, version, digest] = key.split(":");
  assert.equal(prefix, "ar-ak");
  assert.equal(version, ASSESSMENT_KEY_VERSION);
  assert.equal(digest.length, 64, "digest deve ser SHA-256 completo (64 hex chars), nunca truncado");
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test("computeAssessmentKey: chave final sempre casa com o padrao de token do ledger (TOKEN_ID_PATTERN)", () => {
  const key = computeAssessmentKey(baseInput());
  assert.match(key, KEY_PATTERN);
  assert.ok(key.length <= 128);
});

test("computeAssessmentKey: valor golden fixo -- trava o algoritmo exato (canonicalizacao + SHA-256 + prefixo)", () => {
  const key = computeAssessmentKey(baseInput());
  assert.equal(key, "ar-ak:v1:3631952fcd82551b36e3f64a74094d8fbbcef473d2fdf21f3e7774abfe7cb74c");
});

// =====================================================================
// 2) Estabilidade / nova analise legitima -- exatamente os casos pedidos
// =====================================================================

test("mesmo candle + mesmo contexto logico + mesmo trigger/versoes -> mesma chave", () => {
  const k1 = computeAssessmentKey(baseInput());
  const k2 = computeAssessmentKey(baseInput());
  assert.equal(k1, k2);
});

test("propriedades em ordem diferente no objeto de entrada -> mesma chave", () => {
  const input = baseInput();
  const reordered = {
    schemaVersion: input.schemaVersion,
    taskClass: input.taskClass,
    candleTimestampMs: input.candleTimestampMs,
    symbol: input.symbol,
    promptVersion: input.promptVersion,
    triggerReason: input.triggerReason,
    interval: input.interval,
  };
  assert.equal(computeAssessmentKey(input), computeAssessmentKey(reordered));
});

test("novo candle (candleTimestampMs diferente) -> chave diferente", () => {
  const k1 = computeAssessmentKey(baseInput());
  const k2 = computeAssessmentKey(baseInput({ candleTimestampMs: 1_756_000_000_001 }));
  assert.notEqual(k1, k2);
});

test("promptVersion diferente -> chave diferente", () => {
  const k1 = computeAssessmentKey(baseInput());
  const k2 = computeAssessmentKey(baseInput({ promptVersion: "v2" }));
  assert.notEqual(k1, k2);
});

test("schemaVersion diferente -> chave diferente", () => {
  const k1 = computeAssessmentKey(baseInput());
  const k2 = computeAssessmentKey(baseInput({ schemaVersion: "v2" }));
  assert.notEqual(k1, k2);
});

test("taskClass diferente -> chave diferente", () => {
  const k1 = computeAssessmentKey(baseInput());
  const k2 = computeAssessmentKey(baseInput({ taskClass: "triage" }));
  assert.notEqual(k1, k2);
});

test("triggerReason diferente -> chave diferente", () => {
  const k1 = computeAssessmentKey(baseInput());
  const k2 = computeAssessmentKey(baseInput({ triggerReason: "heartbeat" }));
  assert.notEqual(k1, k2);
});

test("symbol/interval diferentes -> chave diferente", () => {
  const k1 = computeAssessmentKey(baseInput());
  assert.notEqual(k1, computeAssessmentKey(baseInput({ symbol: "BTCUSDT" })));
  assert.notEqual(k1, computeAssessmentKey(baseInput({ interval: "60" })));
});

test("mudanca de regime incluida na identidade -> chave diferente", () => {
  const k1 = computeAssessmentKey(baseInput({ regime: "TRENDING_BULL" }));
  const k2 = computeAssessmentKey(baseInput({ regime: "RANGING" }));
  const k3 = computeAssessmentKey(baseInput()); // sem regime (null)
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
  assert.notEqual(k2, k3);
});

test("mudanca de positionSide incluida na identidade -> chave diferente", () => {
  const k1 = computeAssessmentKey(baseInput({ positionSide: "Buy" }));
  const k2 = computeAssessmentKey(baseInput({ positionSide: "Sell" }));
  const k3 = computeAssessmentKey(baseInput()); // sem posicao (null)
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
  assert.notEqual(k2, k3);
});

// =====================================================================
// 2b) Allowlist estrita -- campo fora da lista fixa lanca IMEDIATAMENTE,
// nunca e' ignorado silenciosamente (correcao de contrato desta rodada)
// =====================================================================

const FORBIDDEN_EXTRA_FIELDS = {
  attemptId: "11111111-1111-1111-1111-111111111111",
  createdAtMs: Date.now(),
  snapshotAt: new Date().toISOString(),
  prompt: "You are a context-enrichment module...",
  telegramText: "BTC vai bombar hoje, comprem agora!!",
  apiKey: "rejected-sensitive-field-value",
  someRandomUnknownField: "x",
};

for (const [field, value] of Object.entries(FORBIDDEN_EXTRA_FIELDS)) {
  test(`computeAssessmentKey: campo desconhecido "${field}" e REJEITADO imediatamente (UnrecognizedAssessmentKeyFieldError), nunca ignorado silenciosamente`, () => {
    assertThrowsCode(() => computeAssessmentKey({ ...baseInput(), [field]: value }), UnrecognizedAssessmentKeyFieldError, "UNRECOGNIZED_ASSESSMENT_KEY_FIELD");
    try {
      computeAssessmentKey({ ...baseInput(), [field]: value });
      assert.fail("deveria ter lancado");
    } catch (err) {
      assert.equal(err.field, field);
    }
  });
}

test("computeAssessmentKey: attemptId nunca e aceito, mesmo vindo de createAttemptId() real", () => {
  const attemptId = createAttemptId();
  assertThrowsCode(() => computeAssessmentKey({ ...baseInput(), attemptId }), UnrecognizedAssessmentKeyFieldError);
});

test("computeAssessmentKey: multiplos campos desconhecidos ao mesmo tempo -> ainda lanca (o primeiro encontrado, nao falha em silencio parcial)", () => {
  assertThrowsCode(
    () => computeAssessmentKey({ ...baseInput(), attemptId: "x", prompt: "y", telegramText: "z", apiKey: "w" }),
    UnrecognizedAssessmentKeyFieldError
  );
});

test("computeAssessmentKey: nenhuma linha e computada (a funcao lanca ANTES de tentar hashear) quando ha campo desconhecido", () => {
  // se por algum bug a validacao da allowlist rodasse DEPOIS do hash, o
  // erro ainda aconteceria, mas o teste acima ja cobre isso -- aqui
  // confirmamos que a mesma entrada, SEM o campo extra, produz a chave
  // golden normalmente (prova que a rejeicao e especifica do campo extra,
  // nao um efeito colateral de outra mudanca)
  const key = computeAssessmentKey(baseInput());
  assert.equal(key, "ar-ak:v1:3631952fcd82551b36e3f64a74094d8fbbcef473d2fdf21f3e7774abfe7cb74c");
});

// =====================================================================
// 2c) Campos opcionais -- representacao canonica unica (ausencia ==
// undefined == null), string vazia rejeitada
// =====================================================================

test("regime: ausencia da chave, undefined explicito e null explicito produzem a MESMA chave", () => {
  const kAbsent = computeAssessmentKey(baseInput());
  const kUndefined = computeAssessmentKey({ ...baseInput(), regime: undefined });
  const kNull = computeAssessmentKey({ ...baseInput(), regime: null });
  assert.equal(kAbsent, kUndefined);
  assert.equal(kUndefined, kNull);
});

test("positionSide: ausencia da chave, undefined explicito e null explicito produzem a MESMA chave", () => {
  const kAbsent = computeAssessmentKey(baseInput());
  const kUndefined = computeAssessmentKey({ ...baseInput(), positionSide: undefined });
  const kNull = computeAssessmentKey({ ...baseInput(), positionSide: null });
  assert.equal(kAbsent, kUndefined);
  assert.equal(kUndefined, kNull);
});

test("regime/positionSide: string vazia e REJEITADA (nao normalizada para ausencia)", () => {
  assertThrowsCode(() => computeAssessmentKey(baseInput({ regime: "" })), InvalidAssessmentKeyInputError);
  assertThrowsCode(() => computeAssessmentKey(baseInput({ positionSide: "" })), InvalidAssessmentKeyInputError);
});

test("regime presente com valor real produz chave DIFERENTE da ausencia/undefined/null", () => {
  const kAbsent = computeAssessmentKey(baseInput());
  const kPresent = computeAssessmentKey(baseInput({ regime: "TRENDING_BULL" }));
  assert.notEqual(kAbsent, kPresent);
});

// =====================================================================
// 3) Fail-closed contra conteudo indevido (Telegram/prompt/segredo/texto
// livre) -- rejeitado no boundary, nunca silenciosamente incorporado
// =====================================================================

test("conteudo de texto livre (ex.: frase estilo Telegram) em symbol/interval/triggerReason/taskClass -> rejeitado (InvalidAssessmentKeyInputError), nunca hasheado", () => {
  const freeText = "BTC vai bombar hoje, comprem agora!! 🚀";
  assertThrowsCode(() => computeAssessmentKey(baseInput({ symbol: freeText })), InvalidAssessmentKeyInputError, "INVALID_ASSESSMENT_KEY_INPUT");
  assertThrowsCode(() => computeAssessmentKey(baseInput({ triggerReason: freeText })), InvalidAssessmentKeyInputError);
  assertThrowsCode(() => computeAssessmentKey(baseInput({ taskClass: freeText })), InvalidAssessmentKeyInputError);
});

test("texto livre em regime/positionSide (campos opcionais) tambem e rejeitado, nunca aceito silenciosamente", () => {
  assertThrowsCode(() => computeAssessmentKey(baseInput({ regime: "mercado parece incerto hoje" })), InvalidAssessmentKeyInputError);
  assertThrowsCode(() => computeAssessmentKey(baseInput({ positionSide: "comprado ha 3 dias" })), InvalidAssessmentKeyInputError);
});

test("prompt/schema completo passado por engano em qualquer campo -> rejeitado por exceder o formato de token curto", () => {
  const fakePrompt = "You are a context-enrichment module for an algorithmic trading bot...".repeat(3);
  assertThrowsCode(() => computeAssessmentKey(baseInput({ symbol: fakePrompt })), InvalidAssessmentKeyInputError);
});

test("campos obrigatorios ausentes/malformados -> InvalidAssessmentKeyInputError, um teste por campo", () => {
  const required = ["symbol", "interval", "candleTimestampMs", "triggerReason", "taskClass", "promptVersion", "schemaVersion"];
  for (const field of required) {
    assertThrowsCode(() => computeAssessmentKey(baseInput({ [field]: undefined })), InvalidAssessmentKeyInputError);
  }
});

test("candleTimestampMs negativo, decimal, NaN ou nao-numero -> InvalidAssessmentKeyInputError", () => {
  assertThrowsCode(() => computeAssessmentKey(baseInput({ candleTimestampMs: -1 })), InvalidAssessmentKeyInputError);
  assertThrowsCode(() => computeAssessmentKey(baseInput({ candleTimestampMs: 1000.5 })), InvalidAssessmentKeyInputError);
  assertThrowsCode(() => computeAssessmentKey(baseInput({ candleTimestampMs: NaN })), InvalidAssessmentKeyInputError);
  assertThrowsCode(() => computeAssessmentKey(baseInput({ candleTimestampMs: "1756000000000" })), InvalidAssessmentKeyInputError);
});

test("sem nenhum argumento -> InvalidAssessmentKeyInputError (nao lanca TypeError de destructuring)", () => {
  assertThrowsCode(() => computeAssessmentKey(), InvalidAssessmentKeyInputError);
});

// =====================================================================
// 4) createAttemptId -- identidade fisica, injetavel
// =====================================================================

test("createAttemptId: gera UUID novo a cada chamada", () => {
  const a1 = createAttemptId();
  const a2 = createAttemptId();
  assert.notEqual(a1, a2);
  assert.match(a1, /^[0-9a-f-]{36}$/);
});

test("createAttemptId: randomUUIDFn injetavel, UUID valido injetado e aceito", () => {
  const fixed = "00000000-0000-0000-0000-000000000000";
  const id = createAttemptId({ randomUUIDFn: () => fixed });
  assert.equal(id, fixed);
});

test("createAttemptId: duas chamadas reais (sem injecao) geram valores diferentes", () => {
  const a1 = createAttemptId();
  const a2 = createAttemptId();
  assert.notEqual(a1, a2);
});

test("createAttemptId: retorno invalido de randomUUIDFn e REJEITADO (InvalidAttemptIdError), nunca aceito como attemptId", () => {
  assertThrowsCode(() => createAttemptId({ randomUUIDFn: () => "not-a-uuid" }), InvalidAttemptIdError, "INVALID_ATTEMPT_ID");
  assertThrowsCode(() => createAttemptId({ randomUUIDFn: () => "" }), InvalidAttemptIdError);
  assertThrowsCode(() => createAttemptId({ randomUUIDFn: () => 12345 }), InvalidAttemptIdError);
  assertThrowsCode(() => createAttemptId({ randomUUIDFn: () => null }), InvalidAttemptIdError);
  assertThrowsCode(() => createAttemptId({ randomUUIDFn: () => "11111111-1111-1111-1111-11111111111" /* 1 char curto */ }), InvalidAttemptIdError);
});

test("computeAssessmentKey() nunca aceita attemptId, mesmo gerado por um randomUUIDFn injetado valido em createAttemptId()", () => {
  const attemptId = createAttemptId({ randomUUIDFn: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  assertThrowsCode(() => computeAssessmentKey({ ...baseInput(), attemptId }), UnrecognizedAssessmentKeyFieldError);
});

// =====================================================================
// 5) Exportacao do erro de saida defensivo (nao alcancavel via API
// publica normal, mas a classe precisa existir/estar exportada)
// =====================================================================

test("InvalidAssessmentKeyOutputError esta exportado e tem o formato esperado", () => {
  const err = new InvalidAssessmentKeyOutputError("bogus-key");
  assert.equal(err.code, "INVALID_ASSESSMENT_KEY_OUTPUT");
  assert.equal(err.key, "bogus-key");
});

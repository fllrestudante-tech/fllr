const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeAssessmentKey,
  createAttemptId,
  computeQuantFingerprint,
  ASSESSMENT_KEY_VERSION,
  QUANT_FINGERPRINT_VERSION,
  InvalidAssessmentKeyInputError,
  InvalidAssessmentKeyOutputError,
  UnrecognizedAssessmentKeyFieldError,
  InvalidAttemptIdError,
  InvalidQuantFingerprintInputError,
  InvalidQuantSignalError,
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
  assert.equal(key, "ar-ak:v1:573a7f4ac164e6b8c0c42913802a844102b4195ad705b9b89f7abc8cf31adce5");
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
  assert.equal(key, "ar-ak:v1:573a7f4ac164e6b8c0c42913802a844102b4195ad705b9b89f7abc8cf31adce5");
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

// =====================================================================
// 6) computeQuantFingerprint -- SHA-256 completo, serializacao numerica
// EXATA (nao arredondamento), allowlist real de signal.analyze()
// =====================================================================

function baseQuant(overrides = {}) {
  return {
    signal: "buy",
    price: 142.567891,
    reasons: ["ema_cross_up", "stoch_oversold"],
    indicators: {
      emaShort: 141.234567,
      emaLong: 139.876543,
      rsi: 55.123456,
      stochRsi: 12.5,
      obv: 98765.4321,
      atr: 0.98765,
    },
    ...overrides,
  };
}

test("computeQuantFingerprint: formato qf:v1:<64 hex chars>, SHA-256 completo sem truncar", () => {
  const fp = computeQuantFingerprint(baseQuant());
  const [prefix, version, digest] = fp.split(":");
  assert.equal(prefix, "qf");
  assert.equal(version, QUANT_FINGERPRINT_VERSION);
  assert.equal(digest.length, 64, "digest deve ser SHA-256 completo, nunca truncado a 16 chars");
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test("computeQuantFingerprint: quant null/undefined -> null (compatibilidade de modulo puro)", () => {
  assert.equal(computeQuantFingerprint(null), null);
  assert.equal(computeQuantFingerprint(undefined), null);
});

test("computeQuantFingerprint: quant nao-objeto (string/numero/array) -> InvalidQuantFingerprintInputError, NUNCA null silencioso", () => {
  assertThrowsCode(() => computeQuantFingerprint("buy"), InvalidQuantFingerprintInputError, "INVALID_QUANT_FINGERPRINT_INPUT");
  assertThrowsCode(() => computeQuantFingerprint(42), InvalidQuantFingerprintInputError);
  assertThrowsCode(() => computeQuantFingerprint([1, 2, 3]), InvalidQuantFingerprintInputError);
});

test("computeQuantFingerprint: signal fora da allowlist real (wait|buy|sell) -> InvalidQuantSignalError", () => {
  assertThrowsCode(() => computeQuantFingerprint(baseQuant({ signal: "hold" })), InvalidQuantSignalError, "INVALID_QUANT_SIGNAL");
  assertThrowsCode(() => computeQuantFingerprint(baseQuant({ signal: "BUY" })), InvalidQuantSignalError); // case-sensitive, exatamente o enum real
  assertThrowsCode(() => computeQuantFingerprint(baseQuant({ signal: "" })), InvalidQuantSignalError);
  assertThrowsCode(() => computeQuantFingerprint(baseQuant({ signal: null })), InvalidQuantSignalError);
  assertThrowsCode(() => computeQuantFingerprint(baseQuant({ signal: undefined })), InvalidQuantSignalError);
});

test("computeQuantFingerprint: os 3 valores reais de signal (wait/buy/sell) sao todos aceitos", () => {
  for (const signal of ["wait", "buy", "sell"]) {
    assert.doesNotThrow(() => computeQuantFingerprint(baseQuant({ signal })));
  }
});

test("computeQuantFingerprint: campo numerico obrigatorio ausente/NaN/Infinito/string -> InvalidQuantFingerprintInputError, NUNCA vira null silenciosamente", () => {
  const numericFields = ["price"];
  const indicatorFields = ["emaShort", "emaLong", "rsi", "stochRsi", "obv", "atr"];
  for (const field of numericFields) {
    assertThrowsCode(() => computeQuantFingerprint(baseQuant({ [field]: undefined })), InvalidQuantFingerprintInputError);
    assertThrowsCode(() => computeQuantFingerprint(baseQuant({ [field]: NaN })), InvalidQuantFingerprintInputError);
    assertThrowsCode(() => computeQuantFingerprint(baseQuant({ [field]: Infinity })), InvalidQuantFingerprintInputError);
    assertThrowsCode(() => computeQuantFingerprint(baseQuant({ [field]: -Infinity })), InvalidQuantFingerprintInputError);
    assertThrowsCode(() => computeQuantFingerprint(baseQuant({ [field]: "142.5" })), InvalidQuantFingerprintInputError);
  }
  for (const field of indicatorFields) {
    const q = baseQuant();
    q.indicators = { ...q.indicators, [field]: undefined };
    assertThrowsCode(() => computeQuantFingerprint(q), InvalidQuantFingerprintInputError);
    const q2 = baseQuant();
    q2.indicators = { ...q2.indicators, [field]: "1.23" };
    assertThrowsCode(() => computeQuantFingerprint(q2), InvalidQuantFingerprintInputError, "INVALID_QUANT_FINGERPRINT_INPUT");
  }
});

test("computeQuantFingerprint: string numerica '1.23' e REJEITADA em qualquer campo -- nunca convertida implicitamente", () => {
  assertThrowsCode(() => computeQuantFingerprint(baseQuant({ price: "1.23" })), InvalidQuantFingerprintInputError);
});

test("computeQuantFingerprint: indicators ausente/malformado -> trata como {} -> campos obrigatorios ausentes -> erro (nunca null silencioso)", () => {
  assertThrowsCode(() => computeQuantFingerprint(baseQuant({ indicators: undefined })), InvalidQuantFingerprintInputError);
  assertThrowsCode(() => computeQuantFingerprint(baseQuant({ indicators: "not an object" })), InvalidQuantFingerprintInputError);
  assertThrowsCode(() => computeQuantFingerprint(baseQuant({ indicators: null })), InvalidQuantFingerprintInputError);
});

// --- mudanca de CADA campo, isoladamente, altera o fingerprint ---

const QUANT_FIELD_VARIANTS = [
  { label: "signal", make: (q) => ({ ...q, signal: "sell" }) },
  { label: "price", make: (q) => ({ ...q, price: q.price + 0.01 }) },
  { label: "emaShort", make: (q) => ({ ...q, indicators: { ...q.indicators, emaShort: q.indicators.emaShort + 0.01 } }) },
  { label: "emaLong", make: (q) => ({ ...q, indicators: { ...q.indicators, emaLong: q.indicators.emaLong + 0.01 } }) },
  { label: "rsi", make: (q) => ({ ...q, indicators: { ...q.indicators, rsi: q.indicators.rsi + 0.01 } }) },
  { label: "stochRsi", make: (q) => ({ ...q, indicators: { ...q.indicators, stochRsi: q.indicators.stochRsi + 0.01 } }) },
  { label: "obv", make: (q) => ({ ...q, indicators: { ...q.indicators, obv: q.indicators.obv + 0.01 } }) },
  { label: "atr", make: (q) => ({ ...q, indicators: { ...q.indicators, atr: q.indicators.atr + 0.01 } }) },
];

for (const { label, make } of QUANT_FIELD_VARIANTS) {
  test(`computeQuantFingerprint: mudanca isolada em "${label}" produz fingerprint diferente`, () => {
    const base = baseQuant();
    const fp1 = computeQuantFingerprint(base);
    const fp2 = computeQuantFingerprint(make(base));
    assert.notEqual(fp1, fp2, `campo "${label}" deveria alterar o fingerprint`);
  });
}

test("computeQuantFingerprint: mesma estrutura, ordem de propriedades DIFERENTE no objeto de entrada -> mesmo fingerprint", () => {
  const q1 = baseQuant();
  const q2 = {
    indicators: { atr: q1.indicators.atr, obv: q1.indicators.obv, stochRsi: q1.indicators.stochRsi, rsi: q1.indicators.rsi, emaLong: q1.indicators.emaLong, emaShort: q1.indicators.emaShort },
    reasons: q1.reasons,
    price: q1.price,
    signal: q1.signal,
  };
  assert.equal(computeQuantFingerprint(q1), computeQuantFingerprint(q2));
});

test("computeQuantFingerprint: -0 e 0 produzem o MESMO fingerprint (regra canonica Object.is(-0) -> '0')", () => {
  const fpZero = computeQuantFingerprint(baseQuant({ indicators: { ...baseQuant().indicators, obv: 0 } }));
  const fpNegZero = computeQuantFingerprint(baseQuant({ indicators: { ...baseQuant().indicators, obv: -0 } }));
  assert.equal(fpZero, fpNegZero);
});

test("computeQuantFingerprint: texto narrativo em reasons[] NAO afeta o fingerprint -- so os 7 numeros + signal entram na canonicalizacao", () => {
  const fp1 = computeQuantFingerprint(baseQuant({ reasons: ["ema_cross_up", "stoch_oversold"] }));
  const fp2 = computeQuantFingerprint(baseQuant({ reasons: ["texto completamente diferente, uma frase livre qualquer!!"] }));
  const fp3 = computeQuantFingerprint(baseQuant({ reasons: [] }));
  const fp4 = computeQuantFingerprint(baseQuant({ reasons: undefined }));
  assert.equal(fp1, fp2);
  assert.equal(fp1, fp3);
  assert.equal(fp1, fp4);
});

test("computeQuantFingerprint: posicao, saldo, prompt e Telegram nunca aparecem no payload canonico -- so os campos esperados sao lidos, mesmo se presentes na entrada", () => {
  const contaminated = baseQuant({
    qty: 12.5,
    entryPrice: 140.0,
    stopLossPrice: 135.0,
    takeProfitPrice: 150.0,
    balance: 9999.99,
    prompt: "You are a context-enrichment module...",
    telegramText: "compra agora, sinal forte!!",
    apiKey: "rejected-sensitive-field-value",
  });
  const fpContaminated = computeQuantFingerprint(contaminated);
  const fpClean = computeQuantFingerprint(baseQuant());
  // campos extras nao reconhecidos sao simplesmente ignorados (computeQuantFingerprint
  // so LE os campos que conhece) -- prova, pelo NOME do campo (qty, entryPrice,
  // stopLossPrice, takeProfitPrice, balance, prompt, telegramText, apiKey) e nao
  // por semelhanca de valor com credencial real, que nenhum deles altera o hash
  assert.equal(fpContaminated, fpClean);
});

test("computeQuantFingerprint diferente altera a assessmentKey; ausente/undefined/null produz a MESMA chave", () => {
  const base = {
    symbol: "SOLUSDT",
    interval: "15",
    candleTimestampMs: 1_756_000_000_000,
    triggerReason: "quant_signal",
    taskClass: "normal_analysis",
    promptVersion: "v1",
    schemaVersion: "v1",
  };
  const fpA = computeQuantFingerprint(baseQuant({ signal: "buy" }));
  const fpB = computeQuantFingerprint(baseQuant({ signal: "sell" }));

  const kAbsent = computeAssessmentKey(base);
  const kUndefined = computeAssessmentKey({ ...base, quantFingerprint: undefined });
  const kNull = computeAssessmentKey({ ...base, quantFingerprint: null });
  const kA = computeAssessmentKey({ ...base, quantFingerprint: fpA });
  const kB = computeAssessmentKey({ ...base, quantFingerprint: fpB });

  assert.equal(kAbsent, kUndefined);
  assert.equal(kUndefined, kNull);
  assert.notEqual(kAbsent, kA);
  assert.notEqual(kA, kB);
});

test("computeAssessmentKey: quantFingerprint com formato invalido (nao gerado por computeQuantFingerprint) -> InvalidAssessmentKeyInputError", () => {
  const base = {
    symbol: "SOLUSDT", interval: "15", candleTimestampMs: 1_756_000_000_000,
    triggerReason: "quant_signal", taskClass: "normal_analysis", promptVersion: "v1", schemaVersion: "v1",
  };
  assertThrowsCode(() => computeAssessmentKey({ ...base, quantFingerprint: "texto livre nao e um fingerprint valido" }), InvalidAssessmentKeyInputError);
  assertThrowsCode(() => computeAssessmentKey({ ...base, quantFingerprint: "" }), InvalidAssessmentKeyInputError);
});

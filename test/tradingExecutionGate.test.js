const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TRADING_EXECUTION_ENABLED_ENV_VAR,
  STRICT_ENABLE_VALUE,
  isTradingExecutionEnabled,
  assertTradingExecutionEnabled,
  TradingExecutionBlockedError,
} = require("../lib/tradingExecutionGate");

test("TRADING_EXECUTION_ENABLED_ENV_VAR / STRICT_ENABLE_VALUE: nomes estáveis esperados pelo contrato", () => {
  assert.equal(TRADING_EXECUTION_ENABLED_ENV_VAR, "TRADING_EXECUTION_ENABLED");
  assert.equal(STRICT_ENABLE_VALUE, "true");
});

test("isTradingExecutionEnabled: ausente -> false", () => {
  assert.equal(isTradingExecutionEnabled({}), false);
});

test("isTradingExecutionEnabled: vazio -> false", () => {
  assert.equal(isTradingExecutionEnabled({ TRADING_EXECUTION_ENABLED: "" }), false);
});

test("isTradingExecutionEnabled: 'false' -> false", () => {
  assert.equal(isTradingExecutionEnabled({ TRADING_EXECUTION_ENABLED: "false" }), false);
});

test("isTradingExecutionEnabled: capitalização inesperada -> false (comparação é estrita, não case-insensitive)", () => {
  for (const value of ["True", "TRUE", "tRue", " true", "true ", "true\n"]) {
    assert.equal(isTradingExecutionEnabled({ TRADING_EXECUTION_ENABLED: value }), false, `valor "${value}" deveria bloquear`);
  }
});

test("isTradingExecutionEnabled: qualquer outro valor inválido -> false, nunca lança", () => {
  for (const value of ["1", "0", "yes", "no", "enabled", "TRADING_EXECUTION_ENABLED", "null", "undefined"]) {
    assert.equal(isTradingExecutionEnabled({ TRADING_EXECUTION_ENABLED: value }), false, `valor "${value}" deveria bloquear`);
  }
});

test("isTradingExecutionEnabled: somente o literal estrito 'true' habilita", () => {
  assert.equal(isTradingExecutionEnabled({ TRADING_EXECUTION_ENABLED: "true" }), true);
});

test("isTradingExecutionEnabled: BYBIT_DEMO=true sozinho NUNCA substitui a autorização", () => {
  assert.equal(isTradingExecutionEnabled({ BYBIT_DEMO: "true" }), false);
});

test("isTradingExecutionEnabled: BYBIT_TESTNET=true sozinho NUNCA substitui a autorização", () => {
  assert.equal(isTradingExecutionEnabled({ BYBIT_TESTNET: "true" }), false);
});

test("isTradingExecutionEnabled: credenciais presentes sozinhas NUNCA substituem a autorização", () => {
  assert.equal(
    isTradingExecutionEnabled({ BYBIT_API_KEY: "fake-key-not-a-real-secret", BYBIT_API_SECRET: "fake-secret-not-real" }),
    false
  );
});

test("isTradingExecutionEnabled: BYBIT_DEMO + BYBIT_TESTNET + credenciais juntos, sem o gate, ainda bloqueiam", () => {
  assert.equal(
    isTradingExecutionEnabled({
      BYBIT_DEMO: "true",
      BYBIT_TESTNET: "true",
      BYBIT_API_KEY: "fake-key-not-a-real-secret",
      BYBIT_API_SECRET: "fake-secret-not-real",
    }),
    false
  );
});

test("assertTradingExecutionEnabled: lança TradingExecutionBlockedError quando desabilitado, sem revelar nenhum valor recebido", () => {
  assert.throws(
    () => assertTradingExecutionEnabled({ TRADING_EXECUTION_ENABLED: "nope-invalido", BYBIT_API_KEY: "segredo-fake-nao-deve-aparecer" }),
    (err) => {
      assert.ok(err instanceof TradingExecutionBlockedError);
      assert.equal(err.code, "TRADING_EXECUTION_BLOCKED");
      assert.ok(err.message.includes("TRADING_EXECUTION_ENABLED"));
      assert.ok(err.message.includes("true"));
      assert.ok(!err.message.includes("nope-invalido"));
      assert.ok(!err.message.includes("segredo-fake-nao-deve-aparecer"));
      return true;
    }
  );
});

test("assertTradingExecutionEnabled: mensagem é estável (mesmo texto independente do valor recebido)", () => {
  let messageA, messageB;
  try {
    assertTradingExecutionEnabled({});
  } catch (err) {
    messageA = err.message;
  }
  try {
    assertTradingExecutionEnabled({ TRADING_EXECUTION_ENABLED: "qualquer-coisa" });
  } catch (err) {
    messageB = err.message;
  }
  assert.equal(messageA, messageB);
});

test("assertTradingExecutionEnabled: NÃO lança quando habilitado com o literal estrito", () => {
  assert.doesNotThrow(() => assertTradingExecutionEnabled({ TRADING_EXECUTION_ENABLED: "true" }));
});

test("assertTradingExecutionEnabled: usa process.env por padrão quando nenhum env é passado", () => {
  const prev = process.env.TRADING_EXECUTION_ENABLED;
  delete process.env.TRADING_EXECUTION_ENABLED;
  try {
    assert.throws(() => assertTradingExecutionEnabled(), TradingExecutionBlockedError);
  } finally {
    if (prev === undefined) delete process.env.TRADING_EXECUTION_ENABLED;
    else process.env.TRADING_EXECUTION_ENABLED = prev;
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEMO_PROFILE_NAME,
  DEMO_BASE_URL,
  TESTNET_BASE_URL,
  MAINNET_BASE_URL,
  resolveStrictBaseUrl,
  validateDemoBoot,
  isDemoBootValid,
  DemoTradingGateError,
  DemoFlagInvalidError,
  DemoEndpointMismatchError,
  DemoCredentialsMissingError,
} = require("../lib/demoTradingGate");

function validEnv(overrides = {}) {
  return {
    BYBIT_DEMO: "true",
    BYBIT_TESTNET: "false",
    BYBIT_API_KEY: "fake-key-not-a-real-secret",
    BYBIT_API_SECRET: "fake-secret-not-real",
    ...overrides,
  };
}

test("constantes estáveis do contrato", () => {
  assert.equal(DEMO_PROFILE_NAME, "demo");
  assert.equal(DEMO_BASE_URL, "https://api-demo.bybit.com");
  assert.equal(TESTNET_BASE_URL, "https://api-testnet.bybit.com");
  assert.equal(MAINNET_BASE_URL, "https://api.bybit.com");
});

// =====================================================================
// resolveStrictBaseUrl -- resolução independente, nunca via config.js
// =====================================================================

test("resolveStrictBaseUrl: BYBIT_DEMO='true' -> demo, independente de BYBIT_TESTNET", () => {
  assert.equal(resolveStrictBaseUrl({ BYBIT_DEMO: "true" }), DEMO_BASE_URL);
  assert.equal(resolveStrictBaseUrl({ BYBIT_DEMO: "true", BYBIT_TESTNET: "true" }), DEMO_BASE_URL);
});

test("resolveStrictBaseUrl: BYBIT_TESTNET='true' sem BYBIT_DEMO -> testnet", () => {
  assert.equal(resolveStrictBaseUrl({ BYBIT_TESTNET: "true" }), TESTNET_BASE_URL);
});

test("resolveStrictBaseUrl: nenhuma flag reconhecida -> mainnet (mesmo comportamento fail-open perigoso de lib/bybit.js, documentado -- por isso validateDemoBoot existe)", () => {
  assert.equal(resolveStrictBaseUrl({}), MAINNET_BASE_URL);
});

test("resolveStrictBaseUrl: capitalização/valor errado ('TRUE', '1', 'yes') nunca vira demo/testnet -- sempre cai em mainnet, nunca corrige silenciosamente", () => {
  for (const value of ["TRUE", "True", "1", "yes", " true", "true "]) {
    assert.equal(resolveStrictBaseUrl({ BYBIT_DEMO: value }), MAINNET_BASE_URL, `BYBIT_DEMO="${value}" deveria cair em mainnet, nunca em demo`);
  }
});

// =====================================================================
// validateDemoBoot -- todas as condições exigidas, fail-closed
// =====================================================================

test("validateDemoBoot: configuração completa e válida -> não lança", () => {
  assert.doesNotThrow(() => validateDemoBoot(validEnv()));
});

test("validateDemoBoot: BYBIT_DEMO ausente -> DemoFlagInvalidError", () => {
  const env = validEnv();
  delete env.BYBIT_DEMO;
  assert.throws(() => validateDemoBoot(env), (err) => {
    assert.ok(err instanceof DemoFlagInvalidError);
    assert.ok(err instanceof DemoTradingGateError);
    assert.equal(err.code, "DEMO_FLAG_INVALID");
    assert.equal(err.field, "BYBIT_DEMO");
    return true;
  });
});

test("validateDemoBoot: BYBIT_DEMO com qualquer capitalização/valor diferente de 'true' -> lança, nunca aceita", () => {
  for (const value of ["True", "TRUE", "1", "yes", " true", "true ", "false"]) {
    assert.throws(() => validateDemoBoot(validEnv({ BYBIT_DEMO: value })), DemoFlagInvalidError, `BYBIT_DEMO="${value}" deveria lançar`);
  }
});

test("validateDemoBoot: BYBIT_TESTNET ausente -> DemoFlagInvalidError (exige exatamente 'false', não apenas 'não true')", () => {
  const env = validEnv();
  delete env.BYBIT_TESTNET;
  assert.throws(() => validateDemoBoot(env), (err) => {
    assert.ok(err instanceof DemoFlagInvalidError);
    assert.equal(err.field, "BYBIT_TESTNET");
    return true;
  });
});

test("validateDemoBoot: BYBIT_TESTNET='true' -> lança (testnet privado estruturalmente impossível no perfil demo)", () => {
  assert.throws(() => validateDemoBoot(validEnv({ BYBIT_TESTNET: "true" })), DemoFlagInvalidError);
});

test("validateDemoBoot: BYBIT_TESTNET com valor diferente de 'false' exato (ex: 'False', '0') -> lança", () => {
  for (const value of ["False", "FALSE", "0", "no"]) {
    assert.throws(() => validateDemoBoot(validEnv({ BYBIT_TESTNET: value })), DemoFlagInvalidError, `BYBIT_TESTNET="${value}" deveria lançar`);
  }
});

test("validateDemoBoot: BYBIT_API_KEY ausente -> DemoCredentialsMissingError, nunca revela nada sobre BYBIT_API_SECRET", () => {
  assert.throws(() => validateDemoBoot(validEnv({ BYBIT_API_KEY: "" })), (err) => {
    assert.ok(err instanceof DemoCredentialsMissingError);
    assert.equal(err.field, "BYBIT_API_KEY");
    return true;
  });
});

test("validateDemoBoot: BYBIT_API_KEY só espaços -> tratado como ausente", () => {
  assert.throws(() => validateDemoBoot(validEnv({ BYBIT_API_KEY: "   " })), DemoCredentialsMissingError);
});

test("validateDemoBoot: BYBIT_API_SECRET ausente -> DemoCredentialsMissingError", () => {
  assert.throws(() => validateDemoBoot(validEnv({ BYBIT_API_SECRET: "" })), (err) => {
    assert.ok(err instanceof DemoCredentialsMissingError);
    assert.equal(err.field, "BYBIT_API_SECRET");
    return true;
  });
});

test("validateDemoBoot: nenhuma mensagem de erro inclui o valor de BYBIT_API_KEY/BYBIT_API_SECRET", () => {
  const secretKey = "segredo-fake-key-nao-deve-aparecer";
  const secretSecret = "segredo-fake-secret-nao-deve-aparecer";
  try {
    validateDemoBoot(validEnv({ BYBIT_DEMO: "nope", BYBIT_API_KEY: secretKey, BYBIT_API_SECRET: secretSecret }));
    assert.fail("deveria ter lançado");
  } catch (err) {
    assert.ok(!err.message.includes(secretKey));
    assert.ok(!err.message.includes(secretSecret));
  }
});

test("validateDemoBoot: combinação ambígua (BYBIT_DEMO válido, BYBIT_TESTNET também 'true' por engano) -> lança no BYBIT_TESTNET, nunca aceita silenciosamente", () => {
  assert.throws(() => validateDemoBoot({ BYBIT_DEMO: "true", BYBIT_TESTNET: "true", BYBIT_API_KEY: "k", BYBIT_API_SECRET: "s" }), DemoFlagInvalidError);
});

test("validateDemoBoot: usa process.env por padrão quando nenhum env é passado", () => {
  const keys = ["BYBIT_DEMO", "BYBIT_TESTNET", "BYBIT_API_KEY", "BYBIT_API_SECRET"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.BYBIT_DEMO;
    assert.throws(() => validateDemoBoot(), DemoFlagInvalidError);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});

// =====================================================================
// isDemoBootValid -- versão booleana, nunca lança
// =====================================================================

test("isDemoBootValid: configuração válida -> true", () => {
  assert.equal(isDemoBootValid(validEnv()), true);
});

test("isDemoBootValid: qualquer configuração inválida -> false, nunca lança", () => {
  assert.equal(isDemoBootValid({}), false);
  assert.doesNotThrow(() => isDemoBootValid({}));
});

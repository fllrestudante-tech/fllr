const test = require("node:test");
const assert = require("node:assert/strict");
const { readDemo, isDemoConfigured, safeResolveMode, safeLoadDemoLimits, DATA_FRESH_MAX_AGE_MS } = require("../../lib/webDashboard/demoReader");
const { STATES } = require("../../lib/killSwitch");
const { DEFAULT_STATE } = require("../../lib/state");

function fakeLoadState(overrides = {}) {
  return () => ({ ...DEFAULT_STATE, ...overrides });
}
function fakeKillSwitch(state, reason = null) {
  return () => ({ state, reason });
}
function fakeSupervisorState(state) {
  return () => state;
}
function fakeConnectivity(state) {
  return () => state;
}
function fakeLastSuccessfulReadAt(ms) {
  return () => ms;
}
function fakeLastDecision(decision) {
  return () => decision;
}

const NOW = 1_756_000_000_000;
const VALID_DEMO_ENV = { SUPERVISOR_PROFILE: "demo", BYBIT_DEMO: "true", BYBIT_TESTNET: "false", BYBIT_API_KEY: "fake-key-not-a-real-secret", BYBIT_API_SECRET: "fake-secret-not-real" };

function baseArgs(overrides = {}) {
  return {
    env: {},
    now: NOW,
    loadState: fakeLoadState(),
    readEffectiveKillSwitchState: fakeKillSwitch(STATES.BLOCK_NEW_EXPOSURE),
    readSupervisorState: fakeSupervisorState(null),
    readConnectivity: fakeConnectivity(null),
    getLastSuccessfulReadAt: fakeLastSuccessfulReadAt(null),
    getLastDecision: fakeLastDecision(null),
    ...overrides,
  };
}

// =====================================================================
// isDemoConfigured / safeResolveMode / safeLoadDemoLimits
// =====================================================================

test("isDemoConfigured: perfil demo + config completa e válida -> true", () => {
  assert.equal(isDemoConfigured(VALID_DEMO_ENV), true);
});

test("isDemoConfigured: perfil safe -> false, mesmo com env de demo válido presente", () => {
  assert.equal(isDemoConfigured({ ...VALID_DEMO_ENV, SUPERVISOR_PROFILE: "safe" }), false);
});

test("isDemoConfigured: perfil demo mas BYBIT_TESTNET errado -> false", () => {
  assert.equal(isDemoConfigured({ ...VALID_DEMO_ENV, BYBIT_TESTNET: "true" }), false);
});

test("safeResolveMode: perfil desconhecido -> 'invalid', nunca lança", () => {
  assert.equal(safeResolveMode({ SUPERVISOR_PROFILE: "producao-fake" }), "invalid");
});

test("safeLoadDemoLimits: env inválido -> valid=false com código do erro, nunca lança", () => {
  const result = safeLoadDemoLimits({ DEMO_MAX_LEVERAGE: "abc" });
  assert.equal(result.valid, false);
  assert.equal(result.error, "INVALID_DEMO_RISK_LIMITS_CONFIG");
});

// =====================================================================
// readDemo -- vocabulário do Bloqueador 7
// =====================================================================

test("readDemo: perfil safe -> configured=false, privateReadEnabled=false, newExposureArmed=false, emergencyExitAvailable=false", () => {
  const result = readDemo(baseArgs({ env: { SUPERVISOR_PROFILE: "safe" } }));
  assert.equal(result.environment, "SAFE");
  assert.equal(result.configured, false);
  assert.equal(result.privateReadEnabled, false);
  assert.equal(result.newExposureArmed, false);
  assert.equal(result.emergencyExitAvailable, false);
});

test("readDemo: perfil demo configurado, DEMO_PRIVATE_READ_ENABLED=true -> privateReadEnabled=true", () => {
  const result = readDemo(baseArgs({ env: { ...VALID_DEMO_ENV, DEMO_PRIVATE_READ_ENABLED: "true" } }));
  assert.equal(result.configured, true);
  assert.equal(result.privateReadEnabled, true);
});

test("readDemo: perfil demo configurado, DEMO_PRIVATE_READ_ENABLED ausente -> privateReadEnabled=false", () => {
  const result = readDemo(baseArgs({ env: VALID_DEMO_ENV }));
  assert.equal(result.privateReadEnabled, false);
});

test("readDemo: kill switch ARMED_DEMO -> newExposureArmed=true", () => {
  const result = readDemo(baseArgs({ env: VALID_DEMO_ENV, readEffectiveKillSwitchState: fakeKillSwitch(STATES.ARMED_DEMO) }));
  assert.equal(result.newExposureArmed, true);
  assert.equal(result.killSwitchState, STATES.ARMED_DEMO);
});

test("readDemo: kill switch BLOCK_NEW_EXPOSURE -> newExposureArmed=false", () => {
  const result = readDemo(baseArgs({ env: VALID_DEMO_ENV, readEffectiveKillSwitchState: fakeKillSwitch(STATES.BLOCK_NEW_EXPOSURE) }));
  assert.equal(result.newExposureArmed, false);
});

test("readDemo: emergencyExitAvailable exige configured E tradingExecutionEnabled -- nunca exige ARMED_DEMO (é o oposto do que ARMED_DEMO controla)", () => {
  const withoutTrading = readDemo(baseArgs({ env: VALID_DEMO_ENV })); // TRADING_EXECUTION_ENABLED ausente
  assert.equal(withoutTrading.emergencyExitAvailable, false);

  const withTrading = readDemo(baseArgs({ env: { ...VALID_DEMO_ENV, TRADING_EXECUTION_ENABLED: "true" }, readEffectiveKillSwitchState: fakeKillSwitch(STATES.BLOCK_NEW_EXPOSURE) }));
  assert.equal(withTrading.emergencyExitAvailable, true, "emergência deveria estar disponível mesmo com kill switch bloqueando NOVA exposição");
});

test("readDemo: lastSuccessfulPrivateReadAt ausente -> dataFresh=false, campo null (nunca zero inventado)", () => {
  const result = readDemo(baseArgs({ env: VALID_DEMO_ENV, getLastSuccessfulReadAt: fakeLastSuccessfulReadAt(null) }));
  assert.equal(result.dataFresh, false);
  assert.equal(result.lastSuccessfulPrivateReadAt, null);
});

test("readDemo: lastSuccessfulPrivateReadAt recente (dentro da janela) -> dataFresh=true", () => {
  const result = readDemo(baseArgs({ env: VALID_DEMO_ENV, now: NOW, getLastSuccessfulReadAt: fakeLastSuccessfulReadAt(NOW - 1000) }));
  assert.equal(result.dataFresh, true);
  assert.equal(result.lastSuccessfulPrivateReadAt, new Date(NOW - 1000).toISOString());
});

test("readDemo: lastSuccessfulPrivateReadAt velho demais (além de DATA_FRESH_MAX_AGE_MS) -> dataFresh=false", () => {
  const result = readDemo(baseArgs({ env: VALID_DEMO_ENV, now: NOW, getLastSuccessfulReadAt: fakeLastSuccessfulReadAt(NOW - DATA_FRESH_MAX_AGE_MS - 1) }));
  assert.equal(result.dataFresh, false);
});

test("readDemo: trading marcado como stale quando dado não é fresco (configured=true, mas sem leitura recente)", () => {
  const result = readDemo(
    baseArgs({
      env: VALID_DEMO_ENV,
      now: NOW,
      loadState: fakeLoadState({ isOpened: true, side: "Buy", qty: 1 }),
      getLastSuccessfulReadAt: fakeLastSuccessfulReadAt(null),
    })
  );
  assert.equal(result.dataFresh, false);
  assert.equal(result.trading.staleness, "stale");
});

test("readDemo: lastDecision ausente -> null, blockReason -> null (nunca inventa)", () => {
  const result = readDemo(baseArgs({ env: VALID_DEMO_ENV, getLastDecision: fakeLastDecision(null) }));
  assert.equal(result.lastDecision, null);
  assert.equal(result.blockReason, null);
});

test("readDemo: lastDecision bloqueado -> reflete kind/opName/reason, blockReason espelha o motivo", () => {
  const result = readDemo(
    baseArgs({
      env: VALID_DEMO_ENV,
      getLastDecision: fakeLastDecision({ allowed: false, kind: "INCREASE_EXPOSURE", opName: "placeOrder", reason: "notional_exceeds_limit", atMs: NOW }),
    })
  );
  assert.equal(result.lastDecision.allowed, false);
  assert.equal(result.lastDecision.reason, "notional_exceeds_limit");
  assert.equal(result.blockReason, "notional_exceeds_limit");
});

test("readDemo: lastDecision PERMITIDO -> blockReason continua null (não é um bloqueio)", () => {
  const result = readDemo(
    baseArgs({
      env: VALID_DEMO_ENV,
      getLastDecision: fakeLastDecision({ allowed: true, kind: "REDUCE_EXPOSURE", opName: "placeOrder", reason: null, atMs: NOW }),
    })
  );
  assert.equal(result.blockReason, null);
});

test("readDemo: riskLimits inválido -> riskLimits=null, riskLimitsError com código, painel inteiro não quebra", () => {
  const result = readDemo(baseArgs({ env: { ...VALID_DEMO_ENV, DEMO_MAX_LEVERAGE: "abc" } }));
  assert.equal(result.riskLimits, null);
  assert.equal(result.riskLimitsError, "INVALID_DEMO_RISK_LIMITS_CONFIG");
});

test("readDemo: nunca inclui BYBIT_API_KEY/BYBIT_API_SECRET nem nenhum segredo no corpo devolvido", () => {
  const secretKey = "segredo-fake-key-nao-deve-aparecer";
  const result = readDemo(baseArgs({ env: { ...VALID_DEMO_ENV, BYBIT_API_KEY: secretKey } }));
  assert.ok(!JSON.stringify(result).includes(secretKey));
});

test("readDemo: supervisor/telegramStatus refletidos quando presentes", () => {
  const result = readDemo(
    baseArgs({
      env: VALID_DEMO_ENV,
      readSupervisorState: fakeSupervisorState({ bot: { pid: 123, status: "running", totalRestarts: 0, consecutiveRestarts: 0 } }),
      readConnectivity: fakeConnectivity({ providers: { telegram: true }, updatedAt: "2026-08-29T12:00:00.000Z" }),
    })
  );
  assert.equal(result.supervisor.children.bot.pid, 123);
  assert.deepEqual(result.telegramStatus, { ok: true, updatedAt: "2026-08-29T12:00:00.000Z" });
});

// =====================================================================
// snapshotStatus (item 3 da Rodada 4) -- vocabulário estável, nunca
// expõe o código de erro interno cru.
// =====================================================================

test("readDemo: snapshot fresco -> status 'fresh' com exposição/posições/ordens", () => {
  const fakeSnapshot = { capturedAtMs: NOW - 1000, exposureUsd: "40", equityUsd: "1000", positions: [{}], openOrders: [] };
  const result = readDemo(baseArgs({ env: VALID_DEMO_ENV, readTrustedSnapshot: () => fakeSnapshot }));
  assert.deepEqual(result.snapshotStatus, { status: "fresh", capturedAt: new Date(NOW - 1000).toISOString(), exposureUsd: "40", equityUsd: "1000", positionsCount: 1, openOrdersCount: 0 });
});

test("readDemo: snapshot ausente -> status 'unavailable', nunca lança", () => {
  const err = new Error("ausente");
  err.code = "SNAPSHOT_MISSING";
  const result = readDemo(baseArgs({ readTrustedSnapshot: () => { throw err; } }));
  assert.deepEqual(result.snapshotStatus, { status: "unavailable" });
});

test("readDemo: snapshot velho -> status 'stale'", () => {
  const err = new Error("velho");
  err.code = "SNAPSHOT_STALE";
  const result = readDemo(baseArgs({ readTrustedSnapshot: () => { throw err; } }));
  assert.deepEqual(result.snapshotStatus, { status: "stale" });
});

test("readDemo: snapshot corrompido/de outro ambiente/de outra credencial -> status dedicado, nunca 'fresh'", () => {
  for (const [code, expected] of [
    ["SNAPSHOT_CORRUPT", "corrupt"],
    ["SNAPSHOT_ENVIRONMENT_MISMATCH", "environment_mismatch"],
    ["SNAPSHOT_CREDENTIAL_MISMATCH", "credential_mismatch"],
  ]) {
    const err = new Error(code);
    err.code = code;
    const result = readDemo(baseArgs({ readTrustedSnapshot: () => { throw err; } }));
    assert.equal(result.snapshotStatus.status, expected);
  }
});

test("readDemo: erro sem code reconhecido -> 'unavailable' por padrão, nunca lança nem inventa 'fresh'", () => {
  const result = readDemo(baseArgs({ readTrustedSnapshot: () => { throw new Error("algo genérico"); } }));
  assert.equal(result.snapshotStatus.status, "unavailable");
});

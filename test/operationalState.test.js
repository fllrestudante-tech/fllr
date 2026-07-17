const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveOperationalState, STATES } = require("../lib/operationalState");

test("STATES: exporta os 7 estados esperados", () => {
  assert.deepEqual(STATES, ["RUNNING", "STOPPED", "DISABLED", "MANUAL", "ERROR", "STARTING", "UNKNOWN"]);
});

test("isSupervised:false sempre vira MANUAL, independente de qualquer outro campo (ex: Telegram Radar)", () => {
  const result = deriveOperationalState({ isSupervised: false, supervisorStatus: "running", healthStatus: "ok" });
  assert.equal(result.state, "MANUAL");
});

test("supervisorStatus ausente/null -> UNKNOWN (não dá pra classificar)", () => {
  const result = deriveOperationalState({ supervisorStatus: null });
  assert.equal(result.state, "UNKNOWN");
});

test("supervisorStatus=stopped -> STOPPED (desligamento pedido, não é falha)", () => {
  const result = deriveOperationalState({ supervisorStatus: "stopped" });
  assert.equal(result.state, "STOPPED");
});

test("supervisorStatus=crashed -> ERROR", () => {
  const result = deriveOperationalState({ supervisorStatus: "crashed" });
  assert.equal(result.state, "ERROR");
});

test("running, acabou de subir (< 90s), sem health ainda -> STARTING", () => {
  const now = 1000000;
  const result = deriveOperationalState({
    supervisorStatus: "running",
    startedAt: new Date(now - 5000).toISOString(),
    healthStatus: null,
    now,
  });
  assert.equal(result.state, "STARTING");
});

test("running + health ok -> RUNNING, degraded:false", () => {
  const result = deriveOperationalState({ supervisorStatus: "running", healthStatus: "ok", startedAt: new Date(0).toISOString(), now: 1000000 });
  assert.equal(result.state, "RUNNING");
  assert.equal(result.degraded, false);
});

test("running + health degraded -> continua RUNNING, mas degraded:true (flag de severidade, não estado próprio)", () => {
  const result = deriveOperationalState({ supervisorStatus: "running", healthStatus: "degraded", startedAt: new Date(0).toISOString(), now: 1000000 });
  assert.equal(result.state, "RUNNING");
  assert.equal(result.degraded, true);
});

test("running + health down -> ERROR (só seguro porque o supervisor já confirma que está vivo)", () => {
  const result = deriveOperationalState({ supervisorStatus: "running", healthStatus: "down", startedAt: new Date(0).toISOString(), now: 1000000 });
  assert.equal(result.state, "ERROR");
});

test("running, passou da janela de STARTING, ainda sem healthStatus -> RUNNING (não fica preso em STARTING pra sempre)", () => {
  const now = 1000000;
  const result = deriveOperationalState({
    supervisorStatus: "running",
    startedAt: new Date(now - 200000).toISOString(), // bem além dos 90s
    healthStatus: null,
    now,
  });
  assert.equal(result.state, "RUNNING");
});

test("supervisorStatus desconhecido (valor não mapeado) -> UNKNOWN", () => {
  const result = deriveOperationalState({ supervisorStatus: "algo_que_nao_existe" });
  assert.equal(result.state, "UNKNOWN");
});

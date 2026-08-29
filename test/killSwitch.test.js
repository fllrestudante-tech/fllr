const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  STATES,
  readRawKillSwitchState,
  readEffectiveKillSwitchState,
  armDemo,
  blockNewExposure,
  setEmergencyExitOnly,
  assertNewExposureArmed,
  NewExposureBlockedError,
  DEFAULT_MAX_ARMED_AGE_MS,
} = require("../lib/killSwitch");

function tempKillSwitchPath(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bot-cripto10-killswitch-${label}-`));
  return { dir, filePath: path.join(dir, "sub", "kill-switch.json") };
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const NOW = 1_756_000_000_000;

// =====================================================================
// Bloqueador 3 -- estados explícitos, nunca um booleano ambíguo.
// =====================================================================

test("readRawKillSwitchState: arquivo AUSENTE -> BLOCK_NEW_EXPOSURE (default seguro, nunca ARMED_DEMO por omissão)", (t) => {
  const { dir, filePath } = tempKillSwitchPath("absent");
  t.after(() => cleanup(dir));
  const state = readRawKillSwitchState(filePath);
  assert.equal(state.state, STATES.BLOCK_NEW_EXPOSURE);
  assert.equal(state.source, "default_absent");
});

test("readRawKillSwitchState: arquivo VAZIO -> BLOCK_NEW_EXPOSURE", (t) => {
  const { dir, filePath } = tempKillSwitchPath("empty");
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
  const state = readRawKillSwitchState(filePath);
  assert.equal(state.state, STATES.BLOCK_NEW_EXPOSURE);
  assert.equal(state.source, "corrupt");
});

test("readRawKillSwitchState: arquivo CORROMPIDO (JSON inválido) -> BLOCK_NEW_EXPOSURE", (t) => {
  const { dir, filePath } = tempKillSwitchPath("corrupt-json");
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{ isso nao e JSON valido ]]]");
  const state = readRawKillSwitchState(filePath);
  assert.equal(state.state, STATES.BLOCK_NEW_EXPOSURE);
  assert.equal(state.reason, "corrupt_or_unknown_state");
});

test("readRawKillSwitchState: campo 'state' com valor DESCONHECIDO -> BLOCK_NEW_EXPOSURE, nunca um 4º estado silencioso", (t) => {
  const { dir, filePath } = tempKillSwitchPath("unknown-state");
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ state: "TOTALMENTE_INVENTADO", setAt: new Date().toISOString() }));
  const state = readRawKillSwitchState(filePath);
  assert.equal(state.state, STATES.BLOCK_NEW_EXPOSURE);
});

test("readRawKillSwitchState: 'state' ausente ou tipo errado -> BLOCK_NEW_EXPOSURE", (t) => {
  const { dir, filePath } = tempKillSwitchPath("missing-state-field");
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ setAt: new Date().toISOString() }));
  assert.equal(readRawKillSwitchState(filePath).state, STATES.BLOCK_NEW_EXPOSURE);
});

test("readRawKillSwitchState: 'setAt' ausente/inválido, mesmo com 'state' válido -> BLOCK_NEW_EXPOSURE (íntegro exige AMBOS)", (t) => {
  const { dir, filePath } = tempKillSwitchPath("missing-setat");
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ state: STATES.ARMED_DEMO }));
  assert.equal(readRawKillSwitchState(filePath).state, STATES.BLOCK_NEW_EXPOSURE);
});

test("armDemo + readRawKillSwitchState: grava ARMED_DEMO com motivo e timestamp", (t) => {
  const { dir, filePath } = tempKillSwitchPath("arm");
  t.after(() => cleanup(dir));
  armDemo(filePath, { reason: "validação manual do operador", now: NOW });
  const state = readRawKillSwitchState(filePath);
  assert.equal(state.state, STATES.ARMED_DEMO);
  assert.equal(state.reason, "validação manual do operador");
  assert.equal(state.setAt, new Date(NOW).toISOString());
});

test("blockNewExposure / setEmergencyExitOnly: gravam os estados corretos", (t) => {
  const { dir, filePath } = tempKillSwitchPath("explicit-states");
  t.after(() => cleanup(dir));
  blockNewExposure(filePath, { reason: "operador pausou", now: NOW });
  assert.equal(readRawKillSwitchState(filePath).state, STATES.BLOCK_NEW_EXPOSURE);
  setEmergencyExitOnly(filePath, { reason: "sair de tudo", now: NOW });
  assert.equal(readRawKillSwitchState(filePath).state, STATES.EMERGENCY_EXIT_ONLY);
});

// =====================================================================
// Frescor -- ARMED_DEMO precisa ser recente, não só íntegro.
// =====================================================================

test("readEffectiveKillSwitchState: ARMED_DEMO DENTRO da janela de frescor -> permanece ARMED_DEMO", (t) => {
  const { dir, filePath } = tempKillSwitchPath("fresh");
  t.after(() => cleanup(dir));
  armDemo(filePath, { reason: "teste", now: NOW });
  const effective = readEffectiveKillSwitchState(filePath, { now: NOW + 1000 });
  assert.equal(effective.state, STATES.ARMED_DEMO);
});

test("readEffectiveKillSwitchState: ARMED_DEMO FORA da janela de frescor (default 15min) -> reinterpretado como BLOCK_NEW_EXPOSURE, nunca reescreve o arquivo sozinho", (t) => {
  const { dir, filePath } = tempKillSwitchPath("stale");
  t.after(() => cleanup(dir));
  armDemo(filePath, { reason: "teste", now: NOW });
  const effective = readEffectiveKillSwitchState(filePath, { now: NOW + DEFAULT_MAX_ARMED_AGE_MS + 1 });
  assert.equal(effective.state, STATES.BLOCK_NEW_EXPOSURE);
  assert.equal(effective.reason, "armed_demo_expired");
  // o ARQUIVO em si continua dizendo ARMED_DEMO -- só a leitura EFETIVA reinterpreta.
  assert.equal(readRawKillSwitchState(filePath).state, STATES.ARMED_DEMO);
});

test("readEffectiveKillSwitchState: janela de frescor customizável via maxArmedAgeMs", (t) => {
  const { dir, filePath } = tempKillSwitchPath("custom-window");
  t.after(() => cleanup(dir));
  armDemo(filePath, { reason: "teste", now: NOW });
  assert.equal(readEffectiveKillSwitchState(filePath, { now: NOW + 5000, maxArmedAgeMs: 3000 }).state, STATES.BLOCK_NEW_EXPOSURE);
  assert.equal(readEffectiveKillSwitchState(filePath, { now: NOW + 2000, maxArmedAgeMs: 3000 }).state, STATES.ARMED_DEMO);
});

test("readEffectiveKillSwitchState: BLOCK_NEW_EXPOSURE/EMERGENCY_EXIT_ONLY nunca expiram (frescor só se aplica a ARMED_DEMO)", (t) => {
  const { dir, filePath } = tempKillSwitchPath("no-expiry-for-block");
  t.after(() => cleanup(dir));
  setEmergencyExitOnly(filePath, { reason: "teste", now: NOW });
  const effective = readEffectiveKillSwitchState(filePath, { now: NOW + 999 * 24 * 60 * 60 * 1000 });
  assert.equal(effective.state, STATES.EMERGENCY_EXIT_ONLY);
});

// =====================================================================
// assertNewExposureArmed
// =====================================================================

test("assertNewExposureArmed: BLOCK_NEW_EXPOSURE -> lança NewExposureBlockedError", (t) => {
  const { dir, filePath } = tempKillSwitchPath("assert-blocked");
  t.after(() => cleanup(dir));
  assert.throws(() => assertNewExposureArmed(filePath, { now: NOW }), NewExposureBlockedError);
});

test("assertNewExposureArmed: ARMED_DEMO fresco -> não lança", (t) => {
  const { dir, filePath } = tempKillSwitchPath("assert-ok");
  t.after(() => cleanup(dir));
  armDemo(filePath, { reason: "teste", now: NOW });
  assert.doesNotThrow(() => assertNewExposureArmed(filePath, { now: NOW + 1000 }));
});

test("assertNewExposureArmed: ARMED_DEMO expirado -> lança (mesmo caminho de BLOCK_NEW_EXPOSURE)", (t) => {
  const { dir, filePath } = tempKillSwitchPath("assert-expired");
  t.after(() => cleanup(dir));
  armDemo(filePath, { reason: "teste", now: NOW });
  assert.throws(() => assertNewExposureArmed(filePath, { now: NOW + DEFAULT_MAX_ARMED_AGE_MS + 1 }), (err) => {
    assert.equal(err.code, "NEW_EXPOSURE_BLOCKED");
    assert.equal(err.state, STATES.BLOCK_NEW_EXPOSURE);
    assert.equal(err.reason, "armed_demo_expired");
    return true;
  });
});

test("assertNewExposureArmed: EMERGENCY_EXIT_ONLY -> lança (não autoriza nova exposição, só bloqueia diferente de BLOCK)", (t) => {
  const { dir, filePath } = tempKillSwitchPath("assert-emergency");
  t.after(() => cleanup(dir));
  setEmergencyExitOnly(filePath, { reason: "teste", now: NOW });
  assert.throws(() => assertNewExposureArmed(filePath, { now: NOW }), NewExposureBlockedError);
});

test("ciclo completo: BLOCK_NEW_EXPOSURE -> armDemo -> ARMED_DEMO -> blockNewExposure -> BLOCK_NEW_EXPOSURE de novo", (t) => {
  const { dir, filePath } = tempKillSwitchPath("cycle");
  t.after(() => cleanup(dir));
  assert.throws(() => assertNewExposureArmed(filePath, { now: NOW }));
  armDemo(filePath, { reason: "teste", now: NOW });
  assert.doesNotThrow(() => assertNewExposureArmed(filePath, { now: NOW }));
  blockNewExposure(filePath, { reason: "encerrado", now: NOW });
  assert.throws(() => assertNewExposureArmed(filePath, { now: NOW }));
});

test("nenhuma função deste módulo cria ARMED_DEMO automaticamente sem chamada explícita a armDemo() -- varredura do próprio código-fonte", () => {
  const source = fs.readFileSync(require.resolve("../lib/killSwitch"), "utf8");
  // ARMED_DEMO só pode aparecer como valor literal dentro da definição de
  // STATES e dentro da função armDemo() em si -- nenhum OUTRO lugar do
  // arquivo deveria produzir esse estado.
  const occurrences = [...source.matchAll(/ARMED_DEMO/g)].length;
  // STATES.ARMED_DEMO (definição) + "ARMED_DEMO": "ARMED_DEMO" (valor) +
  // referências dentro de armDemo/comentários -- valor exato não importa
  // tanto quanto confirmar que writeKillSwitchState(..., STATES.ARMED_DEMO, ...)
  // só é chamado de dentro de armDemo().
  const writeCallsWithArmedDemo = [...source.matchAll(/writeKillSwitchState\([^)]*STATES\.ARMED_DEMO/g)];
  assert.equal(writeCallsWithArmedDemo.length, 1, "só armDemo() deveria chamar writeKillSwitchState com STATES.ARMED_DEMO");
  assert.ok(occurrences > 0);
});

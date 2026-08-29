// Kill switch do perfil demo -- estados EXPLÍCITOS, nunca um booleano
// ambíguo "ligado/desligado". Verificado antes de toda operação privada
// classificada como aumento de exposição (lib/demoOrderGate.js); ações
// defensivas (reduzir/cancelar/proteger) continuam permitidas em QUALQUER
// estado válido -- só uma leitura verdadeiramente indeterminada bloqueia
// tudo, inclusive defesa.
//
// Estados:
//   BLOCK_NEW_EXPOSURE -- default seguro. Novas exposições bloqueadas;
//     ações defensivas permitidas. É o estado assumido quando o arquivo
//     está ausente, vazio, corrompido, ou com um valor não reconhecido --
//     NUNCA um 4º estado silencioso, sempre este mesmo rótulo estável.
//   ARMED_DEMO -- ÚNICO estado que autoriza nova exposição. Só existe se
//     alguém chamou armDemo() explicitamente (nenhum código deste projeto
//     chama isso sozinho) E o registro ainda está DENTRO da janela de
//     frescor (maxArmedAgeMs) -- um ARMED_DEMO esquecido há horas expira
//     de volta pra BLOCK_NEW_EXPOSURE automaticamente na LEITURA (nunca
//     reescreve o arquivo sozinho, só reinterpreta).
//   EMERGENCY_EXIT_ONLY -- sinalização explícita adicional (operador
//     decidiu que quer sair de tudo, não só bloquear entrada nova).
//     Mesmo efeito de gate que BLOCK_NEW_EXPOSURE (bloqueia aumento,
//     permite defesa) -- existe como rótulo semântico distinto pro painel
//     e para uma futura rotina de auto-saída, não muda a lógica de
//     autorização em si nesta rodada.
const fs = require("fs");
const path = require("path");
const { atomicWriteJsonSync } = require("./atomicWrite");
const { demoRuntimeDir } = require("./demoRuntimePaths");

const STATES = Object.freeze({
  BLOCK_NEW_EXPOSURE: "BLOCK_NEW_EXPOSURE",
  ARMED_DEMO: "ARMED_DEMO",
  EMERGENCY_EXIT_ONLY: "EMERGENCY_EXIT_ONLY",
});
const VALID_STATES = new Set(Object.values(STATES));

const DEFAULT_KILL_SWITCH_PATH = path.join(demoRuntimeDir(), "kill-switch.json");
const DEFAULT_MAX_ARMED_AGE_MS = 15 * 60 * 1000; // ARMED_DEMO expira em 15min sem renovação explícita

/**
 * Lê o estado bruto do arquivo, SEM aplicar a checagem de frescor --
 * usado internamente e pelo painel (que quer mostrar "ARMED_DEMO, mas
 * expirado" como informação, não só o resultado final booleano).
 */
function readRawKillSwitchState(filePath = DEFAULT_KILL_SWITCH_PATH) {
  if (!fs.existsSync(filePath)) {
    return { state: STATES.BLOCK_NEW_EXPOSURE, reason: null, setAt: null, source: "default_absent" };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.state !== "string" || !VALID_STATES.has(parsed.state)) {
      return { state: STATES.BLOCK_NEW_EXPOSURE, reason: "corrupt_or_unknown_state", setAt: null, source: "corrupt" };
    }
    if (typeof parsed.setAt !== "string" || Number.isNaN(Date.parse(parsed.setAt))) {
      return { state: STATES.BLOCK_NEW_EXPOSURE, reason: "missing_or_invalid_setAt", setAt: null, source: "corrupt" };
    }
    return {
      state: parsed.state,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      setAt: parsed.setAt,
      source: "file",
    };
  } catch {
    return { state: STATES.BLOCK_NEW_EXPOSURE, reason: "corrupt_or_unknown_state", setAt: null, source: "corrupt" };
  }
}

/**
 * Estado EFETIVO -- aplica a checagem de frescor sobre ARMED_DEMO. Esta é
 * a função que lib/demoOrderGate.js de fato consulta pra decidir se nova
 * exposição é permitida.
 */
function readEffectiveKillSwitchState(filePath = DEFAULT_KILL_SWITCH_PATH, { maxArmedAgeMs = DEFAULT_MAX_ARMED_AGE_MS, now = Date.now() } = {}) {
  const raw = readRawKillSwitchState(filePath);
  if (raw.state !== STATES.ARMED_DEMO) return raw;

  const setAtMs = Date.parse(raw.setAt);
  const ageMs = now - setAtMs;
  if (ageMs < 0 || ageMs > maxArmedAgeMs) {
    return { state: STATES.BLOCK_NEW_EXPOSURE, reason: "armed_demo_expired", setAt: raw.setAt, source: "expired" };
  }
  return raw;
}

function writeKillSwitchState(filePath, state, reason, now) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteJsonSync(filePath, { state, reason: reason ?? null, setAt: new Date(now).toISOString() });
}

/**
 * ÚNICA função que produz ARMED_DEMO -- nenhum outro código deste projeto
 * chama isto automaticamente (verificado pela varredura de segurança nos
 * testes). Ação humana/operacional explícita. `now` injetável só pra
 * teste (produção sempre usa Date.now(), o default).
 */
function armDemo(filePath = DEFAULT_KILL_SWITCH_PATH, { reason = "manual", now = Date.now() } = {}) {
  writeKillSwitchState(filePath, STATES.ARMED_DEMO, reason, now);
}

function blockNewExposure(filePath = DEFAULT_KILL_SWITCH_PATH, { reason = "manual", now = Date.now() } = {}) {
  writeKillSwitchState(filePath, STATES.BLOCK_NEW_EXPOSURE, reason, now);
}

function setEmergencyExitOnly(filePath = DEFAULT_KILL_SWITCH_PATH, { reason = "manual", now = Date.now() } = {}) {
  writeKillSwitchState(filePath, STATES.EMERGENCY_EXIT_ONLY, reason, now);
}

class NewExposureBlockedError extends Error {
  constructor(state, reason) {
    super(`Nova exposição bloqueada -- estado do kill switch: ${state}${reason ? ` (motivo: ${reason})` : ""}.`);
    this.name = this.constructor.name;
    this.code = "NEW_EXPOSURE_BLOCKED";
    this.state = state;
    this.reason = reason || null;
  }
}

/** Lança a menos que o estado efetivo seja EXATAMENTE ARMED_DEMO (e fresco). */
function assertNewExposureArmed(filePath = DEFAULT_KILL_SWITCH_PATH, opts = {}) {
  const effective = readEffectiveKillSwitchState(filePath, opts);
  if (effective.state !== STATES.ARMED_DEMO) {
    throw new NewExposureBlockedError(effective.state, effective.reason);
  }
}

module.exports = {
  STATES,
  VALID_STATES,
  DEFAULT_KILL_SWITCH_PATH,
  DEFAULT_MAX_ARMED_AGE_MS,
  readRawKillSwitchState,
  readEffectiveKillSwitchState,
  armDemo,
  blockNewExposure,
  setEmergencyExitOnly,
  assertNewExposureArmed,
  NewExposureBlockedError,
};

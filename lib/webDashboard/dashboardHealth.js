// Health check local do dashboard -- separa TRÊS coisas propositalmente:
//   (1) "processo HTTP vivo": trivial -- se esta rota respondeu (mesmo com
//       503), o processo está de pé. Não precisa de campo próprio.
//   (2) "systemReady" -- prontidão do SISTEMA (processo/banco/perfil
//       resolvido), independente de trading. É o que um wrapper de
//       autostart quer saber antes de abrir o navegador.
//   (3) "newExposureAllowed" -- permissão de NEGOCIAR (aumentar
//       exposição), sempre `false` nesta fase (perfil safe nunca opera;
//       perfil demo em modo observe nunca chama função mutável nenhuma;
//       "execution" ainda não tem um caminho "pronto" reconhecido por
//       este endpoint). `blockReason` explica POR QUE, sempre presente
//       quando `newExposureAllowed` é false -- nunca confundido com o
//       motivo de `ready`/httpStatus (2) e (3) são checagens
//       independentes: o sistema pode estar `systemReady:true` (saudável
//       pra observação) com `newExposureAllowed:false` ao mesmo tempo --
//       isso é o estado NORMAL e esperado do perfil demo em modo observe.
// Somente leitura, local, leve, determinístico. Nunca chama Bybit,
// Telegram, AgentRouter ou IA. Nunca escreve no banco, nunca tenta
// reparo/migração. Nunca revela caminho absoluto, stack ou detalhe interno
// na resposta pública -- só os campos enumerados abaixo.
const fs = require("fs");
const Database = require("better-sqlite3");
const { resolveSupervisorProfile, selectSupervisedChildren } = require("../supervisorProfile");
const { isTradingExecutionEnabled } = require("../tradingExecutionGate");
const { safeResolveDemoExecutionMode, EXECUTION_MODES } = require("../demoExecutionMode");
const { readTrustedSnapshot } = require("../demoAccountSnapshot");
const killSwitchModule = require("../killSwitch");
const { isDemoConfigured, readSupervisorProcessState } = require("./demoReader");
const { DEFAULT_DB_PATH } = require("../infra/db");

const SERVICE_NAME = "crypto10-dashboard";

// Estrutura mínima que os readers de lib/webDashboard/* já dependem (ver
// fontes citadas nas rotas de scripts/dashboardServer.js) -- só a presença
// das tabelas, nunca conteúdo, nunca migração se ausente.
const REQUIRED_TABLES = ["asset", "candles"];

/**
 * Nunca propaga o valor bruto de SUPERVISOR_PROFILE pra fora -- se
 * `resolveSupervisorProfile` lançar (perfil não reconhecido), o rótulo
 * público é só "invalid", nunca o texto recebido.
 */
function safeResolveMode(env) {
  try {
    return resolveSupervisorProfile(env);
  } catch {
    return "invalid";
  }
}

/**
 * Conexão read-only própria (nunca compete por lock com os coletores em
 * WAL, mesmo padrão de lib/databaseHealth.js), fechada sempre no `finally`.
 * `fileMustExist: true` já falha rápido se o arquivo não existir -- nunca
 * cria/migra nada. Qualquer exceção (arquivo corrompido, não é um SQLite
 * válido, etc.) vira `false`, nunca propaga a mensagem de erro (que o
 * better-sqlite3 costuma preencher com o caminho do arquivo).
 */
function checkDatabaseReadiness(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return false;
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const placeholders = REQUIRED_TABLES.map(() => "?").join(",");
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`).all(...REQUIRED_TABLES);
    return rows.length === REQUIRED_TABLES.length;
  } catch {
    return false;
  } finally {
    if (db) db.close();
  }
}

/**
 * Snapshot Demo fresco/íntegro/da credencial e símbolo certos -- reusa
 * exatamente a mesma validação de lib/demoAccountSnapshot.js::
 * readTrustedSnapshot (nunca reimplementa staleness/corrupção numa
 * segunda cópia). Nunca lança pra este health check -- qualquer motivo
 * de rejeição (ausente/velho/corrompido/ambiente errado/credencial
 * errada) vira só `false`.
 */
function checkSnapshotFresh(env, now, readSnapshot) {
  try {
    readSnapshot({ env, now });
    return true;
  } catch {
    return false;
  }
}

/**
 * Todo processo elegível pro perfil atual (lib/supervisorProfile.js::
 * selectSupervisedChildren) precisa aparecer como "running" no estado
 * real do supervisor -- nunca assume vivo por omissão (arquivo ausente
 * ou processo faltando -> false). Perfil inválido nunca é "pronto".
 */
function checkRequiredProcessesAlive(mode, env, readSupervisorState) {
  if (mode !== "safe" && mode !== "demo") return false;
  const supervisorState = readSupervisorState();
  if (!supervisorState) return false;
  const { children } = selectSupervisedChildren(mode, env);
  return children.every((child) => supervisorState[child.name] && supervisorState[child.name].status === "running");
}

/**
 * Motivo estável de `newExposureAllowed:false` -- SEMPRE calculado,
 * independente de `ready`/httpStatus. `null` só quando exposição
 * genuinamente permitida (nunca o caso hoje: perfil safe não opera,
 * perfil demo em modo observe nunca arma, e "execution" ainda não tem
 * caminho reconhecido por este endpoint).
 */
function computeBlockReason({ mode, executionMode, tradingExecutionEnabled, newExposureAllowed }) {
  if (newExposureAllowed) return null;
  if (mode === "safe") return "profile_safe";
  if (mode !== "demo") return "profile_invalid";
  if (executionMode === EXECUTION_MODES.OBSERVE) return tradingExecutionEnabled ? "kill_switch_block_new_exposure" : "execution_mode_observe";
  if (executionMode === EXECUTION_MODES.EXECUTION) return "kill_switch_block_new_exposure";
  return "execution_mode_invalid";
}

/**
 * Devolve { ready, httpStatus, body }. Dois caminhos pra `ready`
 * (httpStatus 200):
 *   - perfil "safe": EXATAMENTE a mesma condição de sempre (gate
 *     financeiro desligado + banco pronto) -- comportamento inalterado.
 *   - perfil "demo" + DEMO_EXECUTION_MODE=observe: saudável PRA
 *     OBSERVAÇÃO exige TODAS as condições -- endpoint/config demo
 *     válidos, leitura privada habilitada, gate financeiro desligado,
 *     banco pronto, processos obrigatórios vivos, snapshot fresco, E
 *     kill switch efetivamente bloqueando nova exposição (nunca ARMED_DEMO
 *     -- um kill switch armado durante "observação" seria uma bandeira
 *     vermelha, não um sinal de saudável).
 * Qualquer outra combinação (perfil inválido, demo sem modo válido, demo
 * em modo "execution") nunca é `ready` por este endpoint nesta fase --
 * fail-closed, nunca 200 numa configuração ainda não coberta.
 */
function computeDashboardHealth({
  env = process.env,
  dbPath = DEFAULT_DB_PATH,
  now = Date.now(),
  readSupervisorState = readSupervisorProcessState,
  readSnapshot = readTrustedSnapshot,
  readEffectiveKillSwitchState = killSwitchModule.readEffectiveKillSwitchState,
} = {}) {
  const mode = safeResolveMode(env);
  const executionMode = mode === "demo" ? safeResolveDemoExecutionMode(env) : null;
  const tradingExecutionEnabled = isTradingExecutionEnabled(env);
  const database = checkDatabaseReadiness(dbPath) ? "ok" : "unavailable";
  const requiredProcessesAlive = checkRequiredProcessesAlive(mode, env, readSupervisorState);

  const configured = mode === "demo" && isDemoConfigured(env);
  const privateReadReady = configured && env.DEMO_PRIVATE_READ_ENABLED === "true";
  const snapshotFresh = mode === "demo" ? checkSnapshotFresh(env, now, readSnapshot) : false;

  // Autorização REAL de aumento de exposição -- as MESMAS duas condições
  // que lib/demoOrderGate.js exige (TRADING_EXECUTION_ENABLED=true E kill
  // switch efetivamente ARMED_DEMO), nunca um `false` hardcoded: um kill
  // switch armado é informação real que este painel precisa refletir
  // honestamente, mesmo fora do perfil demo (onde ambas as condições são
  // estruturalmente impossíveis de coincidir, mas a checagem continua
  // sendo feita, nunca assumida).
  const killState = readEffectiveKillSwitchState(undefined, { now });
  const newExposureAllowed = tradingExecutionEnabled && killState.state === killSwitchModule.STATES.ARMED_DEMO;

  const systemReady = (mode === "safe" || mode === "demo") && database === "ok" && requiredProcessesAlive;

  let ready;
  if (mode === "safe") {
    ready = tradingExecutionEnabled === false && database === "ok" && requiredProcessesAlive;
  } else if (mode === "demo" && executionMode === EXECUTION_MODES.OBSERVE) {
    ready = tradingExecutionEnabled === false && database === "ok" && requiredProcessesAlive && privateReadReady && snapshotFresh && newExposureAllowed === false;
  } else {
    ready = false;
  }

  const blockReason = computeBlockReason({ mode, executionMode, tradingExecutionEnabled, newExposureAllowed });

  return {
    ready,
    httpStatus: ready ? 200 : 503,
    body: {
      status: ready ? "ok" : "degraded",
      service: SERVICE_NAME,
      mode,
      executionMode,
      tradingExecutionEnabled,
      database,
      systemReady,
      newExposureAllowed,
      privateReadReady,
      snapshotFresh,
      blockReason,
    },
  };
}

module.exports = { SERVICE_NAME, REQUIRED_TABLES, computeDashboardHealth };

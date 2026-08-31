// Caixa de acompanhamento do perfil demo -- SÓ LEITURA LOCAL, nunca chama a
// Bybit, Telegram ou AgentRouter (mesma disciplina de todo lib/webDashboard/*
// -- ver comentário no topo de scripts/dashboardServer.js). Nunca revela
// segredo, caminho absoluto, stack ou resposta bruta da Bybit.
//
// Vocabulário estável (Bloqueador 7) -- nunca um booleano genérico
// "ativo/inativo": configured / privateReadEnabled / newExposureArmed /
// emergencyExitAvailable / dataFresh / lastSuccessfulPrivateReadAt /
// lastDecision / blockReason. Dado ausente ou velho demais é exibido como
// "stale"/"unavailable" -- NUNCA um zero inventado (ex.: exposição
// mostrando "$0" quando na verdade é "não sei" seria pior que não mostrar
// nada).
const fs = require("fs");
const path = require("path");
const { resolveSupervisorProfile } = require("../supervisorProfile");
const { isTradingExecutionEnabled } = require("../tradingExecutionGate");
const { safeResolveDemoExecutionMode } = require("../demoExecutionMode");
const killSwitchModule = require("../killSwitch");
const ledgerModule = require("../demoOrderLedger");
const demoTradingGate = require("../demoTradingGate");
const { loadDemoRiskLimitsConfig } = require("../demoRiskLimits");
const stateModule = require("../state");
const connectivityStatus = require("../connectivityStatus");
const snapshotModule = require("../demoAccountSnapshot");
const demoObserveStateModule = require("../demoObserveState");

// Vocabulário estável do status do snapshot (item 3 da Rodada 4) --
// nunca expõe o código de erro interno cru pro dashboard, sempre um
// destes rótulos. "fresh" é o único que autoriza a UI a mostrar
// exposição/posições/ordens como confiáveis; qualquer outro é
// "olha, isto não é confiável agora", nunca um zero inventado.
const SNAPSHOT_STATUS_BY_ERROR_CODE = Object.freeze({
  SNAPSHOT_MISSING: "unavailable",
  SNAPSHOT_CORRUPT: "corrupt",
  SNAPSHOT_STALE: "stale",
  SNAPSHOT_ENVIRONMENT_MISMATCH: "environment_mismatch",
  SNAPSHOT_CREDENTIAL_MISMATCH: "credential_mismatch",
});

/** Nunca lança -- qualquer falha ao ler o snapshot vira um status estável, nunca derruba a rota. */
function readDemoSnapshotStatus(env, now, readTrustedSnapshot) {
  try {
    const snapshot = readTrustedSnapshot({ env, now });
    return {
      status: "fresh",
      capturedAt: new Date(snapshot.capturedAtMs).toISOString(),
      exposureUsd: snapshot.exposureUsd,
      equityUsd: snapshot.equityUsd,
      positionsCount: snapshot.positions.length,
      openOrdersCount: snapshot.openOrders.length,
    };
  } catch (err) {
    return { status: SNAPSHOT_STATUS_BY_ERROR_CODE[err.code] || "unavailable" };
  }
}

/**
 * Metadata do instrumento + estado do símbolo (leverage efetiva, modo
 * one-way/cross), extraídos do MESMO snapshot confiável usado por
 * readDemoSnapshotStatus -- campo NOVO e SEPARADO (nunca dentro de
 * snapshotStatus, cujo formato já é testado e não muda nesta rodada).
 * Nunca lança -- snapshot indisponível/velho/corrompido vira
 * { instrumentInfo: null, symbolState: null }, nunca um valor inventado.
 * tradeModeLabel/positionModeLabel são rótulos ESTÁVEIS pro painel (nunca
 * o número bruto da Bybit exposto sem tradução) -- "unknown" só quando o
 * número não é um dos dois valores conhecidos (defesa contra um valor
 * futuro da Bybit que este projeto ainda não mapeou, nunca um chute).
 */
function readDemoSymbolDetails(env, now, readTrustedSnapshot) {
  try {
    const snapshot = readTrustedSnapshot({ env, now });
    const symbolState = snapshot.symbolState
      ? {
          hasOpenPosition: snapshot.symbolState.hasOpenPosition,
          side: snapshot.symbolState.side,
          qty: snapshot.symbolState.qty,
          entryPrice: snapshot.symbolState.entryPrice,
          stopLossPrice: snapshot.symbolState.stopLossPrice,
          effectiveLeverage: snapshot.symbolState.effectiveLeverage,
          tradeModeLabel: snapshot.symbolState.tradeMode === 0 ? "cross" : snapshot.symbolState.tradeMode === 1 ? "isolated" : "unknown",
          positionModeLabel: snapshot.symbolState.positionIdx === 0 ? "one-way" : "hedge",
        }
      : null;
    return { instrumentInfo: snapshot.instrumentInfo || null, symbolState };
  } catch {
    return { instrumentInfo: null, symbolState: null };
  }
}

const RUNTIME_DIR = path.join(__dirname, "..", "..", "runtime");
const SUPERVISOR_STATE_FILE = path.join(RUNTIME_DIR, "processes", "state.json");
const DATA_FRESH_MAX_AGE_MS = 5 * 60 * 1000; // 5min -- além disso, dado de leitura privada é considerado "stale"

function safeResolveMode(env) {
  try {
    return resolveSupervisorProfile(env);
  } catch {
    return "invalid";
  }
}

/** Nunca lança -- config inválida vira { valid: false, error: code }, nunca derruba a rota inteira. */
function safeLoadDemoLimits(env) {
  try {
    return { valid: true, limits: loadDemoRiskLimitsConfig(env) };
  } catch (err) {
    return { valid: false, error: err.code || "INVALID_CONFIG" };
  }
}

/** `configured` -- validação estrutural completa (perfil+endpoint+credenciais), sem revelar QUAL checagem falhou (isso vira detalhe só em blockReason, nunca aqui). */
function isDemoConfigured(env) {
  if (safeResolveMode(env) !== "demo") return false;
  try {
    demoTradingGate.validateDemoBoot(env);
    return true;
  } catch {
    return false;
  }
}

function readSupervisorProcessState(filePath = SUPERVISOR_STATE_FILE) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * `botState` (data/state.json) só existe/é atualizado quando index.js (o
 * bot) já rodou pelo menos uma vez -- ausente é o estado normal enquanto o
 * perfil demo nunca foi ativado. Saldo (equity) não é lido daqui de
 * propósito -- este dashboard nunca chama a Bybit, e o bot hoje não
 * persiste equity em nenhum arquivo local (lacuna conhecida, documentada,
 * não resolvida nesta rodada) -- `balance` fica sempre null/"unavailable",
 * nunca um zero inventado.
 */
function readDemoTradingState(loadState = stateModule.load) {
  const botState = loadState();
  return {
    isOpened: botState.isOpened,
    side: botState.side,
    qty: botState.qty,
    entryPrice: botState.entryPrice,
    stopLossPrice: botState.stopLossPrice,
    takeProfitPrice: botState.takeProfitPrice,
    dailyLoss: botState.dailyLoss,
    consecutiveLosses: botState.consecutiveLosses,
    circuitBreakerUntil: botState.circuitBreakerUntil,
    lastTradeTime: botState.lastTradeTime || null,
    lastAiAssessment: botState.lastAiAssessment || null,
    balance: null, // ver comentário acima -- lacuna conhecida, não resolvida nesta rodada
  };
}

/**
 * `/api/v1/demo` -- painel de acompanhamento do perfil demo. Composto
 * inteiramente de leituras locais já existentes -- nenhuma chamada nova
 * de rede, nenhuma chamada à Bybit. Todas as dependências de I/O são
 * injetáveis (mesmo padrão de dbPath em lib/webDashboard/dashboardHealth.js)
 * -- produção usa os caminhos/módulos reais via default, teste recebe
 * fixtures/fakes, nunca tocando arquivo real.
 */
function readDemo({
  env = process.env,
  now = Date.now(),
  loadState = stateModule.load,
  readEffectiveKillSwitchState = killSwitchModule.readEffectiveKillSwitchState,
  readSupervisorState = readSupervisorProcessState,
  readConnectivity = connectivityStatus.getStatus,
  getLastSuccessfulReadAt = ledgerModule.getLastSuccessfulReadAt,
  getLastDecision = ledgerModule.getLastDecision,
  readTrustedSnapshot = snapshotModule.readTrustedSnapshot,
  readObserveState = demoObserveStateModule.readObserveState,
} = {}) {
  const mode = safeResolveMode(env);
  const executionMode = mode === "demo" ? safeResolveDemoExecutionMode(env) : null;
  const configured = isDemoConfigured(env);
  const privateReadEnabled = configured && env.DEMO_PRIVATE_READ_ENABLED === "true";
  const tradingExecutionEnabled = isTradingExecutionEnabled(env);

  const killState = readEffectiveKillSwitchState(undefined, { now });
  const newExposureArmed = killState.state === killSwitchModule.STATES.ARMED_DEMO;
  // Ação defensiva/saída de emergência exige a MESMA base que qualquer
  // mutação (TRADING_EXECUTION_ENABLED + config estrutural válida) --
  // sem isso, nem cancelar/reduzir/proteger alcança a Bybit (ver
  // lib/bybit.js::assertPrivateMutationAuthorized). ARMED_DEMO NÃO é
  // exigido pra emergência -- é exatamente o oposto do que ARMED_DEMO
  // controla.
  const emergencyExitAvailable = configured && tradingExecutionEnabled;

  const lastSuccessfulPrivateReadAt = getLastSuccessfulReadAt();
  const dataFresh = lastSuccessfulPrivateReadAt != null && now - lastSuccessfulPrivateReadAt <= DATA_FRESH_MAX_AGE_MS;

  const lastDecisionRaw = getLastDecision();
  const lastDecision = lastDecisionRaw
    ? { allowed: lastDecisionRaw.allowed, kind: lastDecisionRaw.kind, opName: lastDecisionRaw.opName, reason: lastDecisionRaw.reason, at: new Date(lastDecisionRaw.atMs).toISOString() }
    : null;
  const blockReason = lastDecisionRaw && lastDecisionRaw.allowed === false ? lastDecisionRaw.reason : null;

  const demoLimits = safeLoadDemoLimits(env);
  // `trading` (posição/qty/stop/pnl local) só é exibido como confiável se
  // os dados forem frescos o bastante -- caso contrário, "stale" em vez de
  // reaproveitar um valor potencialmente desatualizado sem avisar.
  const tradingRaw = readDemoTradingState(loadState);
  const trading = dataFresh || !configured ? tradingRaw : { ...tradingRaw, staleness: "stale" };

  const supervisorState = readSupervisorState();
  const telegramStatus = readConnectivity();
  const symbolDetails = mode === "demo" ? readDemoSymbolDetails(env, now, readTrustedSnapshot) : { instrumentInfo: null, symbolState: null };
  const observeState = readObserveState();
  // budget_disabled -- AGENTROUTER_BUDGET_ENABLED ausente ou diferente de
  // "true" (mesma comparação estrita de config.js): AgentRouter externo está
  // OFF por construção, nenhuma chamada é sequer tentada. Mostrado
  // EXPLICITAMENTE nesse estado -- nunca finge uma avaliação recente nem
  // omite o campo silenciosamente, mesmo que `lastAiAssessment` ainda
  // carregue um valor antigo de antes da flag ser desligada. shadow -- flag
  // ligada E já produziu pelo menos uma avaliação (o AI Gateway em si é
  // SEMPRE shadow-only, nunca aprova ordem, ver comentário de
  // index.js::maybeRunAiAssessment); offline -- flag ligada mas nunca rodou
  // ainda ou o provider não está configurado. Nunca um quarto rótulo.
  const agentRouterStatus = env.AGENTROUTER_BUDGET_ENABLED !== "true" ? "budget_disabled" : tradingRaw.lastAiAssessment ? "shadow" : "offline";

  return {
    environment: mode === "demo" ? (executionMode === "observe" ? "BYBIT DEMO — OBSERVAÇÃO" : "BYBIT DEMO") : "SAFE",
    mode,
    executionMode,
    configured,
    privateReadEnabled,
    newExposureArmed,
    emergencyExitAvailable,
    dataFresh,
    lastSuccessfulPrivateReadAt: lastSuccessfulPrivateReadAt != null ? new Date(lastSuccessfulPrivateReadAt).toISOString() : null,
    lastDecision,
    blockReason,
    killSwitchState: killState.state,
    killSwitchReason: killState.reason,
    tradingExecutionEnabled,
    riskLimits: demoLimits.valid ? demoLimits.limits : null,
    riskLimitsError: demoLimits.valid ? null : demoLimits.error,
    supervisor: supervisorState
      ? {
          children: Object.fromEntries(Object.entries(supervisorState).map(([name, s]) => [name, { pid: s.pid ?? null, status: s.status ?? null, totalRestarts: s.totalRestarts ?? 0, consecutiveRestarts: s.consecutiveRestarts ?? 0 }])),
        }
      : null,
    trading,
    snapshotStatus: readDemoSnapshotStatus(env, now, readTrustedSnapshot),
    instrumentInfo: symbolDetails.instrumentInfo,
    symbolState: symbolDetails.symbolState,
    lastAnalysis: observeState.lastAnalysis,
    lastHypotheticalDecision: observeState.lastHypotheticalDecision,
    agentRouterStatus,
    telegramStatus: telegramStatus ? { ok: telegramStatus.providers?.telegram ?? null, updatedAt: telegramStatus.updatedAt ?? null } : null,
    updatedAt: new Date(now).toISOString(),
  };
}

module.exports = {
  readDemo,
  isDemoConfigured,
  readDemoTradingState,
  readSupervisorProcessState,
  safeResolveMode,
  safeLoadDemoLimits,
  readDemoSnapshotStatus,
  readDemoSymbolDetails,
  DATA_FRESH_MAX_AGE_MS,
};

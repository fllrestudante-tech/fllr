// Gate CANÔNICO de operações privadas do perfil demo -- todo aumento de
// exposição (abrir posição, adicionar a uma posição, subir leverage)
// passa por assertDemoOrderAllowed() ANTES de HMAC/Axios (chamado dentro
// de lib/bybit.js::privatePost, o único lugar que de fato monta a
// requisição -- nenhum chamador, presente ou futuro, consegue contornar
// isto simplesmente chamando bybit.placeOrder() diretamente, porque a
// checagem mora DENTRO da função, não em código que o chamador poderia
// pular).
//
// SÍNCRONO de propósito inteiro -- leitura de estado + classificação +
// decisão + gravação da reserva acontecem numa única chamada de função
// sem nenhum `await` no meio. O event loop de thread única do Node
// garante que duas chamadas "concorrentes" (duas promises disparadas via
// Promise.all em lib/bybit.js) NUNCA interlaçam no meio desta função --
// a segunda só começa depois que a primeira já terminou de ler, decidir
// E gravar a reserva no ledger. É isso que impede duas ordens
// ultrapassarem juntas posição/notional/frequência/cooldown mesmo sem
// lock de arquivo real (ver lib/demoOrderLedger.js).
//
// Todo o ESTADO DE RISCO usado aqui vem de arquivos locais confiáveis
// (data/state.json, reconciliado por lib/state.js::reconcile() contra a
// posição REAL da Bybit via bybit.getPositions(); runtime/demo/order-ledger.json,
// gravado só por este próprio módulo) -- NUNCA de um payload passado por
// AgentRouter, Telegram, estratégia ou frontend. O `context` que este
// módulo aceita contém APENAS a ordem PROPOSTA (symbol/side/qty/price/
// leverage/stopLoss/reduceOnly/orderLinkId) -- nenhum campo de risco
// (posição atual, exposição, contagem de erros, etc.) é aceito vindo de
// fora; todos são recalculados aqui a partir das fontes locais.
const crypto = require("crypto");
const path = require("path");
// lib/state.js requer lib/bybit.js (bybit.getPositions em reconcile()) --
// requerer "./state" aqui, no topo, criaria um ciclo real (bybit.js já
// requer este arquivo): bybit -> demoOrderGate -> state -> bybit. Lazy
// require (dentro da função, não no topo do módulo) quebra o ciclo sem
// mudar nenhum comportamento -- só adia a resolução até depois que ambos
// os módulos já terminaram de carregar.
function requireStateModule() {
  return require("./state");
}
const ledger = require("./demoOrderLedger");
const killSwitch = require("./killSwitch");
const demoTradingGate = require("./demoTradingGate");
const snapshotModule = require("./demoAccountSnapshot");
const reservationLock = require("./demoReservationLock");
const decimal = require("./decimalSafety");
const { demoRuntimeDir } = require("./demoRuntimePaths");
const { resolveSupervisorProfile } = require("./supervisorProfile");
const { loadDemoRiskLimitsConfig, validateDemoOrder } = require("./demoRiskLimits");

// Caminho do lock de reserva cross-process (Bloqueador 5) -- NUNCA
// exposto como parâmetro público de assertDemoOrderAllowed (Bloqueador 2):
// segue o mesmo padrão de relocação de lib/killSwitch.js/lib/demoOrderLedger.js
// (só via CRYPTO10_DEMO_RUNTIME_DIR, resolvido no require() deste módulo --
// testes de subprocesso setam a env var ANTES do processo carregar
// qualquer módulo, nunca via argumento de função).
const DEFAULT_RESERVATION_LOCK_PATH = path.join(demoRuntimeDir(), "reservation.lock");

const OPERATION_KIND = Object.freeze({
  READ: "READ",
  INCREASE_EXPOSURE: "INCREASE_EXPOSURE",
  REDUCE_EXPOSURE: "REDUCE_EXPOSURE",
  CANCEL: "CANCEL",
  PROTECTIVE_STOP: "PROTECTIVE_STOP",
  ADMINISTRATION: "ADMINISTRATION",
  AMBIGUOUS: "AMBIGUOUS",
});

class DemoOrderBlockedError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Object.assign(this, extra);
  }
}
class AmbiguousOperationError extends DemoOrderBlockedError {
  constructor(opName) {
    super("DEMO_OPERATION_AMBIGUOUS", `Operação "${opName}" não pôde ser classificada com segurança (efeito sobre exposição/proteção indeterminado) -- bloqueada por padrão, nunca assumida como segura.`);
  }
}
class GateMisuseError extends Error {
  constructor(detail) {
    super(`Uso incorreto do gate demo: ${detail}`);
    this.name = this.constructor.name;
    this.code = "DEMO_GATE_MISUSE";
  }
}

// =====================================================================
// Classificação -- pura, sem I/O.
// =====================================================================

/**
 * side="Buy": stop fica ABAIXO do preço -- proteção melhora quando o
 * stop SOBE. side="Sell": stop fica ACIMA do preço -- proteção melhora
 * quando o stop DESCE. Ausência de stopLoss no payload (só mexendo em
 * trailing/take-profit parcial) é tratada como protetiva -- o resto do
 * código (lib/tradeLifecycle.js) só move trailing a favor, nunca contra,
 * por construção; este classificador não tem visibilidade sobre
 * trailingStop/activePrice pra julgar esses campos isoladamente, então
 * qualquer chamada que TAMBÉM altere stopLoss precisa passar pela
 * checagem de tightening abaixo.
 */
function classifyStopChange(params, positionSnapshot) {
  if (params.stopLoss === undefined) return OPERATION_KIND.PROTECTIVE_STOP;

  if (!positionSnapshot || !positionSnapshot.isOpened) return OPERATION_KIND.AMBIGUOUS;

  let newStop;
  try {
    newStop = decimal.parseStrictDecimal(params.stopLoss, "stopLoss");
  } catch {
    return OPERATION_KIND.AMBIGUOUS; // remover/zerar/inválido nunca é protetivo
  }

  const currentStop = positionSnapshot.stopLossPrice;
  if (currentStop === null || currentStop === undefined) return OPERATION_KIND.PROTECTIVE_STOP; // não havia proteção nenhuma antes -- criar uma é sempre protetivo

  let currentStopStr;
  try {
    currentStopStr = decimal.parseStrictDecimal(currentStop, "currentStopLoss");
  } catch {
    return OPERATION_KIND.AMBIGUOUS; // posição local sem stop numérico confiável -- nunca assume protetivo por omissão
  }

  const cmp = decimal.compareDecimalStrings(newStop, currentStopStr);
  if (positionSnapshot.side === "Buy") return cmp >= 0 ? OPERATION_KIND.PROTECTIVE_STOP : OPERATION_KIND.AMBIGUOUS;
  if (positionSnapshot.side === "Sell") return cmp <= 0 ? OPERATION_KIND.PROTECTIVE_STOP : OPERATION_KIND.AMBIGUOUS;
  return OPERATION_KIND.AMBIGUOUS;
}

/**
 * reduceOnly precisa ser EXPLICITAMENTE true pra qualquer ordem do lado
 * oposto à posição atual contar como redução -- nunca inferido pela
 * quantidade. Lado oposto + reduceOnly!=true é SEMPRE ambíguo (bloqueado),
 * mesmo que a quantidade "por acaso" fosse menor que a posição --
 * exigir explicitação elimina qualquer margem de má-interpretação.
 * Quantidade de redução MAIOR que a posição atual (reverteria pro lado
 * oposto) também é sempre ambíguo/bloqueado, mesmo com reduceOnly=true
 * (a própria Bybit capa isso no servidor, mas este gate nunca depende
 * disso -- decide sozinho, antes de qualquer rede).
 */
function classifyPlaceOrder(params, positionSnapshot) {
  const { side, qty, reduceOnly } = params;
  if (side !== "Buy" && side !== "Sell") return OPERATION_KIND.AMBIGUOUS;
  let qtyStr;
  try {
    qtyStr = decimal.parseStrictDecimal(qty, "qty");
  } catch {
    return OPERATION_KIND.AMBIGUOUS;
  }

  const isOpened = Boolean(positionSnapshot && positionSnapshot.isOpened);
  if (!isOpened) {
    return reduceOnly === true ? OPERATION_KIND.AMBIGUOUS : OPERATION_KIND.INCREASE_EXPOSURE;
  }

  const sameSide = side === positionSnapshot.side;
  if (sameSide) {
    return reduceOnly === true ? OPERATION_KIND.AMBIGUOUS : OPERATION_KIND.INCREASE_EXPOSURE;
  }

  if (reduceOnly !== true) return OPERATION_KIND.AMBIGUOUS;
  let currentQtyStr;
  try {
    currentQtyStr = decimal.parseStrictDecimal(positionSnapshot.qty, "currentQty");
  } catch {
    return OPERATION_KIND.AMBIGUOUS; // posição local sem qty numérica confiável -- nunca assume redução válida por omissão
  }
  if (decimal.compareDecimalStrings(qtyStr, currentQtyStr) > 0) return OPERATION_KIND.AMBIGUOUS;
  return OPERATION_KIND.REDUCE_EXPOSURE;
}

/**
 * `opName` -- nome exato da função de lib/bybit.js. `positionSnapshot` --
 * { isOpened, side, qty, stopLossPrice } (mesma forma devolvida por
 * buildTrustedDemoRiskState). setLeverage é tratado como INCREASE_EXPOSURE
 * de propósito, de forma conservadora: mudar leverage altera risco
 * diretamente, e distinguir "subiu" de "desceu" exigiria rastrear o
 * leverage efetivo atual (não persistido hoje) -- classificar sempre
 * como aumento super-bloqueia uma redução de leverage durante lockout,
 * o que é um custo aceitável (redundância de segurança a mais, nunca
 * menos) frente ao risco de deixar passar um aumento sem checagem.
 */
function classifyBybitOperation(opName, params = {}, positionSnapshot = null) {
  switch (opName) {
    case "getWalletBalance":
    case "getPositions":
    case "getClosedPnl":
    case "getOpenOrders":
      return OPERATION_KIND.READ;
    case "applyDemoFunds":
      return OPERATION_KIND.ADMINISTRATION;
    case "setLeverage":
      return OPERATION_KIND.INCREASE_EXPOSURE;
    case "placeOrder":
      return classifyPlaceOrder(params, positionSnapshot);
    case "setTradingStop":
      return classifyStopChange(params, positionSnapshot);
    // cancelOrder/cancelAllOrders NUNCA aumentam exposição -- na pior das
    // hipóteses reduzem (cancelam algo que ainda não executou). Não
    // exigem orderLinkId (não criam uma tentativa nova, só removem uma
    // ordem existente) -- ver ausência de tratamento especial pra estes
    // opNames dentro do bloco defensivo de assertDemoOrderAllowedInner.
    case "cancelOrder":
    case "cancelAllOrders":
      return OPERATION_KIND.CANCEL;
    default:
      return OPERATION_KIND.AMBIGUOUS; // função privada desconhecida -- nunca assumida segura por omissão
  }
}

// =====================================================================
// Estado de risco confiável -- só fontes locais.
// =====================================================================

/**
 * Estado de risco a partir de data/state.json -- usado SOMENTE pra:
 *  (a) classificar a operação (isOpened/side/qty/stopLossPrice, pra
 *      decidir INCREASE_EXPOSURE vs REDUCE_EXPOSURE vs AMBIGUOUS), e
 *  (b) telemetria exibida no painel.
 * NUNCA usado, sozinho, pra autorizar um AUMENTO de exposição
 * (Bloqueador 3) -- currentExposureUsd aqui é só informativo; a
 * autorização de verdade usa buildAuthoritativeIncreaseExposureState(),
 * que exige um snapshot fresco e autenticado da conta Demo. A
 * classificação em si permanece robusta mesmo com este estado
 * desatualizado: qualquer ordem que NÃO seja explicitamente reduceOnly
 * contra o lado oposto da posição classifica como INCREASE_EXPOSURE
 * independente de isOpened estar certo ou não (ver classifyPlaceOrder) --
 * o único jeito de escapar pro caminho defensivo mais permissivo é
 * reduceOnly=true, que a própria Bybit também aplica no servidor.
 */
function buildTrustedDemoRiskState({ loadState = requireStateModule().load, ledgerPath = ledger.DEFAULT_LEDGER_PATH, outcomesPath = ledger.DEFAULT_OUTCOMES_PATH, orderPeriodMs, now = Date.now() }) {
  const botState = loadState();
  const currentExposureUsd = botState.isOpened && Number.isFinite(botState.qty) && Number.isFinite(botState.entryPrice) ? botState.qty * botState.entryPrice : 0;

  return {
    isOpened: Boolean(botState.isOpened),
    side: botState.side ?? null,
    qty: typeof botState.qty === "number" ? botState.qty : null,
    stopLossPrice: typeof botState.stopLossPrice === "number" ? botState.stopLossPrice : null,
    openPositionsCount: botState.isOpened ? 1 : 0,
    currentExposureUsd,
    recentOrderTimestamps: ledger.getRecentOrderTimestamps(ledgerPath, { windowMs: orderPeriodMs, now }),
    lastOrderAt: ledger.getLastOrderAt(ledgerPath),
    consecutiveErrors: ledger.getConsecutiveErrorCount(outcomesPath),
    consecutiveLosses: typeof botState.consecutiveLosses === "number" ? botState.consecutiveLosses : 0,
    dailyLossPct: typeof botState.dailyLoss === "number" ? botState.dailyLoss : 0,
  };
}

/**
 * Estado AUTORITATIVO pra autorizar um AUMENTO de exposição (Bloqueador
 * 3, 4, 6) -- a ÚNICA fonte de exposição/posição/ordens abertas aceita
 * pra esta decisão é um snapshot fresco e autenticado da conta Demo
 * (lib/demoAccountSnapshot.js::readTrustedSnapshot), NUNCA data/state.json
 * isolado. Erros consecutivos usam a variante FAIL-CLOSED do ledger
 * (lib/demoOrderLedger.js::getConsecutiveErrorCountForAuthorization) --
 * corrupção bloqueia em vez de resetar silenciosamente pra 0. Lança (nunca
 * devolve um estado parcial) se o snapshot ou o ledger de outcomes não
 * forem confiáveis -- "não sei" significa bloquear, nunca "assumo que
 * está tudo bem".
 */
function buildAuthoritativeIncreaseExposureState({ env, ledgerPath = ledger.DEFAULT_LEDGER_PATH, outcomesPath = ledger.DEFAULT_OUTCOMES_PATH, snapshotPath = snapshotModule.DEFAULT_SNAPSHOT_PATH, orderPeriodMs, now }) {
  const snapshot = snapshotModule.readTrustedSnapshot({ env, snapshotPath, now }); // lança SnapshotMissingError/CorruptError/StaleError/EnvironmentMismatchError/CredentialMismatchError
  const consecutiveErrors = ledger.getConsecutiveErrorCountForAuthorization(outcomesPath); // lança CorruptPrivateCallOutcomesError se o arquivo existir mas estiver corrompido
  const recentOrderTimestamps = ledger.getRecentOrderTimestamps(ledgerPath, { windowMs: orderPeriodMs, now }); // lança CorruptOrderLedgerError se corrompido -- nunca finge frequência zero

  return {
    snapshot,
    openPositionsCount: snapshot.positions.length,
    currentExposureUsd: snapshot.exposureUsd, // já contabiliza posição + TODAS as ordens abertas que não são reduceOnly=true (Bloqueador 4)
    recentOrderTimestamps,
    lastOrderAt: ledger.getLastOrderAt(ledgerPath),
    consecutiveErrors,
  };
}

// =====================================================================
// Leitura privada -- capacidade SEPARADA de mutação (Bloqueador 2).
// =====================================================================

/**
 * Autoriza SOMENTE leituras privadas (wallet/positions/history) no
 * perfil demo. NUNCA exige TRADING_EXECUTION_ENABLED -- essa variável
 * continua reservada estritamente para mutação (ver
 * assertDemoOrderAllowed/lib/tradingExecutionGate.js). Exige, em vez
 * disso, DEMO_PRIVATE_READ_ENABLED="true" (literal estrito) além de toda
 * a validação estrutural do perfil demo (endpoint/credenciais/flags).
 */
function assertDemoPrivateReadAllowed(env = process.env) {
  const profile = resolveSupervisorProfile(env);
  if (profile !== demoTradingGate.DEMO_PROFILE_NAME) {
    throw new DemoOrderBlockedError("DEMO_READ_WRONG_PROFILE", `Leitura privada demo exige SUPERVISOR_PROFILE=demo -- perfil atual: "${profile}".`);
  }
  demoTradingGate.validateDemoBoot(env); // relança DemoFlagInvalidError/DemoCredentialsMissingError/DemoEndpointMismatchError se aplicável
  if (env.DEMO_PRIVATE_READ_ENABLED !== "true") {
    throw new DemoOrderBlockedError("DEMO_PRIVATE_READ_DISABLED", `Leitura privada demo exige DEMO_PRIVATE_READ_ENABLED="true" explicitamente.`);
  }
}

// =====================================================================
// Gate canônico de mutação -- Bloqueador 1.
// =====================================================================

/**
 * ÚNICA função que autoriza uma operação privada MUTÁVEL no perfil demo.
 * `env` -- process.env (ou fake em teste). `opName` -- nome exato da
 * função de lib/bybit.js (ex.: "placeOrder"). `params` -- os argumentos
 * exatamente como o chamador passou pra função de transporte, com
 * qty/price/leverage/stopLoss como STRING decimal (nunca number -- ver
 * lib/decimalSafety.js). Um eventual `params.instrumentInfo` é
 * IGNORADO (item 1 da Rodada 4) -- a única fonte aceita de metadata do
 * instrumento é o snapshot confiável (lib/demoAccountSnapshot.js), lida
 * mais abaixo, nunca um valor que o chamador de placeOrder poderia
 * forjar.
 *
 * Assinatura PÚBLICA DELIBERADAMENTE ENXUTA (Bloqueador 2) -- nenhum
 * caminho de arquivo, clock ou dependência de estado é aceito como
 * parâmetro aqui. Todos os caminhos de runtime (kill switch, ledger,
 * snapshot, lock) vêm exclusivamente dos defaults reais deste módulo
 * (lib/killSwitch.js, lib/demoOrderLedger.js, lib/demoAccountSnapshot.js,
 * este arquivo) -- a ÚNICA forma legítima de relocá-los é a variável de
 * ambiente CRYPTO10_DEMO_RUNTIME_DIR, lida no require() desses módulos
 * (nunca em tempo de chamada, nunca via argumento). Um chamador nenhum
 * -- produção, teste, ou um payload vindo de fora -- consegue trocar
 * ONDE este gate lê autorização passando um parâmetro. Testes que
 * precisam de estado controlado usam `t.mock.method` nos módulos
 * (lib/killSwitch.js, lib/demoOrderLedger.js, lib/demoAccountSnapshot.js,
 * lib/state.js) ou rodam em subprocesso com runtime isolado -- nunca
 * injeção via parâmetro público.
 *
 * Devolve { kind, orderLinkId, normalized? } em caso de sucesso (e já
 * GRAVOU a reserva no ledger se kind exigir isso) -- lança um
 * DemoOrderBlockedError (ou subclasse) em qualquer bloqueio.
 */
function assertDemoOrderAllowed({ env = process.env, opName, params = {}, now = Date.now() } = {}) {
  const lastDecisionPath = ledger.DEFAULT_LAST_DECISION_PATH;
  try {
    const result = assertDemoOrderAllowedInner({ env, opName, params, now });
    ledger.recordLastDecision(lastDecisionPath, { allowed: true, kind: result.kind, opName, reason: null, atMs: now });
    return result;
  } catch (err) {
    ledger.recordLastDecision(lastDecisionPath, { allowed: false, kind: err.kind || null, opName, reason: err.reason || err.code || err.message, atMs: now });
    throw err;
  }
}

function blockedFromCaughtError(err, kind, fallbackCode = "DEMO_ORDER_BLOCKED") {
  const blocked = new DemoOrderBlockedError(err.code || fallbackCode, err.message, { reason: (err.code || fallbackCode).toLowerCase() });
  blocked.kind = kind;
  blocked.cause = err;
  return blocked;
}

function assertDemoOrderAllowedInner({ env, opName, params, now }) {
  const ledgerPath = ledger.DEFAULT_LEDGER_PATH;
  const outcomesPath = ledger.DEFAULT_OUTCOMES_PATH;
  const killSwitchPath = killSwitch.DEFAULT_KILL_SWITCH_PATH;
  const snapshotPath = snapshotModule.DEFAULT_SNAPSHOT_PATH;
  const lockPath = DEFAULT_RESERVATION_LOCK_PATH;

  const profile = resolveSupervisorProfile(env);
  if (profile !== demoTradingGate.DEMO_PROFILE_NAME) {
    throw new DemoOrderBlockedError("DEMO_ORDER_WRONG_PROFILE", `Operação privada mutável demo exige SUPERVISOR_PROFILE=demo -- perfil atual: "${profile}".`);
  }
  demoTradingGate.validateDemoBoot(env);

  const limits = loadDemoRiskLimitsConfig(env);
  // Classificação -- baseada em data/state.json local (best-effort, nunca
  // autorização). Ver comentário de buildTrustedDemoRiskState.
  const classificationState = buildTrustedDemoRiskState({ ledgerPath, outcomesPath, orderPeriodMs: limits.orderPeriodMs, now });
  const positionSnapshot = { isOpened: classificationState.isOpened, side: classificationState.side, qty: classificationState.qty, stopLossPrice: classificationState.stopLossPrice };
  const kind = classifyBybitOperation(opName, params, positionSnapshot);

  if (kind === OPERATION_KIND.READ) {
    throw new GateMisuseError(`assertDemoOrderAllowed foi chamado para "${opName}", classificado como READ -- leituras usam assertDemoPrivateReadAllowed(), nunca este gate.`);
  }
  if (kind === OPERATION_KIND.AMBIGUOUS) {
    const err = new AmbiguousOperationError(opName);
    err.kind = kind;
    throw err;
  }

  const defensiveKinds = new Set([OPERATION_KIND.REDUCE_EXPOSURE, OPERATION_KIND.CANCEL, OPERATION_KIND.PROTECTIVE_STOP]);

  if (defensiveKinds.has(kind)) {
    // Ação defensiva -- permitida em QUALQUER estado válido do kill switch
    // (inclusive BLOCK_NEW_EXPOSURE/EMERGENCY_EXIT_ONLY -- é exatamente
    // pra isso que esses estados existem: bloquear entrada, nunca saída),
    // e SEM exigir snapshot fresco -- usa a melhor informação disponível,
    // nunca bloqueia uma saída/redução por falta de dado (Bloqueador 3).
    // Ainda assim exige orderLinkId presente/único quando for placeOrder
    // (reduceOnly), pra manter idempotência também no caminho defensivo.
    if (opName === "placeOrder") {
      assertOrderLinkIdFresh(params.orderLinkId, ledgerPath, kind);
      ledger.recordOrderAttempt(ledgerPath, { orderLinkId: params.orderLinkId, symbol: params.symbol, kind, atMs: now });
    }
    return { kind, orderLinkId: params.orderLinkId || null };
  }

  // kind é INCREASE_EXPOSURE ou ADMINISTRATION -- exige reserva
  // transacional cross-process (Bloqueador 5) em volta de TODA a decisão:
  // ler kill switch, ler snapshot, ler ledger, decidir E gravar a reserva
  // acontecem sob o mesmo lock exclusivo -- nenhum outro processo Node
  // consegue reservar capacidade financeira ao mesmo tempo.
  return reservationLock.withReservationLock(lockPath, () => {
    try {
      killSwitch.assertNewExposureArmed(killSwitchPath, { now }); // lança NewExposureBlockedError se não for ARMED_DEMO válido/fresco
    } catch (err) {
      err.kind = kind;
      throw err;
    }

    let authoritative;
    try {
      authoritative = buildAuthoritativeIncreaseExposureState({ env, ledgerPath, outcomesPath, snapshotPath, orderPeriodMs: limits.orderPeriodMs, now });
    } catch (err) {
      throw blockedFromCaughtError(err, kind);
    }

    if (kind === OPERATION_KIND.ADMINISTRATION) {
      // applyDemoFunds -- não tem qty/price/leverage/stopLoss pra validar
      // contra demoRiskLimits (não é uma ordem), mas ainda exige
      // ARMED_DEMO + snapshot confiável (já checados acima) -- sem
      // checagem adicional de negócio.
      return { kind, orderLinkId: null };
    }

    if (opName === "setLeverage") {
      // setLeverage não é uma ordem -- não tem qty/price/notional/stopLoss
      // pra validar contra validateDemoOrder (que é especificamente sobre
      // dimensionamento de posição). Checagem própria, só contra o teto de
      // leverage, em decimal-safe -- sem orderLinkId (não existe conceito
      // de idempotência de "ordem" aqui, é uma configuração de conta).
      let leverageStr;
      try {
        leverageStr = decimal.parseStrictDecimal(params.leverage, "leverage");
      } catch {
        const err = new DemoOrderBlockedError("DEMO_RISK_LIMIT_BLOCKED", "Leverage inválido -- bloqueado.", { reason: "invalid_leverage" });
        err.kind = kind;
        throw err;
      }
      if (decimal.compareDecimalStrings(leverageStr, limits.maxLeverage) > 0) {
        const err = new DemoOrderBlockedError("DEMO_RISK_LIMIT_BLOCKED", `Ordem bloqueada pelos limites de risco do perfil demo: leverage_exceeds_limit.`, { reason: "leverage_exceeds_limit" });
        err.kind = kind;
        throw err;
      }
      return { kind, orderLinkId: null };
    }

    assertOrderLinkIdFresh(params.orderLinkId, ledgerPath, kind);

    const order = {
      symbol: params.symbol,
      side: params.side,
      qty: params.qty,
      price: params.price,
      leverage: params.leverage ?? limits.maxLeverage, // placeOrder não muda leverage -- usa o teto configurado só como valor de referência pra validação (setLeverage tem seu próprio caminho acima)
      stopLossPrice: params.stopLoss !== undefined ? params.stopLoss : null,
      orderLinkId: params.orderLinkId,
    };

    const riskState = {
      openPositionsCount: authoritative.openPositionsCount,
      currentExposureUsd: authoritative.currentExposureUsd,
      recentOrderTimestamps: authoritative.recentOrderTimestamps,
      lastOrderAt: authoritative.lastOrderAt,
      consecutiveErrors: authoritative.consecutiveErrors,
      consecutiveLosses: classificationState.consecutiveLosses,
      dailyLossPct: classificationState.dailyLossPct,
    };

    // instrumentInfo NUNCA vem de params (placeOrder nem aceita mais esse
    // campo do chamador) -- a ÚNICA fonte é o snapshot confiável, que já
    // passou pelas checagens de frescor/ambiente/credencial em
    // buildAuthoritativeIncreaseExposureState acima. Ainda assim
    // revalidamos o símbolo aqui, antes de chamar validateDemoOrder, pra
    // que o bloqueio por símbolo divergente tenha um código dedicado
    // (nunca cai silenciosamente num "instrument_metadata_required"
    // genérico quando na verdade é uma metadata de OUTRO símbolo).
    const instrumentInfo = authoritative.snapshot.instrumentInfo;
    if (!instrumentInfo || instrumentInfo.symbol !== params.symbol) {
      const err = new DemoOrderBlockedError("DEMO_INSTRUMENT_INFO_SYMBOL_MISMATCH", `Metadata de instrumento do snapshot não corresponde ao símbolo da ordem (${params.symbol}) -- bloqueado, nunca reaproveitado de outro símbolo.`, { reason: "instrument_metadata_symbol_mismatch" });
      err.kind = kind;
      throw err;
    }

    const decision = validateDemoOrder(order, riskState, limits, now, instrumentInfo);
    if (!decision.allowed) {
      const err = new DemoOrderBlockedError("DEMO_RISK_LIMIT_BLOCKED", `Ordem bloqueada pelos limites de risco do perfil demo: ${decision.reason}.`, { reason: decision.reason });
      err.kind = kind;
      throw err;
    }

    ledger.recordOrderAttempt(ledgerPath, { orderLinkId: params.orderLinkId, symbol: params.symbol, kind, atMs: now });
    return { kind, orderLinkId: params.orderLinkId, normalized: decision.normalized };
  });
}

function assertOrderLinkIdFresh(orderLinkId, ledgerPath, kind) {
  if (typeof orderLinkId !== "string" || orderLinkId.length === 0) {
    const err = new DemoOrderBlockedError("DEMO_ORDER_LINK_ID_REQUIRED", "orderLinkId é obrigatório em toda operação demo que toca posição/ordem -- garante idempotência e nunca é gerado implicitamente por este gate.");
    err.kind = kind;
    throw err;
  }
  if (ledger.isOrderLinkIdUsed(ledgerPath, orderLinkId)) {
    const err = new DemoOrderBlockedError("DEMO_ORDER_LINK_ID_REUSED", `orderLinkId "${orderLinkId}" já foi usado -- rejeitado, nunca reprocessado como uma nova ordem (idempotência).`);
    err.kind = kind;
    throw err;
  }
}

/**
 * Gera um orderLinkId novo, no formato exigido por
 * lib/demoRiskLimits.js::ORDER_LINK_ID_PATTERN. Prefixo "demo-" só pra
 * facilitar leitura em log/painel -- não tem significado pro gate.
 */
function createOrderLinkId() {
  return `demo-${crypto.randomUUID()}`;
}

module.exports = {
  OPERATION_KIND,
  DEFAULT_RESERVATION_LOCK_PATH,
  createOrderLinkId,
  DemoOrderBlockedError,
  AmbiguousOperationError,
  GateMisuseError,
  classifyStopChange,
  classifyPlaceOrder,
  classifyBybitOperation,
  buildTrustedDemoRiskState,
  buildAuthoritativeIncreaseExposureState,
  assertDemoPrivateReadAllowed,
  assertDemoOrderAllowed,
};

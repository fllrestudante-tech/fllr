// Limites de risco do perfil demo -- camada de negócio SEPARADA do gate
// estrutural (lib/demoTradingGate.js) e do kill switch (lib/killSwitch.js).
// Puro: nenhuma chamada de rede, nenhuma leitura de arquivo/banco --
// recebe o estado atual já carregado pelo chamador e só decide permitir/
// bloquear uma ordem PROPOSTA. Nunca chamado por lib/bybit.js (que não tem
// contexto de negócio nenhum, só transporte) -- é responsabilidade de quem
// monta a ordem (futuro loop de trading demo, fora do escopo desta rodada)
// checar isto ANTES de chamar bybit.placeOrder/setLeverage.
//
// "Validação estrita, defaults seguros": toda variável de ambiente
// reconhecida aqui, se PRESENTE mas com valor inválido (não-numérico,
// negativo onde não faz sentido, símbolo vazio na lista, etc.), lança --
// nunca cai silenciosamente pro default. Só a AUSÊNCIA da variável usa o
// default documentado.
const decimal = require("./decimalSafety");

class InvalidDemoRiskLimitsConfigError extends Error {
  constructor(field, detail) {
    super(`Configuração de limites do perfil demo inválida: ${field} -- ${detail}`);
    this.name = this.constructor.name;
    this.code = "INVALID_DEMO_RISK_LIMITS_CONFIG";
    this.field = field;
  }
}

const ORDER_LINK_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// maxQtyPerOrder/maxNotionalUsdPerOrder/maxTotalExposureUsd/maxLeverage/
// dailyLossLimitPct são STRINGS decimais validadas (lib/decimalSafety.js),
// NUNCA number -- comparação contra qty/notional/exposição/leverage
// propostos usa decimal.compareDecimalStrings ponta-a-ponta, sem passar
// por Number em nenhum momento (item 5 da Rodada 4: converter um limite
// pra Number e de volta pra String reintroduziria a mesma imprecisão
// binária que lib/decimalSafety.js existe pra eliminar). Contadores e
// durações (posições/ordens simultâneas, janelas de tempo, erros/perdas
// consecutivas) continuam inteiros simples -- não são valores
// financeiros fracionários, comparação numérica direta é exata e segura.
const DEFAULTS = Object.freeze({
  allowedSymbols: Object.freeze(["SOLUSDT"]),
  maxQtyPerOrder: "5", // teto EXPLÍCITO de quantidade, independente do notional (Bloqueador 5 da Rodada 3)
  maxNotionalUsdPerOrder: "50",
  maxTotalExposureUsd: "50", // exposição total projetada (posição atual + esta ordem), não só o notional desta ordem isolada
  maxLeverage: "2",
  maxSimultaneousPositions: 1,
  dailyLossLimitPct: "0.02",
  maxOrdersPerPeriod: 5,
  orderPeriodMs: 60 * 60 * 1000, // 1h
  orderCooldownMs: 120 * 1000, // 2min -- ADICIONAL ao config.cooldownMs (60s) já existente, nunca o substitui
  maxConsecutiveErrors: 3,
  maxConsecutiveLosses: 3,
});

/** Valida um limite financeiro do env como STRING decimal -- nunca Number. */
function requirePositiveDecimalString(raw, field) {
  try {
    return decimal.parseStrictDecimal(raw, field);
  } catch (err) {
    throw new InvalidDemoRiskLimitsConfigError(field, `esperado decimal positivo, veio ${JSON.stringify(raw)} (${err.message})`);
  }
}

function requirePositiveInt(raw, field) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidDemoRiskLimitsConfigError(field, `esperado inteiro positivo, veio ${JSON.stringify(raw)}`);
  return n;
}

function parseSymbolList(raw, field) {
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) throw new InvalidDemoRiskLimitsConfigError(field, "lista vazia depois de normalizar -- informe ao menos 1 símbolo ou omita a variável para usar o default");
  return Object.freeze(list);
}

/**
 * Carrega a configuração de limites a partir do env, com defaults
 * conservadores documentados acima. Falha fechada (lança) em qualquer
 * valor PRESENTE mas inválido -- nunca aceita silenciosamente um limite
 * mais permissivo do que o operador pretendia por causa de um erro de
 * digitação.
 */
function loadDemoRiskLimitsConfig(env = process.env) {
  const allowedSymbols = env.DEMO_ALLOWED_SYMBOLS !== undefined && env.DEMO_ALLOWED_SYMBOLS !== "" ? parseSymbolList(env.DEMO_ALLOWED_SYMBOLS, "DEMO_ALLOWED_SYMBOLS") : DEFAULTS.allowedSymbols;

  const maxQtyPerOrder = env.DEMO_MAX_QTY_PER_ORDER !== undefined && env.DEMO_MAX_QTY_PER_ORDER !== "" ? requirePositiveDecimalString(env.DEMO_MAX_QTY_PER_ORDER, "DEMO_MAX_QTY_PER_ORDER") : DEFAULTS.maxQtyPerOrder;

  const maxNotionalUsdPerOrder =
    env.DEMO_MAX_NOTIONAL_USD !== undefined && env.DEMO_MAX_NOTIONAL_USD !== "" ? requirePositiveDecimalString(env.DEMO_MAX_NOTIONAL_USD, "DEMO_MAX_NOTIONAL_USD") : DEFAULTS.maxNotionalUsdPerOrder;

  const maxTotalExposureUsd =
    env.DEMO_MAX_TOTAL_EXPOSURE_USD !== undefined && env.DEMO_MAX_TOTAL_EXPOSURE_USD !== "" ? requirePositiveDecimalString(env.DEMO_MAX_TOTAL_EXPOSURE_USD, "DEMO_MAX_TOTAL_EXPOSURE_USD") : DEFAULTS.maxTotalExposureUsd;

  const maxLeverage = env.DEMO_MAX_LEVERAGE !== undefined && env.DEMO_MAX_LEVERAGE !== "" ? requirePositiveDecimalString(env.DEMO_MAX_LEVERAGE, "DEMO_MAX_LEVERAGE") : DEFAULTS.maxLeverage;

  const maxSimultaneousPositions =
    env.DEMO_MAX_POSITIONS !== undefined && env.DEMO_MAX_POSITIONS !== "" ? requirePositiveInt(env.DEMO_MAX_POSITIONS, "DEMO_MAX_POSITIONS") : DEFAULTS.maxSimultaneousPositions;

  const dailyLossLimitPct =
    env.DEMO_DAILY_LOSS_LIMIT_PCT !== undefined && env.DEMO_DAILY_LOSS_LIMIT_PCT !== "" ? requirePositiveDecimalString(env.DEMO_DAILY_LOSS_LIMIT_PCT, "DEMO_DAILY_LOSS_LIMIT_PCT") : DEFAULTS.dailyLossLimitPct;

  const maxOrdersPerPeriod =
    env.DEMO_MAX_ORDERS_PER_PERIOD !== undefined && env.DEMO_MAX_ORDERS_PER_PERIOD !== "" ? requirePositiveInt(env.DEMO_MAX_ORDERS_PER_PERIOD, "DEMO_MAX_ORDERS_PER_PERIOD") : DEFAULTS.maxOrdersPerPeriod;

  const orderPeriodMs = env.DEMO_ORDER_PERIOD_MS !== undefined && env.DEMO_ORDER_PERIOD_MS !== "" ? requirePositiveInt(env.DEMO_ORDER_PERIOD_MS, "DEMO_ORDER_PERIOD_MS") : DEFAULTS.orderPeriodMs;

  const orderCooldownMs =
    env.DEMO_ORDER_COOLDOWN_MS !== undefined && env.DEMO_ORDER_COOLDOWN_MS !== "" ? requirePositiveInt(env.DEMO_ORDER_COOLDOWN_MS, "DEMO_ORDER_COOLDOWN_MS") : DEFAULTS.orderCooldownMs;

  const maxConsecutiveErrors =
    env.DEMO_MAX_CONSECUTIVE_ERRORS !== undefined && env.DEMO_MAX_CONSECUTIVE_ERRORS !== "" ? requirePositiveInt(env.DEMO_MAX_CONSECUTIVE_ERRORS, "DEMO_MAX_CONSECUTIVE_ERRORS") : DEFAULTS.maxConsecutiveErrors;

  const maxConsecutiveLosses =
    env.DEMO_MAX_CONSECUTIVE_LOSSES !== undefined && env.DEMO_MAX_CONSECUTIVE_LOSSES !== "" ? requirePositiveInt(env.DEMO_MAX_CONSECUTIVE_LOSSES, "DEMO_MAX_CONSECUTIVE_LOSSES") : DEFAULTS.maxConsecutiveLosses;

  return Object.freeze({
    allowedSymbols,
    maxQtyPerOrder,
    maxNotionalUsdPerOrder,
    maxTotalExposureUsd,
    maxLeverage,
    maxSimultaneousPositions,
    dailyLossLimitPct,
    maxOrdersPerPeriod,
    orderPeriodMs,
    orderCooldownMs,
    maxConsecutiveErrors,
    maxConsecutiveLosses,
  });
}

/**
 * Decide se uma ordem PROPOSTA que AUMENTA exposição pode prosseguir.
 * Nunca chama rede, nunca chama Bybit -- todo o estado (posições abertas,
 * exposição atual, timestamps de ordens recentes, erros/perdas
 * consecutivas, perda diária acumulada) é fornecido pelo chamador
 * (lib/demoOrderGate.js, que por sua vez só lê de fontes locais confiáveis
 * -- nunca de AgentRouter/Telegram/frontend, ver lib/webDashboard/demoReader.js
 * e o comentário de buildTrustedDemoRiskState em lib/demoOrderGate.js).
 * Verifica TODOS os limites (não para no primeiro -- devolve o primeiro
 * motivo de bloqueio encontrado, ordem estável e documentada abaixo, mas
 * sempre roda a checagem completa de stop-loss por último porque é a
 * única condição que não tem como ser corrigida por retry imediato).
 *
 * Só chamado para operações classificadas como aumento de exposição
 * (lib/demoOrderGate.js::classifyBybitOperation) -- ações defensivas
 * (reduzir/cancelar/proteger) NUNCA passam por aqui, são autorizadas por
 * um caminho próprio e mais permissivo (ver lib/demoOrderGate.js).
 *
 * TODA a matemática financeira (notional, exposição projetada, teto de
 * leverage) usa lib/decimalSafety.js -- nunca `Number`/ponto flutuante
 * binário. qty/price/leverage/stopLossPrice chegam como STRING decimal (a
 * mesma representação que vai pro corpo da requisição Bybit); os limites
 * de configuração TAMBÉM são strings decimais (item 5 da Rodada 4) --
 * nenhuma comparação financeira deste módulo passa por `Number` em
 * nenhum momento.
 *
 * order: { symbol, side ("Buy"|"Sell"), orderType ("Market"|"Limit"),
 *   qty (string), price (string), leverage (string), stopLossPrice
 *   (string|null), orderLinkId }
 * demoState: { openPositionsCount, currentExposureUsd (string decimal,
 *   já contabilizando posição + ordens abertas -- ver
 *   lib/demoAccountSnapshot.js), recentOrderTimestamps: number[] (ms,
 *   dentro de limits.orderPeriodMs), lastOrderAt: number|null,
 *   consecutiveErrors, consecutiveLosses, dailyLossPct, effectiveLeverage
 *   (string decimal | null -- leverage REALMENTE configurada na conta
 *   pra este símbolo, lida do snapshot -- null significa desconhecida),
 *   tradeMode (number | null), positionIdx (number | null) }
 * now: ms epoch (injetável, nunca Date.now() interno)
 *
 * instrumentInfo: { symbol, qtyStep, minOrderQty, maxOrderQty,
 *   maxMktOrderQty, tickSize, minPrice, maxPrice, minNotionalValue } --
 *   TODOS obrigatórios (item 1 da Rodada 5, nunca mais opcional):
 *   ausente/incompleto/de símbolo diferente bloqueia ANTES de qualquer
 *   outro cálculo. lib/demoOrderGate.js é quem garante que este valor
 *   vem do snapshot confiável (autenticado, fresco, do ambiente Demo) --
 *   nunca de params.instrumentInfo vindo do chamador de placeOrder, que
 *   nem é aceito.
 *
 * orderType (item 2 da Rodada 5) -- decide QUAL teto de quantidade do
 * instrumento se aplica: "Market" usa `maxMktOrderQty` (Bybit limita
 * ordens a mercado mais estritamente que ordens limitadas, exatamente
 * pra conter o impacto de uma execução imediata); "Limit" usa
 * `maxOrderQty`. Ausente/desconhecido bloqueia -- nunca assume um dos
 * dois por padrão. O bot real só envia Market hoje (ver
 * lib/bybit.js::placeOrder); o preço de referência usado aqui é SEMPRE
 * só pra cálculo de risco, nunca enviado como preço de uma ordem Market.
 *
 * Arredondamento -- NUNCA "pro tick mais próximo" genérico:
 *   - qty: SEMPRE floor (nunca aumenta -- ver validateInstrumentQty).
 *   - price (referência pro cálculo de notional): SEMPRE ceil -- um
 *     preço subestimado subestimaria a exposição calculada, exatamente
 *     o erro que o teto de notional/exposição existe pra impedir.
 *   - stopLossPrice: DIRECIONAL por side -- Buy usa ceil (nunca fica
 *     abaixo do stop pedido, nunca afrouxa a proteção pra baixo), Sell
 *     usa floor (nunca fica acima do pedido). side desconhecido/inválido
 *     bloqueia antes de chegar aqui (order_side_unknown).
 *
 * Leverage efetiva (item 4 da Rodada 5) -- antes de autorizar aumento de
 * exposição, a leverage REALMENTE configurada na conta (não a que a
 * ordem propõe) precisa ser conhecida, estar dentro do teto, e ser
 * EXATAMENTE igual à leverage proposta -- uma divergência significa que
 * o cálculo de risco da ordem parte de uma premissa que não bate com a
 * conta de verdade, então bloqueia mesmo que a leverage proposta sozinha
 * estivesse dentro do teto. Este módulo NUNCA chama setLeverage --
 * apenas detecta e bloqueia.
 *
 * Devolve, em caso de allowed=true, um campo extra `normalized` com as
 * strings decimais EXATAS que devem ser usadas pro corpo da requisição
 * Bybit -- o chamador nunca deveria re-derivar esses valores a partir do
 * `order` original depois da validação.
 */
function validateDemoOrder(order, demoState, limits, now, instrumentInfo) {
  if (!Number.isSafeInteger(now) || now < 0) {
    return { allowed: false, reason: "invalid_now" };
  }

  if (!limits.allowedSymbols.includes(order.symbol)) {
    return { allowed: false, reason: "symbol_not_allowed" };
  }

  if (typeof order.orderLinkId !== "string" || !ORDER_LINK_ID_PATTERN.test(order.orderLinkId)) {
    return { allowed: false, reason: "invalid_order_link_id" };
  }

  if (!instrumentInfo || typeof instrumentInfo !== "object") {
    return { allowed: false, reason: "instrument_metadata_required" };
  }
  if (instrumentInfo.symbol !== order.symbol) {
    return { allowed: false, reason: "instrument_metadata_symbol_mismatch" };
  }
  for (const field of ["qtyStep", "minOrderQty", "maxOrderQty", "maxMktOrderQty", "tickSize", "minPrice", "maxPrice", "minNotionalValue"]) {
    if (!instrumentInfo[field]) return { allowed: false, reason: "instrument_metadata_incomplete" };
  }

  // "Não for possível determinar lado/posição com certeza, bloqueie" --
  // side inválido/ausente é sempre um bloqueio explícito, nunca um
  // fallback silencioso pra uma direção de arredondamento assumida.
  if (order.side !== "Buy" && order.side !== "Sell") {
    return { allowed: false, reason: "order_side_unknown" };
  }

  // orderType decide qual teto de quantidade do instrumento vale --
  // nunca assume Market/Limit por padrão quando ausente/desconhecido.
  if (order.orderType !== "Market" && order.orderType !== "Limit") {
    return { allowed: false, reason: "order_type_unknown" };
  }
  const maxQtyForOrderType = order.orderType === "Market" ? instrumentInfo.maxMktOrderQty : instrumentInfo.maxOrderQty;

  let qty;
  try {
    qty = decimal.parseStrictDecimal(order.qty, "qty");
  } catch {
    return { allowed: false, reason: "invalid_qty" };
  }
  try {
    qty = decimal.validateInstrumentQty({ qty, qtyStep: instrumentInfo.qtyStep, minOrderQty: instrumentInfo.minOrderQty, maxOrderQty: maxQtyForOrderType });
  } catch (err) {
    if (err.code === "QUANTITY_BELOW_MINIMUM") return { allowed: false, reason: "qty_below_instrument_minimum" };
    if (err.code === "QUANTITY_ABOVE_MAXIMUM") return { allowed: false, reason: "qty_above_instrument_maximum" };
    return { allowed: false, reason: "invalid_qty" };
  }

  if (decimal.compareDecimalStrings(qty, limits.maxQtyPerOrder) > 0) {
    return { allowed: false, reason: "qty_exceeds_limit" };
  }

  let rawPrice;
  try {
    rawPrice = decimal.parseStrictDecimal(order.price, "price");
  } catch {
    return { allowed: false, reason: "invalid_price" };
  }
  let price;
  try {
    price = decimal.ceilToStep(rawPrice, instrumentInfo.tickSize, "price"); // conservador -- nunca subestima notional
  } catch {
    return { allowed: false, reason: "invalid_price" };
  }
  if (decimal.compareDecimalStrings(price, instrumentInfo.minPrice) < 0 || decimal.compareDecimalStrings(price, instrumentInfo.maxPrice) > 0) {
    return { allowed: false, reason: "price_out_of_instrument_bounds" };
  }

  const notionalUsd = decimal.multiplyDecimalStrings(qty, price, "qty", "price");
  if (decimal.compareDecimalStrings(notionalUsd, instrumentInfo.minNotionalValue) < 0) {
    return { allowed: false, reason: "notional_below_instrument_minimum" };
  }
  if (decimal.compareDecimalStrings(notionalUsd, limits.maxNotionalUsdPerOrder) > 0) {
    return { allowed: false, reason: "notional_exceeds_limit" };
  }

  let currentExposureUsd;
  try {
    currentExposureUsd = decimal.parseNonNegativeDecimalAllowZero(demoState.currentExposureUsd ?? "0", "currentExposureUsd");
  } catch {
    return { allowed: false, reason: "invalid_current_exposure" };
  }
  const projectedExposureUsd = decimal.addDecimalStrings(currentExposureUsd, notionalUsd);
  if (decimal.compareDecimalStrings(projectedExposureUsd, limits.maxTotalExposureUsd) > 0) {
    return { allowed: false, reason: "projected_exposure_exceeds_limit" };
  }

  let leverage;
  try {
    leverage = decimal.parseStrictDecimal(order.leverage, "leverage");
  } catch {
    return { allowed: false, reason: "invalid_leverage" };
  }
  if (decimal.compareDecimalStrings(leverage, limits.maxLeverage) > 0) {
    return { allowed: false, reason: "leverage_exceeds_limit" };
  }

  // Leverage EFETIVA da conta (item 4 da Rodada 5) -- desconhecida
  // bloqueia (nunca assume "deve estar ok"); acima do teto bloqueia
  // mesmo que a proposta esteja dentro do teto; qualquer divergência
  // entre proposta e efetiva bloqueia (a ordem não pode presumir uma
  // leverage que a conta não tem de verdade -- setLeverage nunca é
  // chamado por este módulo, só detecção).
  if (demoState.effectiveLeverage === null || demoState.effectiveLeverage === undefined) {
    return { allowed: false, reason: "effective_leverage_unknown" };
  }
  let effectiveLeverage;
  try {
    effectiveLeverage = decimal.parseStrictDecimal(demoState.effectiveLeverage, "effectiveLeverage");
  } catch {
    return { allowed: false, reason: "effective_leverage_unknown" };
  }
  if (decimal.compareDecimalStrings(effectiveLeverage, limits.maxLeverage) > 0) {
    return { allowed: false, reason: "effective_leverage_exceeds_limit" };
  }
  if (decimal.compareDecimalStrings(leverage, effectiveLeverage) !== 0) {
    return { allowed: false, reason: "leverage_mismatch_with_effective" };
  }

  // Modo de posição compatível (item 4 da Rodada 5) -- este bot só monta
  // ordens pra one-way mode (nunca envia positionIdx no corpo, ver
  // lib/bybit.js::placeOrder) -- positionIdx desconhecido ou diferente
  // de 0 (hedge mode) bloqueia, nunca assume compatibilidade.
  if (demoState.positionIdx === null || demoState.positionIdx === undefined) {
    return { allowed: false, reason: "position_mode_unknown" };
  }
  if (demoState.positionIdx !== 0) {
    return { allowed: false, reason: "position_mode_incompatible" };
  }

  if (demoState.openPositionsCount >= limits.maxSimultaneousPositions) {
    return { allowed: false, reason: "max_positions_reached" };
  }

  const dailyLossPct = decimal.parseNonNegativeDecimalAllowZero(String(Number.isFinite(demoState.dailyLossPct) ? demoState.dailyLossPct : 0), "dailyLossPct");
  if (decimal.compareDecimalStrings(dailyLossPct, limits.dailyLossLimitPct) >= 0) {
    return { allowed: false, reason: "daily_loss_limit_reached" };
  }

  if (demoState.consecutiveErrors >= limits.maxConsecutiveErrors) {
    return { allowed: false, reason: "consecutive_errors_lockout" };
  }

  if (demoState.consecutiveLosses >= limits.maxConsecutiveLosses) {
    return { allowed: false, reason: "consecutive_losses_lockout" };
  }

  if (demoState.lastOrderAt !== null && demoState.lastOrderAt !== undefined && now - demoState.lastOrderAt < limits.orderCooldownMs) {
    return { allowed: false, reason: "cooldown_active" };
  }

  const windowStart = now - limits.orderPeriodMs;
  const ordersInWindow = (demoState.recentOrderTimestamps || []).filter((t) => t > windowStart && t <= now).length;
  if (ordersInWindow >= limits.maxOrdersPerPeriod) {
    return { allowed: false, reason: "max_orders_per_period_reached" };
  }

  // Stop-loss OBRIGATÓRIO -- não configurável, sem escape hatch por env.
  // Arredondamento DIRECIONAL por side (nunca afrouxa a proteção --
  // ver comentário da função). Checado por último de propósito (única
  // condição sem retry imediato -- as anteriores podem, em tese, ser
  // corrigidas ajustando a ordem; esta exige que o CHAMADOR sempre
  // calcule um stop antes de tentar).
  let stopLossPrice = null;
  if (order.stopLossPrice !== null && order.stopLossPrice !== undefined) {
    try {
      const requestedStop = decimal.parseStrictDecimal(order.stopLossPrice, "stopLossPrice");
      stopLossPrice = order.side === "Buy" ? decimal.ceilToStep(requestedStop, instrumentInfo.tickSize, "stopLossPrice") : decimal.floorToStep(requestedStop, instrumentInfo.tickSize, "stopLossPrice");
    } catch {
      stopLossPrice = null;
    }
  }
  if (stopLossPrice === null) {
    return { allowed: false, reason: "stop_loss_required" };
  }
  if (decimal.compareDecimalStrings(stopLossPrice, instrumentInfo.minPrice) < 0 || decimal.compareDecimalStrings(stopLossPrice, instrumentInfo.maxPrice) > 0) {
    return { allowed: false, reason: "stop_loss_out_of_instrument_bounds" };
  }

  // Stop precisa continuar no lado válido do preço de referência PEDIDO
  // (nunca o já arredondado pra cima pro notional, que seria menos
  // conservador pra esta checagem geométrica) -- Buy: stop sempre
  // ABAIXO do preço; Sell: sempre ACIMA. Nunca assume que o chamador já
  // garantiu isso.
  const stopOnValidSide = order.side === "Buy" ? decimal.compareDecimalStrings(stopLossPrice, rawPrice) < 0 : decimal.compareDecimalStrings(stopLossPrice, rawPrice) > 0;
  if (!stopOnValidSide) {
    return { allowed: false, reason: "stop_loss_wrong_side" };
  }

  return { allowed: true, reason: null, normalized: { orderType: order.orderType, qty, price, leverage, stopLossPrice, notionalUsd, projectedExposureUsd } };
}

module.exports = {
  DEFAULTS,
  ORDER_LINK_ID_PATTERN,
  InvalidDemoRiskLimitsConfigError,
  loadDemoRiskLimitsConfig,
  validateDemoOrder,
};

const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULTS, ORDER_LINK_ID_PATTERN, InvalidDemoRiskLimitsConfigError, loadDemoRiskLimitsConfig, validateDemoOrder } = require("../lib/demoRiskLimits");

// =====================================================================
// loadDemoRiskLimitsConfig -- defaults conservadores + validação estrita
// Limites financeiros (maxQtyPerOrder/maxNotionalUsdPerOrder/
// maxTotalExposureUsd/maxLeverage/dailyLossLimitPct) são STRINGS
// decimais (item 5 da Rodada 4) -- nunca number.
// =====================================================================

test("loadDemoRiskLimitsConfig: sem nenhuma env -> usa todos os defaults documentados", () => {
  const cfg = loadDemoRiskLimitsConfig({});
  assert.deepEqual(cfg, DEFAULTS);
});

test("loadDemoRiskLimitsConfig: limites financeiros são sempre STRING, nunca number (item 5 da Rodada 4)", () => {
  const cfg = loadDemoRiskLimitsConfig({});
  for (const field of ["maxQtyPerOrder", "maxNotionalUsdPerOrder", "maxTotalExposureUsd", "maxLeverage", "dailyLossLimitPct"]) {
    assert.equal(typeof cfg[field], "string", `${field} deveria ser string, veio ${typeof cfg[field]}`);
  }
  // Contadores/durações continuam inteiros simples.
  for (const field of ["maxSimultaneousPositions", "maxOrdersPerPeriod", "orderPeriodMs", "orderCooldownMs", "maxConsecutiveErrors", "maxConsecutiveLosses"]) {
    assert.equal(typeof cfg[field], "number", `${field} deveria continuar number`);
  }
});

test("loadDemoRiskLimitsConfig: valor decimal com muitas casas nunca perde precisão (prova que NUNCA passa por Number) -- item 5 da Rodada 4", () => {
  // 0.1 + 0.2 !== 0.3 em float binário; um valor com muitas casas decimais
  // expõe isso de forma inequívoca se o loader arredondar via Number().
  const cfg = loadDemoRiskLimitsConfig({ DEMO_MAX_NOTIONAL_USD: "50.123456789012345" });
  assert.equal(cfg.maxNotionalUsdPerOrder, "50.123456789012345"); // exatamente a string original, byte a byte
  assert.notEqual(Number("50.123456789012345").toString(), "50.123456789012345"); // confirma que Number JÁ perderia precisão aqui
});

test("loadDemoRiskLimitsConfig: DEMO_ALLOWED_SYMBOLS com múltiplos símbolos, espaços extras normalizados", () => {
  const cfg = loadDemoRiskLimitsConfig({ DEMO_ALLOWED_SYMBOLS: " BTCUSDT , ETHUSDT ,SOLUSDT" });
  assert.deepEqual(cfg.allowedSymbols, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
});

test("loadDemoRiskLimitsConfig: DEMO_ALLOWED_SYMBOLS vazio/só vírgulas -> lança, nunca vira lista vazia silenciosa", () => {
  assert.throws(() => loadDemoRiskLimitsConfig({ DEMO_ALLOWED_SYMBOLS: ",,," }), InvalidDemoRiskLimitsConfigError);
});

test("loadDemoRiskLimitsConfig: DEMO_MAX_QTY_PER_ORDER inválido -> lança; válido sobrescreve o default como string", () => {
  assert.throws(() => loadDemoRiskLimitsConfig({ DEMO_MAX_QTY_PER_ORDER: "-1" }), InvalidDemoRiskLimitsConfigError);
  assert.equal(loadDemoRiskLimitsConfig({ DEMO_MAX_QTY_PER_ORDER: "10" }).maxQtyPerOrder, "10");
});

test("loadDemoRiskLimitsConfig: DEMO_MAX_NOTIONAL_USD inválido (não numérico, negativo, zero, notação científica) -> lança", () => {
  for (const value of ["abc", "-10", "0", "1e5"]) {
    assert.throws(() => loadDemoRiskLimitsConfig({ DEMO_MAX_NOTIONAL_USD: value }), InvalidDemoRiskLimitsConfigError, `valor "${value}" deveria lançar`);
  }
});

test("loadDemoRiskLimitsConfig: DEMO_MAX_NOTIONAL_USD válido sobrescreve o default como string", () => {
  const cfg = loadDemoRiskLimitsConfig({ DEMO_MAX_NOTIONAL_USD: "100" });
  assert.equal(cfg.maxNotionalUsdPerOrder, "100");
});

test("loadDemoRiskLimitsConfig: DEMO_MAX_TOTAL_EXPOSURE_USD inválido -> lança; válido sobrescreve o default como string", () => {
  assert.throws(() => loadDemoRiskLimitsConfig({ DEMO_MAX_TOTAL_EXPOSURE_USD: "abc" }), InvalidDemoRiskLimitsConfigError);
  assert.equal(loadDemoRiskLimitsConfig({ DEMO_MAX_TOTAL_EXPOSURE_USD: "200" }).maxTotalExposureUsd, "200");
});

test("loadDemoRiskLimitsConfig: DEMO_MAX_POSITIONS não-inteiro (ex: '1.5') -> lança", () => {
  assert.throws(() => loadDemoRiskLimitsConfig({ DEMO_MAX_POSITIONS: "1.5" }), InvalidDemoRiskLimitsConfigError);
});

test("loadDemoRiskLimitsConfig: todas as 11 variáveis reconhecidas, todas sobrescrevendo o default simultaneamente", () => {
  const cfg = loadDemoRiskLimitsConfig({
    DEMO_ALLOWED_SYMBOLS: "BTCUSDT",
    DEMO_MAX_QTY_PER_ORDER: "3",
    DEMO_MAX_NOTIONAL_USD: "25",
    DEMO_MAX_TOTAL_EXPOSURE_USD: "25",
    DEMO_MAX_LEVERAGE: "1",
    DEMO_MAX_POSITIONS: "1",
    DEMO_DAILY_LOSS_LIMIT_PCT: "0.01",
    DEMO_MAX_ORDERS_PER_PERIOD: "2",
    DEMO_ORDER_PERIOD_MS: "1800000",
    DEMO_ORDER_COOLDOWN_MS: "60000",
    DEMO_MAX_CONSECUTIVE_ERRORS: "2",
    DEMO_MAX_CONSECUTIVE_LOSSES: "2",
  });
  assert.deepEqual(cfg, {
    allowedSymbols: ["BTCUSDT"],
    maxQtyPerOrder: "3",
    maxNotionalUsdPerOrder: "25",
    maxTotalExposureUsd: "25",
    maxLeverage: "1",
    maxSimultaneousPositions: 1,
    dailyLossLimitPct: "0.01",
    maxOrdersPerPeriod: 2,
    orderPeriodMs: 1800000,
    orderCooldownMs: 60000,
    maxConsecutiveErrors: 2,
    maxConsecutiveLosses: 2,
  });
});

test("loadDemoRiskLimitsConfig: config devolvida é congelada (Object.freeze) -- mutar não afeta chamadas seguintes", () => {
  const cfg = loadDemoRiskLimitsConfig({});
  assert.throws(() => {
    "use strict";
    cfg.maxLeverage = "999";
  });
});

// =====================================================================
// validateDemoOrder -- cada limite bloqueia isoladamente. instrumentInfo
// é OBRIGATÓRIO (item 1 da Rodada 4) -- qtyStep/tickSize="1" nos testes
// abaixo pra que valores inteiros "redondos" (40, 20, 50...) passem pelo
// floor/ceil sem mudar, mantendo as asserções focadas no limite sob
// teste, não no arredondamento em si (esse é testado à parte).
// =====================================================================

const INSTRUMENT_INFO = { symbol: "SOLUSDT", qtyStep: "1", minOrderQty: "1", maxOrderQty: "1000", tickSize: "1" };

function baseOrder(overrides = {}) {
  return { symbol: "SOLUSDT", side: "Buy", qty: "1", price: "40", leverage: "1", stopLossPrice: "38", orderLinkId: "test-order-link-0001", ...overrides }; // notional = 40 < default 50, qty 1 <= default maxQtyPerOrder(5)
}
function baseState(overrides = {}) {
  return { openPositionsCount: 0, currentExposureUsd: "0", recentOrderTimestamps: [], lastOrderAt: null, consecutiveErrors: 0, consecutiveLosses: 0, dailyLossPct: 0, ...overrides };
}
function validate(order, state = baseState(), limits = DEFAULTS, now = NOW, instrumentInfo = INSTRUMENT_INFO) {
  return validateDemoOrder(order, state, limits, now, instrumentInfo);
}
const LIMITS = DEFAULTS;
const NOW = 1_756_000_000_000;

test("validateDemoOrder: ordem válida dentro de todos os limites -> allowed=true, normalized com strings decimais exatas", () => {
  const result = validate(baseOrder());
  assert.equal(result.allowed, true);
  assert.equal(result.reason, null);
  assert.deepEqual(result.normalized, { qty: "1", price: "40", leverage: "1", stopLossPrice: "38", notionalUsd: "40", projectedExposureUsd: "40" });
});

test("validateDemoOrder: símbolo fora da allowlist -> bloqueado", () => {
  const result = validate(baseOrder({ symbol: "DOGEUSDT" }), baseState(), LIMITS, NOW, { ...INSTRUMENT_INFO, symbol: "DOGEUSDT" });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "symbol_not_allowed");
});

test("validateDemoOrder: orderLinkId ausente/formato inválido -> bloqueado", () => {
  for (const orderLinkId of [undefined, "", "curto", "com espaço invalido aqui", "!!!inv@lido!!!"]) {
    const result = validate(baseOrder({ orderLinkId }));
    assert.equal(result.allowed, false, `orderLinkId=${JSON.stringify(orderLinkId)} deveria bloquear`);
    assert.equal(result.reason, "invalid_order_link_id");
  }
});

test("ORDER_LINK_ID_PATTERN: aceita o formato usado por lib/demoOrderGate.js::createOrderLinkId ('demo-' + uuid)", () => {
  assert.ok(ORDER_LINK_ID_PATTERN.test(`demo-${"a".repeat(36)}`.slice(0, 41)));
});

// =====================================================================
// instrumentInfo obrigatório (item 1 da Rodada 4)
// =====================================================================

test("validateDemoOrder: instrumentInfo ausente -> bloqueado ANTES de qualquer outro cálculo", () => {
  const result = validate(baseOrder(), baseState(), LIMITS, NOW, null);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "instrument_metadata_required");
});

test("validateDemoOrder: instrumentInfo de OUTRO símbolo -> bloqueado, nunca reaproveitado", () => {
  const result = validate(baseOrder({ symbol: "SOLUSDT" }), baseState(), LIMITS, NOW, { ...INSTRUMENT_INFO, symbol: "BTCUSDT" });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "instrument_metadata_symbol_mismatch");
});

test("validateDemoOrder: instrumentInfo incompleto (qtyStep/minOrderQty/tickSize ausente) -> bloqueado", () => {
  for (const field of ["qtyStep", "minOrderQty", "tickSize"]) {
    const incomplete = { ...INSTRUMENT_INFO };
    delete incomplete[field];
    const result = validate(baseOrder(), baseState(), LIMITS, NOW, incomplete);
    assert.equal(result.allowed, false, `sem ${field} deveria bloquear`);
    assert.equal(result.reason, "instrument_metadata_incomplete");
  }
});

test("validateDemoOrder: side desconhecido/inválido -> bloqueado (nunca assume uma direção de arredondamento)", () => {
  for (const side of [undefined, "Long", "Short", "buy", ""]) {
    const result = validate(baseOrder({ side }));
    assert.equal(result.allowed, false, `side=${JSON.stringify(side)} deveria bloquear`);
    assert.equal(result.reason, "order_side_unknown");
  }
});

// =====================================================================
// Arredondamento direcional (item 2 da Rodada 4)
// =====================================================================

test("validateDemoOrder: preço de referência SEMPRE arredondado pra CIMA (ceil) -- nunca subestima notional", () => {
  const instrumentInfo = { ...INSTRUMENT_INFO, tickSize: "0.01" };
  const result = validate(baseOrder({ price: "20.001", qty: "1", stopLossPrice: "19" }), baseState(), LIMITS, NOW, instrumentInfo);
  assert.equal(result.allowed, true);
  assert.equal(result.normalized.price, "20.01"); // nunca 20.00 -- underestimaria o notional
  assert.equal(result.normalized.notionalUsd, "20.01");
});

test("validateDemoOrder: stop-loss Buy/Long -- normalizado NUNCA fica abaixo do pedido (ceil, nunca afrouxa a proteção pra baixo)", () => {
  const instrumentInfo = { ...INSTRUMENT_INFO, tickSize: "0.01" };
  const result = validate(baseOrder({ side: "Buy", price: "20", stopLossPrice: "19.003" }), baseState(), LIMITS, NOW, instrumentInfo);
  assert.equal(result.allowed, true);
  assert.equal(result.normalized.stopLossPrice, "19.01"); // nunca 19.00
});

test("validateDemoOrder: stop-loss Sell/Short -- normalizado NUNCA fica acima do pedido (floor, nunca afrouxa a proteção pra cima)", () => {
  const instrumentInfo = { ...INSTRUMENT_INFO, tickSize: "0.01" };
  const result = validate(baseOrder({ side: "Sell", price: "21", stopLossPrice: "22.007" }), baseState(), LIMITS, NOW, instrumentInfo);
  assert.equal(result.allowed, true);
  assert.equal(result.normalized.stopLossPrice, "22"); // nunca 22.01 (floor de 22.007 pro tick 0.01 -- "22.00" é representado sem zeros à direita)
});

test("validateDemoOrder: stop-loss do lado errado do preço de referência -> bloqueado (Buy exige stop abaixo, Sell exige stop acima)", () => {
  const buyWrongSide = validate(baseOrder({ side: "Buy", price: "20", stopLossPrice: "25" }));
  assert.equal(buyWrongSide.allowed, false);
  assert.equal(buyWrongSide.reason, "stop_loss_wrong_side");

  const sellWrongSide = validate(baseOrder({ side: "Sell", price: "20", stopLossPrice: "15" }));
  assert.equal(sellWrongSide.allowed, false);
  assert.equal(sellWrongSide.reason, "stop_loss_wrong_side");
});

test("validateDemoOrder: qty com casas além do qtyStep -- SEMPRE floor, nunca aumenta (Bloqueador 1 da Rodada 3)", () => {
  const instrumentInfo = { ...INSTRUMENT_INFO, qtyStep: "0.1", minOrderQty: "0.1" };
  const result = validate(baseOrder({ qty: "1.999", price: "20", stopLossPrice: "19" }), baseState(), LIMITS, NOW, instrumentInfo);
  assert.equal(result.allowed, true);
  assert.equal(result.normalized.qty, "1.9"); // nunca 2.0
});

test("validateDemoOrder: qty abaixo do mínimo do instrumento APÓS floor -> bloqueado, nunca empurrado pra cima", () => {
  const instrumentInfo = { ...INSTRUMENT_INFO, qtyStep: "0.001", minOrderQty: "0.001" };
  const result = validate(baseOrder({ qty: "0.0005" }), baseState(), LIMITS, NOW, instrumentInfo);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "qty_below_instrument_minimum");
});

// =====================================================================
// Demais limites (comportamento inalterado desde a Rodada 3, agora
// exercitados com instrumentInfo obrigatório)
// =====================================================================

test("validateDemoOrder: qty inválida (zero, negativa, NaN) -> bloqueado", () => {
  for (const qty of ["0", "-1", NaN]) {
    const result = validate(baseOrder({ qty }));
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "invalid_qty");
  }
});

test("validateDemoOrder: qty excede o teto explícito de quantidade (independente do notional) -> bloqueado", () => {
  // qty=6 * price=1 = notional 6 (bem abaixo do teto de notional 50), mas
  // qty=6 > maxQtyPerOrder default (5) -- prova que os dois limites são
  // checados de forma INDEPENDENTE (Bloqueador 5 da Rodada 3).
  const result = validate(baseOrder({ qty: "6", price: "1" }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "qty_exceeds_limit");
});

test("validateDemoOrder: notional (qty*price) excede o teto mesmo com qty dentro do limite explícito -> bloqueado (limites independentes)", () => {
  // qty=2 <= maxQtyPerOrder(5), mas notional=2*40=80 > maxNotionalUsdPerOrder(50).
  const result = validate(baseOrder({ qty: "2", price: "40" }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "notional_exceeds_limit");
});

test("validateDemoOrder: notional EXATAMENTE no teto -> permitido (limite é inclusivo, só bloqueia acima)", () => {
  const result = validate(baseOrder({ qty: "1", price: "50" })); // notional=50 == teto
  assert.equal(result.allowed, true);
});

test("validateDemoOrder: exposição PROJETADA (posição atual + esta ordem) excede o teto, mesmo com o notional desta ordem sozinho dentro do limite", () => {
  const result = validate(baseOrder({ qty: "1", price: "20" }), baseState({ currentExposureUsd: "40" })); // 40 (já exposto) + 20 (esta ordem) = 60 > 50
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "projected_exposure_exceeds_limit");
});

test("validateDemoOrder: leverage excede o teto -> bloqueado", () => {
  const result = validate(baseOrder({ leverage: "3" })); // teto default = 2
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "leverage_exceeds_limit");
});

test("validateDemoOrder: já no máximo de posições simultâneas -> bloqueado", () => {
  const result = validate(baseOrder(), baseState({ openPositionsCount: 1 })); // teto default = 1
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "max_positions_reached");
});

test("validateDemoOrder: perda diária já no limite -> bloqueado", () => {
  const result = validate(baseOrder(), baseState({ dailyLossPct: 0.02 })); // teto default = "0.02"
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "daily_loss_limit_reached");
});

test("validateDemoOrder: erros consecutivos no limite -> bloqueado (lockout)", () => {
  const result = validate(baseOrder(), baseState({ consecutiveErrors: 3 })); // teto default = 3
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "consecutive_errors_lockout");
});

test("validateDemoOrder: perdas consecutivas no limite -> bloqueado (lockout)", () => {
  const result = validate(baseOrder(), baseState({ consecutiveLosses: 3 }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "consecutive_losses_lockout");
});

test("validateDemoOrder: cooldown ainda ativo desde a última ordem -> bloqueado", () => {
  const result = validate(baseOrder(), baseState({ lastOrderAt: NOW - 1000 })); // cooldown default = 120000ms
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "cooldown_active");
});

test("validateDemoOrder: cooldown já expirado -> permitido", () => {
  const result = validate(baseOrder(), baseState({ lastOrderAt: NOW - LIMITS.orderCooldownMs - 1 }));
  assert.equal(result.allowed, true);
});

test("validateDemoOrder: máximo de ordens no período já atingido -> bloqueado", () => {
  const timestamps = Array.from({ length: LIMITS.maxOrdersPerPeriod }, (_, i) => NOW - i * 1000);
  const result = validate(baseOrder(), baseState({ recentOrderTimestamps: timestamps, lastOrderAt: null }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "max_orders_per_period_reached");
});

test("validateDemoOrder: ordens FORA da janela do período não contam pro limite", () => {
  const oldTimestamps = Array.from({ length: LIMITS.maxOrdersPerPeriod }, () => NOW - LIMITS.orderPeriodMs - 1);
  const result = validate(baseOrder(), baseState({ recentOrderTimestamps: oldTimestamps, lastOrderAt: null }));
  assert.equal(result.allowed, true);
});

test("validateDemoOrder: stop-loss ausente -> SEMPRE bloqueado, não configurável (sem escape hatch por env/limits)", () => {
  for (const stopLossPrice of [null, undefined]) {
    const result = validate(baseOrder({ stopLossPrice }));
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "stop_loss_required", `stopLossPrice=${stopLossPrice} deveria bloquear`);
  }
});

test("validateDemoOrder: now inválido (negativo, não-inteiro) -> bloqueado antes de qualquer outra checagem", () => {
  assert.equal(validate(baseOrder(), baseState(), LIMITS, -1).allowed, false);
  assert.equal(validate(baseOrder(), baseState(), LIMITS, 1.5).allowed, false);
});

test("validateDemoOrder: múltiplos limites configuráveis simultaneamente violados -> ainda bloqueia (não exige violar só 1 por vez)", () => {
  const result = validate(baseOrder({ leverage: "10", qty: "100" }), baseState({ openPositionsCount: 5, dailyLossPct: 1 }));
  assert.equal(result.allowed, false);
  assert.ok(result.reason); // algum motivo estável, não precisa ser um específico -- só prova que não passa
});

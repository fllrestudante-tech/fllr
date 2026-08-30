const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const {
  OPERATION_KIND,
  DemoOrderBlockedError,
  AmbiguousOperationError,
  GateMisuseError,
  classifyStopChange,
  classifyPlaceOrder,
  classifyBybitOperation,
  buildTrustedDemoRiskState,
  assertDemoPrivateReadAllowed,
  assertDemoOrderAllowed,
  createOrderLinkId,
} = require("../lib/demoOrderGate");
const killSwitch = require("../lib/killSwitch");
const ledger = require("../lib/demoOrderLedger");
const snapshotModule = require("../lib/demoAccountSnapshot");
const stateModule = require("../lib/state");
const { DEFAULT_STATE } = stateModule;

const NOW = 1_756_000_000_000;

function validDemoEnv(overrides = {}) {
  return {
    SUPERVISOR_PROFILE: "demo",
    BYBIT_DEMO: "true",
    BYBIT_TESTNET: "false",
    BYBIT_API_KEY: "fake-key-not-a-real-secret",
    BYBIT_API_SECRET: "fake-secret-not-real",
    ...overrides,
  };
}

function fakeSnapshot(overrides = {}) {
  return {
    schemaVersion: 3,
    credentialFingerprint: "sha256:fake",
    capturedAtMs: NOW,
    endpoint: "demo",
    equityUsd: "1000",
    positions: [],
    openOrders: [],
    exposureUsd: "0",
    instrumentInfo: {
      symbol: "SOLUSDT",
      qtyStep: "0.1",
      minOrderQty: "0.1",
      maxOrderQty: "96000.0",
      maxMktOrderQty: "12000.0",
      tickSize: "0.01",
      minPrice: "0.01",
      maxPrice: "199999.98",
      minNotionalValue: "5",
    },
    symbolState: { hasOpenPosition: false, side: null, qty: null, entryPrice: null, stopLossPrice: null, effectiveLeverage: "2", tradeMode: 0, positionIdx: 0 },
    ...overrides,
  };
}

/**
 * Mocka TODAS as dependências de I/O do gate via t.mock.method nos
 * módulos (Bloqueador 2: nunca via parâmetro público de
 * assertDemoOrderAllowed, que não aceita mais nenhum). t.mock restaura
 * tudo automaticamente ao fim de cada teste -- nenhum teste deste
 * arquivo toca runtime/demo/ real (grava só nos objetos mockados em
 * memória).
 */
function setupMocks(t, { localState = {}, armed = false, killSwitchState = killSwitch.STATES.BLOCK_NEW_EXPOSURE, snapshot, snapshotError, ledgerCounters = {} } = {}) {
  t.mock.method(stateModule, "load", () => ({ ...DEFAULT_STATE, ...localState }));
  t.mock.method(ledger, "recordLastDecision", () => {});

  const usedIds = new Set(ledgerCounters.usedOrderLinkIds || []);
  const recorded = [];
  t.mock.method(ledger, "recordOrderAttempt", (_path, entry) => {
    recorded.push(entry);
    usedIds.add(entry.orderLinkId);
  });
  t.mock.method(ledger, "isOrderLinkIdUsed", (_path, id) => usedIds.has(id));
  t.mock.method(ledger, "getRecentOrderTimestamps", () => ledgerCounters.recentOrderTimestamps || []);
  t.mock.method(ledger, "getLastOrderAt", () => ledgerCounters.lastOrderAt ?? null);
  t.mock.method(ledger, "getConsecutiveErrorCount", () => ledgerCounters.consecutiveErrors ?? 0);
  t.mock.method(ledger, "getConsecutiveErrorCountForAuthorization", () => {
    if (ledgerCounters.authThrows) throw ledgerCounters.authThrows;
    return ledgerCounters.consecutiveErrorsForAuth ?? ledgerCounters.consecutiveErrors ?? 0;
  });

  if (armed) {
    t.mock.method(killSwitch, "assertNewExposureArmed", () => {});
  } else {
    t.mock.method(killSwitch, "assertNewExposureArmed", () => {
      throw new killSwitch.NewExposureBlockedError(killSwitchState, null);
    });
  }

  if (snapshotError) {
    t.mock.method(snapshotModule, "readTrustedSnapshot", () => {
      throw snapshotError;
    });
  } else {
    const snap = fakeSnapshot(snapshot);
    t.mock.method(snapshotModule, "readTrustedSnapshot", () => snap);
  }

  return { recorded, usedIds };
}

// =====================================================================
// Classificação -- pura (assinatura inalterada -- decimalSafety aceita
// number OU string decimal, ver lib/decimalSafety.js::parseStrictDecimal)
// =====================================================================

test("classifyPlaceOrder: sem posição aberta, reduceOnly ausente -> INCREASE_EXPOSURE", () => {
  assert.equal(classifyPlaceOrder({ side: "Buy", orderType: "Market", qty: 1 }, { isOpened: false }), OPERATION_KIND.INCREASE_EXPOSURE);
});

test("classifyPlaceOrder: sem posição aberta, reduceOnly=true -> AMBIGUOUS (nada a reduzir)", () => {
  assert.equal(classifyPlaceOrder({ side: "Buy", orderType: "Market", qty: 1, reduceOnly: true }, { isOpened: false }), OPERATION_KIND.AMBIGUOUS);
});

test("classifyPlaceOrder: mesmo lado da posição aberta -> INCREASE_EXPOSURE (adicionando)", () => {
  const pos = { isOpened: true, side: "Buy", orderType: "Market", qty: 2 };
  assert.equal(classifyPlaceOrder({ side: "Buy", orderType: "Market", qty: 1 }, pos), OPERATION_KIND.INCREASE_EXPOSURE);
});

test("classifyPlaceOrder: mesmo lado + reduceOnly=true -> AMBIGUOUS (incoerente, nunca reduz)", () => {
  const pos = { isOpened: true, side: "Buy", orderType: "Market", qty: 2 };
  assert.equal(classifyPlaceOrder({ side: "Buy", orderType: "Market", qty: 1, reduceOnly: true }, pos), OPERATION_KIND.AMBIGUOUS);
});

test("classifyPlaceOrder: lado oposto + reduceOnly!=true -> AMBIGUOUS (exige explicitação, nunca infere)", () => {
  const pos = { isOpened: true, side: "Buy", orderType: "Market", qty: 2 };
  assert.equal(classifyPlaceOrder({ side: "Sell", qty: 1 }, pos), OPERATION_KIND.AMBIGUOUS);
});

test("classifyPlaceOrder: lado oposto + reduceOnly=true + qty <= posição -> REDUCE_EXPOSURE", () => {
  const pos = { isOpened: true, side: "Buy", orderType: "Market", qty: 2 };
  assert.equal(classifyPlaceOrder({ side: "Sell", qty: 1, reduceOnly: true }, pos), OPERATION_KIND.REDUCE_EXPOSURE);
});

test("classifyPlaceOrder: lado oposto + reduceOnly=true + qty EXATAMENTE igual à posição -> REDUCE_EXPOSURE (fechamento total)", () => {
  const pos = { isOpened: true, side: "Buy", orderType: "Market", qty: 2 };
  assert.equal(classifyPlaceOrder({ side: "Sell", qty: 2, reduceOnly: true }, pos), OPERATION_KIND.REDUCE_EXPOSURE);
});

test("classifyPlaceOrder: lado oposto + reduceOnly=true + qty MAIOR que a posição -> AMBIGUOUS (reverteria pro lado oposto)", () => {
  const pos = { isOpened: true, side: "Buy", orderType: "Market", qty: 2 };
  assert.equal(classifyPlaceOrder({ side: "Sell", qty: 3, reduceOnly: true }, pos), OPERATION_KIND.AMBIGUOUS);
});

test("classifyPlaceOrder: side inválido ou qty inválida -> AMBIGUOUS", () => {
  assert.equal(classifyPlaceOrder({ side: "Long", qty: 1 }, { isOpened: false }), OPERATION_KIND.AMBIGUOUS);
  assert.equal(classifyPlaceOrder({ side: "Buy", orderType: "Market", qty: 0 }, { isOpened: false }), OPERATION_KIND.AMBIGUOUS);
  assert.equal(classifyPlaceOrder({ side: "Buy", orderType: "Market", qty: -1 }, { isOpened: false }), OPERATION_KIND.AMBIGUOUS);
  assert.equal(classifyPlaceOrder({ side: "Buy", orderType: "Market", qty: NaN }, { isOpened: false }), OPERATION_KIND.AMBIGUOUS);
});

test("classifyPlaceOrder: qty como STRING decimal (formato real do body Bybit) -- mesmo comportamento que number", () => {
  assert.equal(classifyPlaceOrder({ side: "Buy", orderType: "Market", qty: "1.5" }, { isOpened: false }), OPERATION_KIND.INCREASE_EXPOSURE);
  assert.equal(classifyPlaceOrder({ side: "Buy", orderType: "Market", qty: "0" }, { isOpened: false }), OPERATION_KIND.AMBIGUOUS);
  assert.equal(classifyPlaceOrder({ side: "Buy", orderType: "Market", qty: "1e10" }, { isOpened: false }), OPERATION_KIND.AMBIGUOUS); // notação científica rejeitada
});

test("classifyStopChange: stopLoss ausente do payload (só trailing/TP parcial) -> PROTECTIVE_STOP", () => {
  assert.equal(classifyStopChange({}, { isOpened: true, side: "Buy", stopLossPrice: 100 }), OPERATION_KIND.PROTECTIVE_STOP);
});

test("classifyStopChange: sem posição aberta -> AMBIGUOUS", () => {
  assert.equal(classifyStopChange({ stopLoss: 100 }, { isOpened: false }), OPERATION_KIND.AMBIGUOUS);
});

test("classifyStopChange: novo stop inválido (zero, negativo, NaN) -> AMBIGUOUS -- nunca remove/zera proteção", () => {
  const pos = { isOpened: true, side: "Buy", stopLossPrice: 100 };
  for (const stopLoss of [0, -1, NaN, "abc"]) {
    assert.equal(classifyStopChange({ stopLoss }, pos), OPERATION_KIND.AMBIGUOUS);
  }
});

test("classifyStopChange: sem stop anterior -> definir um agora é sempre PROTECTIVE_STOP", () => {
  assert.equal(classifyStopChange({ stopLoss: 100 }, { isOpened: true, side: "Buy", stopLossPrice: null }), OPERATION_KIND.PROTECTIVE_STOP);
});

test("classifyStopChange: side=Buy, novo stop SOBE (mais perto do preço) -> PROTECTIVE_STOP", () => {
  assert.equal(classifyStopChange({ stopLoss: 105 }, { isOpened: true, side: "Buy", stopLossPrice: 100 }), OPERATION_KIND.PROTECTIVE_STOP);
});

test("classifyStopChange: side=Buy, novo stop DESCE (mais longe, afrouxa) -> AMBIGUOUS", () => {
  assert.equal(classifyStopChange({ stopLoss: 95 }, { isOpened: true, side: "Buy", stopLossPrice: 100 }), OPERATION_KIND.AMBIGUOUS);
});

test("classifyStopChange: side=Sell, novo stop DESCE (mais perto do preço) -> PROTECTIVE_STOP", () => {
  assert.equal(classifyStopChange({ stopLoss: 95 }, { isOpened: true, side: "Sell", stopLossPrice: 100 }), OPERATION_KIND.PROTECTIVE_STOP);
});

test("classifyStopChange: side=Sell, novo stop SOBE (afrouxa) -> AMBIGUOUS", () => {
  assert.equal(classifyStopChange({ stopLoss: 105 }, { isOpened: true, side: "Sell", stopLossPrice: 100 }), OPERATION_KIND.AMBIGUOUS);
});

test("classifyBybitOperation: leituras -> READ; applyDemoFunds -> ADMINISTRATION; setLeverage -> INCREASE_EXPOSURE; cancel* -> CANCEL; função desconhecida -> AMBIGUOUS", () => {
  assert.equal(classifyBybitOperation("getWalletBalance"), OPERATION_KIND.READ);
  assert.equal(classifyBybitOperation("getPositions"), OPERATION_KIND.READ);
  assert.equal(classifyBybitOperation("getClosedPnl"), OPERATION_KIND.READ);
  assert.equal(classifyBybitOperation("getOpenOrders"), OPERATION_KIND.READ);
  assert.equal(classifyBybitOperation("applyDemoFunds"), OPERATION_KIND.ADMINISTRATION);
  assert.equal(classifyBybitOperation("setLeverage", { leverage: 2 }), OPERATION_KIND.INCREASE_EXPOSURE);
  assert.equal(classifyBybitOperation("cancelOrder"), OPERATION_KIND.CANCEL);
  assert.equal(classifyBybitOperation("cancelAllOrders"), OPERATION_KIND.CANCEL);
  assert.equal(classifyBybitOperation("umaFuncaoQueNaoExiste"), OPERATION_KIND.AMBIGUOUS);
});

// =====================================================================
// assertDemoPrivateReadAllowed -- Bloqueador 2
// =====================================================================

test("assertDemoPrivateReadAllowed: perfil demo + config válida + DEMO_PRIVATE_READ_ENABLED=true -> não lança, SEM TRADING_EXECUTION_ENABLED", () => {
  const env = validDemoEnv({ DEMO_PRIVATE_READ_ENABLED: "true" });
  assert.equal(env.TRADING_EXECUTION_ENABLED, undefined);
  assert.doesNotThrow(() => assertDemoPrivateReadAllowed(env));
});

test("assertDemoPrivateReadAllowed: DEMO_PRIVATE_READ_ENABLED ausente -> lança, mesmo com config demo válida", () => {
  assert.throws(
    () => assertDemoPrivateReadAllowed(validDemoEnv()),
    (err) => {
      assert.equal(err.code, "DEMO_PRIVATE_READ_DISABLED");
      return true;
    }
  );
});

test("assertDemoPrivateReadAllowed: fora do perfil demo -> lança", () => {
  assert.throws(() => assertDemoPrivateReadAllowed({ SUPERVISOR_PROFILE: "safe", DEMO_PRIVATE_READ_ENABLED: "true" }));
});

// =====================================================================
// assertDemoOrderAllowed -- gate canônico. Assinatura pública SEM
// nenhum caminho de arquivo/clock/dependência de estado (Bloqueador 2) --
// toda dependência de I/O é mockada via t.mock.method nos módulos.
// =====================================================================

test("assertDemoOrderAllowed: assinatura pública ignora QUALQUER campo extra que pareça um parâmetro de bypass -- só env/opName/params/now existem no contrato", (t) => {
  setupMocks(t, { armed: true, snapshot: {} });
  const orderLinkId = createOrderLinkId();
  // Um chamador (produção, teste, ou payload externo) tentando passar
  // killSwitchPath/ledgerPath/outcomesPath/loadState/lockPath/snapshotPath
  // simplesmente não tem efeito nenhum -- a função nem desestrutura esses
  // nomes -- prova por comportamento (não só por leitura de código) que
  // não existe superfície de bypass aqui.
  const result = assertDemoOrderAllowed({
    env: validDemoEnv(),
    opName: "placeOrder",
    params: { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", price: "40", stopLoss: "38", reduceOnly: false, orderLinkId },
    now: NOW,
    killSwitchPath: "/tmp/nao-existe/nada.json",
    ledgerPath: "/tmp/nao-existe/nada2.json",
    outcomesPath: "/tmp/nao-existe/nada3.json",
    loadState: () => ({ isOpened: true, side: "Buy", orderType: "Market", qty: 999, entryPrice: 999 }), // tentativa de spoof via parâmetro -- deve ser ignorada
    lockPath: "/tmp/nao-existe/nada4.lock",
    snapshotPath: "/tmp/nao-existe/nada5.json",
  });
  assert.equal(result.kind, "INCREASE_EXPOSURE");
});

test("assertDemoOrderAllowed: READ classificado -> GateMisuseError (uso incorreto -- reads usam o outro gate)", (t) => {
  setupMocks(t, {});
  assert.throws(() => assertDemoOrderAllowed({ env: validDemoEnv(), opName: "getWalletBalance", params: {}, now: NOW }), GateMisuseError);
});

test("assertDemoOrderAllowed: operação ambígua (função desconhecida) -> AmbiguousOperationError, nunca autorizada por padrão", (t) => {
  setupMocks(t, {});
  assert.throws(() => assertDemoOrderAllowed({ env: validDemoEnv(), opName: "cancelOrderQueNaoExiste", params: {}, now: NOW }), AmbiguousOperationError);
});

test("assertDemoOrderAllowed: fora do perfil demo -> DEMO_ORDER_WRONG_PROFILE", (t) => {
  setupMocks(t, {});
  assert.throws(
    () =>
      assertDemoOrderAllowed({
        env: { SUPERVISOR_PROFILE: "safe" },
        opName: "placeOrder",
        params: { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", price: "40", reduceOnly: false, orderLinkId: createOrderLinkId() },
        now: NOW,
      }),
    (err) => {
      assert.equal(err.code, "DEMO_ORDER_WRONG_PROFILE");
      return true;
    }
  );
});

test("assertDemoOrderAllowed: INCREASE_EXPOSURE sem ARMED_DEMO -> NewExposureBlockedError", (t) => {
  setupMocks(t, { armed: false });
  assert.throws(
    () =>
      assertDemoOrderAllowed({
        env: validDemoEnv(),
        opName: "placeOrder",
        params: { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", price: "40", reduceOnly: false, orderLinkId: createOrderLinkId() },
        now: NOW,
      }),
    killSwitch.NewExposureBlockedError
  );
});

test("assertDemoOrderAllowed: INCREASE_EXPOSURE armado mas SEM snapshot confiável -> bloqueado (Bloqueador 3), nunca autoriza só com estado local", (t) => {
  setupMocks(t, { armed: true, snapshotError: new snapshotModule.SnapshotMissingError() });
  assert.throws(
    () =>
      assertDemoOrderAllowed({
        env: validDemoEnv(),
        opName: "placeOrder",
        params: { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", price: "40", stopLoss: "38", reduceOnly: false, orderLinkId: createOrderLinkId() },
        now: NOW,
      }),
    (err) => {
      assert.equal(err.code, "SNAPSHOT_MISSING");
      return true;
    }
  );
});

for (const [label, ErrorClass, ctorArgs] of [
  ["corrompido", snapshotModule.SnapshotCorruptError, ["json inválido"]],
  ["velho (stale)", snapshotModule.SnapshotStaleError, [999999, 120000]],
  ["de outro ambiente", snapshotModule.SnapshotEnvironmentMismatchError, []],
  ["de credencial diferente", snapshotModule.SnapshotCredentialMismatchError, []],
]) {
  test(`assertDemoOrderAllowed: snapshot ${label} -> bloqueia aumento de exposição, nunca autoriza com dado não confiável`, (t) => {
    setupMocks(t, { armed: true, snapshotError: new ErrorClass(...ctorArgs) });
    assert.throws(() =>
      assertDemoOrderAllowed({
        env: validDemoEnv(),
        opName: "placeOrder",
        params: { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", price: "40", stopLoss: "38", reduceOnly: false, orderLinkId: createOrderLinkId() },
        now: NOW,
      })
    );
  });
}

test("assertDemoOrderAllowed: erros consecutivos ilegíveis (outcomes corrompido) -> bloqueia aumento de exposição (Bloqueador 6, fail-closed)", (t) => {
  setupMocks(t, { armed: true, snapshot: {}, ledgerCounters: { authThrows: new ledger.CorruptPrivateCallOutcomesError() } });
  assert.throws(
    () =>
      assertDemoOrderAllowed({
        env: validDemoEnv(),
        opName: "placeOrder",
        params: { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", price: "40", stopLoss: "38", reduceOnly: false, orderLinkId: createOrderLinkId() },
        now: NOW,
      }),
    (err) => {
      assert.equal(err.code, "CORRUPT_PRIVATE_CALL_OUTCOMES");
      return true;
    }
  );
});

test("assertDemoOrderAllowed: INCREASE_EXPOSURE com ARMED_DEMO + snapshot fresco válido + dentro de todos os limites -> permitido, grava a reserva, devolve normalized decimal-safe", (t) => {
  const { recorded } = setupMocks(t, { armed: true, snapshot: {} });
  const orderLinkId = createOrderLinkId();
  const result = assertDemoOrderAllowed({
    env: validDemoEnv(),
    opName: "placeOrder",
    params: { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", price: "40", stopLoss: "38", reduceOnly: false, orderLinkId },
    now: NOW,
  });
  assert.equal(result.kind, "INCREASE_EXPOSURE");
  assert.equal(result.orderLinkId, orderLinkId);
  assert.deepEqual(result.normalized, { orderType: "Market", qty: "1", price: "40", leverage: "2", stopLossPrice: "38", notionalUsd: "40", projectedExposureUsd: "40" });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].orderLinkId, orderLinkId);
});

test("assertDemoOrderAllowed: exposição do SNAPSHOT (posição + ordens abertas) entra na projeção -- não só a ordem nova (Bloqueador 4)", (t) => {
  // Snapshot já mostra 1 posição aberta (exposição 45) + 1 ordem aberta
  // não-reduceOnly (exposição adicional já contabilizada em exposureUsd
  // pelo próprio snapshot, ver lib/demoAccountSnapshot.js::computeConservativeExposureUsd) --
  // a nova ordem de 40 USD projetada por cima disso estoura o teto default (50).
  setupMocks(t, { armed: true, snapshot: { positions: [{ symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", entryPrice: "45" }], exposureUsd: "45" } });
  assert.throws(
    () =>
      assertDemoOrderAllowed({
        env: validDemoEnv(),
        opName: "placeOrder",
        params: { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", price: "40", stopLoss: "38", reduceOnly: false, orderLinkId: createOrderLinkId() },
        now: NOW,
      }),
    (err) => {
      assert.equal(err.code, "DEMO_RISK_LIMIT_BLOCKED");
      assert.equal(err.reason, "projected_exposure_exceeds_limit");
      return true;
    }
  );
});

test("assertDemoOrderAllowed: qty com casas decimais além do qtyStep do instrumento (vindo do snapshot confiável) é arredondada PRA BAIXO, nunca pra cima (Bloqueador 1 da Rodada 3)", (t) => {
  // instrumentInfo vem do snapshot (default de fakeSnapshot: qtyStep
  // "0.1") -- params.instrumentInfo nem existe mais como campo aceito
  // (item 1 da Rodada 4: nunca vem do chamador de placeOrder).
  setupMocks(t, { armed: true, snapshot: {} });
  const orderLinkId = createOrderLinkId();
  const result = assertDemoOrderAllowed({
    env: validDemoEnv(),
    opName: "placeOrder",
    params: { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1.999", price: "20", stopLoss: "19", reduceOnly: false, orderLinkId },
    now: NOW,
  });
  assert.equal(result.normalized.qty, "1.9"); // NUNCA 2.0 -- floor, nunca round
});

test("assertDemoOrderAllowed: instrumentInfo passado em params é IGNORADO -- nunca vem do chamador de placeOrder (item 1 da Rodada 4)", (t) => {
  // O chamador tenta forjar uma metadata diferente da real (qtyStep
  // maior, deixaria passar sem floor) -- deve ser completamente
  // ignorada; o resultado usa a metadata REAL do snapshot (qtyStep 0.1).
  setupMocks(t, { armed: true, snapshot: {} });
  const orderLinkId = createOrderLinkId();
  const result = assertDemoOrderAllowed({
    env: validDemoEnv(),
    opName: "placeOrder",
    params: { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1.999", price: "20", stopLoss: "19", reduceOnly: false, orderLinkId, instrumentInfo: { symbol: "SOLUSDT", qtyStep: "1", minOrderQty: "1", maxOrderQty: "100", tickSize: "1" } },
    now: NOW,
  });
  assert.equal(result.normalized.qty, "1.9", "instrumentInfo forjado em params nunca deveria ter sido usado");
});

test("assertDemoOrderAllowed: instrumentInfo do snapshot de OUTRO símbolo -> bloqueia com código dedicado, nunca reaproveitado (item 1 da Rodada 4)", (t) => {
  setupMocks(t, { armed: true, snapshot: { instrumentInfo: { symbol: "BTCUSDT", qtyStep: "0.001", minOrderQty: "0.001", maxOrderQty: "10", tickSize: "0.1" } } });
  assert.throws(
    () =>
      assertDemoOrderAllowed({
        env: validDemoEnv(),
        opName: "placeOrder",
        params: { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", price: "40", stopLoss: "38", reduceOnly: false, orderLinkId: createOrderLinkId() },
        now: NOW,
      }),
    (err) => {
      assert.equal(err.code, "DEMO_INSTRUMENT_INFO_SYMBOL_MISMATCH");
      return true;
    }
  );
});

test("assertDemoOrderAllowed: notional usado pelo gate NUNCA é subestimado -- preço de referência sempre arredondado pra cima (item 2 da Rodada 4)", (t) => {
  setupMocks(t, { armed: true, snapshot: { instrumentInfo: { symbol: "SOLUSDT", qtyStep: "0.1", minOrderQty: "0.1", maxOrderQty: "10", maxMktOrderQty: "10", tickSize: "0.01", minPrice: "0.01", maxPrice: "199999.98", minNotionalValue: "5" } } });
  const result = assertDemoOrderAllowed({
    env: validDemoEnv(),
    opName: "placeOrder",
    params: { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", price: "20.001", stopLoss: "19", reduceOnly: false, orderLinkId: createOrderLinkId() },
    now: NOW,
  });
  assert.equal(result.normalized.price, "20.01"); // nunca 20.00
  assert.equal(result.normalized.notionalUsd, "20.01"); // nunca subestimado como 20.00
});

test("assertDemoOrderAllowed: INCREASE_EXPOSURE com ARMED_DEMO mas violando limite de negócio (notional) -> DEMO_RISK_LIMIT_BLOCKED, NUNCA grava reserva", (t) => {
  const { recorded } = setupMocks(t, { armed: true, snapshot: {} });
  const orderLinkId = createOrderLinkId();
  assert.throws(
    () =>
      assertDemoOrderAllowed({
        env: validDemoEnv(),
        opName: "placeOrder",
        params: { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "2", price: "40", stopLoss: "38", reduceOnly: false, orderLinkId }, // notional=80 > default maxNotionalUsdPerOrder(50)
        now: NOW,
      }),
    (err) => {
      assert.equal(err.code, "DEMO_RISK_LIMIT_BLOCKED");
      assert.equal(err.reason, "notional_exceeds_limit");
      return true;
    }
  );
  assert.equal(recorded.length, 0, "ordem bloqueada nunca deveria ter sido gravada como reserva");
});

test("assertDemoOrderAllowed: REDUCE_EXPOSURE permitido MESMO com kill switch em BLOCK_NEW_EXPOSURE e SEM snapshot (usa melhor informação disponível)", (t) => {
  setupMocks(t, { localState: { isOpened: true, side: "Buy", orderType: "Market", qty: 2, entryPrice: 40 }, armed: false, snapshotError: new snapshotModule.SnapshotMissingError() });
  const result = assertDemoOrderAllowed({
    env: validDemoEnv(),
    opName: "placeOrder",
    params: { side: "Sell", qty: "1", reduceOnly: true, orderLinkId: createOrderLinkId() },
    now: NOW,
  });
  assert.equal(result.kind, "REDUCE_EXPOSURE");
});

test("assertDemoOrderAllowed: PROTECTIVE_STOP permitido MESMO com kill switch em BLOCK_NEW_EXPOSURE e SEM snapshot", (t) => {
  setupMocks(t, { localState: { isOpened: true, side: "Buy", orderType: "Market", qty: 2, entryPrice: 40, stopLossPrice: 38 }, armed: false, snapshotError: new snapshotModule.SnapshotMissingError() });
  const result = assertDemoOrderAllowed({
    env: validDemoEnv(),
    opName: "setTradingStop",
    params: { symbol: "SOLUSDT", stopLoss: 42 },
    now: NOW,
  });
  assert.equal(result.kind, "PROTECTIVE_STOP");
});

test("assertDemoOrderAllowed: CANCEL (cancelOrder/cancelAllOrders) permitido MESMO com kill switch em BLOCK_NEW_EXPOSURE e SEM snapshot -- nunca exige ARMED_DEMO (Bloqueador 9)", (t) => {
  setupMocks(t, { armed: false, snapshotError: new snapshotModule.SnapshotMissingError() });
  const r1 = assertDemoOrderAllowed({ env: validDemoEnv(), opName: "cancelOrder", params: { symbol: "SOLUSDT", orderLinkId: "algum-id" }, now: NOW });
  assert.equal(r1.kind, "CANCEL");
  const r2 = assertDemoOrderAllowed({ env: validDemoEnv(), opName: "cancelAllOrders", params: { symbol: "SOLUSDT" }, now: NOW });
  assert.equal(r2.kind, "CANCEL");
});

test("assertDemoOrderAllowed: ação AMBÍGUA nunca é permitida, mesmo com ARMED_DEMO", (t) => {
  setupMocks(t, { localState: { isOpened: true, side: "Buy", orderType: "Market", qty: 2, entryPrice: 40 }, armed: true, snapshot: {} });
  assert.throws(
    () =>
      assertDemoOrderAllowed({
        env: validDemoEnv(),
        opName: "placeOrder",
        params: { side: "Sell", qty: "1", reduceOnly: false, orderLinkId: createOrderLinkId() }, // lado oposto sem reduceOnly=true -> ambíguo
        now: NOW,
      }),
    AmbiguousOperationError
  );
});

test("assertDemoOrderAllowed: orderLinkId ausente em INCREASE_EXPOSURE -> bloqueado", (t) => {
  setupMocks(t, { armed: true, snapshot: {} });
  assert.throws(
    () =>
      assertDemoOrderAllowed({
        env: validDemoEnv(),
        opName: "placeOrder",
        params: { side: "Buy", orderType: "Market", qty: "1", price: "40", reduceOnly: false },
        now: NOW,
      }),
    (err) => {
      assert.equal(err.code, "DEMO_ORDER_LINK_ID_REQUIRED");
      return true;
    }
  );
});

test("assertDemoOrderAllowed: orderLinkId reutilizado -> DEMO_ORDER_LINK_ID_REUSED, segunda tentativa idêntica nunca reprocessada", (t) => {
  setupMocks(t, { armed: true, snapshot: {} });
  const orderLinkId = createOrderLinkId();
  const params = { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", price: "40", stopLoss: "38", reduceOnly: false, orderLinkId };
  assertDemoOrderAllowed({ env: validDemoEnv(), opName: "placeOrder", params, now: NOW });
  assert.throws(
    () => assertDemoOrderAllowed({ env: validDemoEnv(), opName: "placeOrder", params, now: NOW + 1000 }),
    (err) => {
      assert.equal(err.code, "DEMO_ORDER_LINK_ID_REUSED");
      return true;
    }
  );
});

test("assertDemoOrderAllowed: setLeverage acima do teto -> bloqueado mesmo com ARMED_DEMO", (t) => {
  setupMocks(t, { armed: true, snapshot: {} });
  assert.throws(
    () =>
      assertDemoOrderAllowed({
        env: validDemoEnv(),
        opName: "setLeverage",
        params: { symbol: "SOLUSDT", leverage: "10" }, // default max=2
        now: NOW,
      }),
    (err) => {
      assert.equal(err.code, "DEMO_RISK_LIMIT_BLOCKED");
      assert.equal(err.reason, "leverage_exceeds_limit");
      return true;
    }
  );
});

test("assertDemoOrderAllowed: applyDemoFunds (ADMINISTRATION) sem ARMED_DEMO -> bloqueado", (t) => {
  setupMocks(t, { armed: false });
  assert.throws(() => assertDemoOrderAllowed({ env: validDemoEnv(), opName: "applyDemoFunds", params: { coin: "USDT", amount: "100" }, now: NOW }), killSwitch.NewExposureBlockedError);
});

test("assertDemoOrderAllowed: applyDemoFunds (ADMINISTRATION) com ARMED_DEMO + snapshot fresco -> permitido", (t) => {
  setupMocks(t, { armed: true, snapshot: {} });
  const result = assertDemoOrderAllowed({ env: validDemoEnv(), opName: "applyDemoFunds", params: { coin: "USDT", amount: "100" }, now: NOW });
  assert.equal(result.kind, "ADMINISTRATION");
});

test("assertDemoOrderAllowed: campos de risco INVENTADOS no `params` (simulando AgentRouter/frontend malicioso/com bug) são IGNORADOS -- o estado real vem do snapshot autenticado, nunca do chamador", (t) => {
  // O chamador tenta "declarar" que não há posição aberta, mas o
  // SNAPSHOT AUTENTICADO (única fonte aceita pra autorizar aumento,
  // Bloqueador 3) mostra 1 posição já aberta -- o snapshot sempre
  // prevalece, nunca os campos soltos em params.
  setupMocks(t, { armed: true, snapshot: { positions: [{ symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", entryPrice: "40" }], exposureUsd: "40" } });
  const spoofedParams = {
    symbol: "SOLUSDT",
    side: "Buy",
    orderType: "Market",
    qty: "1",
    price: "40",
    reduceOnly: false,
    orderLinkId: createOrderLinkId(),
    openPositionsCount: 0, // tentativa de spoof -- ignorado
    currentExposureUsd: "0", // tentativa de spoof -- ignorado
    consecutiveErrors: 0, // tentativa de spoof -- ignorado
  };
  assert.throws(
    () => assertDemoOrderAllowed({ env: validDemoEnv(), opName: "placeOrder", params: spoofedParams, now: NOW }),
    (err) => {
      assert.equal(err.code, "DEMO_RISK_LIMIT_BLOCKED");
      assert.ok(["max_positions_reached", "projected_exposure_exceeds_limit"].includes(err.reason));
      return true;
    }
  );
});

test("buildTrustedDemoRiskState: função interna de classificação/telemetria -- não é a autorização de aumento de exposição (essa é buildAuthoritativeIncreaseExposureState + snapshot)", (t) => {
  t.mock.method(ledger, "getRecentOrderTimestamps", () => []);
  t.mock.method(ledger, "getLastOrderAt", () => null);
  t.mock.method(ledger, "getConsecutiveErrorCount", () => 0);
  const state = buildTrustedDemoRiskState({
    loadState: () => ({ ...DEFAULT_STATE, isOpened: true, side: "Sell", qty: 3, entryPrice: 100, consecutiveLosses: 2, dailyLoss: 0.01 }),
    orderPeriodMs: 60000,
    now: NOW,
  });
  assert.equal(state.isOpened, true);
  assert.equal(state.side, "Sell");
  assert.equal(state.qty, 3);
  assert.equal(state.currentExposureUsd, 300);
  assert.equal(state.consecutiveLosses, 2);
  assert.equal(state.dailyLossPct, 0.01);
});

// =====================================================================
// Concorrência intra-processo -- a prova de exclusão REAL entre
// processos distintos (Bloqueador 5) está em test/demoConcurrency.test.js,
// com subprocessos de verdade, nunca Promise.all. Este teste aqui só
// confirma que o lock (ainda que dentro do mesmo processo) serializa a
// decisão via lib/demoReservationLock.js, mantendo a idempotência do
// orderLinkId.
// =====================================================================

test("intra-processo: duas tentativas com o MESMO orderLinkId disparadas via Promise.all -- só uma é gravada, a outra é rejeitada por reuso", async (t) => {
  setupMocks(t, { armed: true, snapshot: {} });
  const orderLinkId = createOrderLinkId();
  const params = { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", price: "40", stopLoss: "38", reduceOnly: false, orderLinkId };
  const run = () => Promise.resolve().then(() => assertDemoOrderAllowed({ env: validDemoEnv(), opName: "placeOrder", params, now: NOW }));
  const results = await Promise.allSettled([run(), run()]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exatamente 1 das 2 tentativas concorrentes deveria ter sido aceita");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "DEMO_ORDER_LINK_ID_REUSED");
});

// =====================================================================
// Nenhum teste deste arquivo toca rede ou banco real.
// =====================================================================

test("nenhum teste deste arquivo importa axios/net/http nem better-sqlite3 -- todas as dependências de I/O são mockadas via t.mock.method", () => {
  const firstTestLine = fs
    .readFileSync(__filename, "utf8")
    .split("\n")
    .findIndex((line) => line.startsWith("test("));
  const importsOnly = fs.readFileSync(__filename, "utf8").split("\n").slice(0, firstTestLine).join("\n");
  const forbidden = ["axios", "node:http", '"http"', "better-sqlite3", "node:net", '"net"'];
  for (const token of forbidden) {
    assert.ok(!importsOnly.includes(token), `imports deste arquivo não deveriam mencionar "${token}"`);
  }
});

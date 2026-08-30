// Helper compartilhado pra mockar TODAS as dependências de I/O do gate
// canônico do perfil demo (lib/demoOrderGate.js) via t.mock.method --
// nunca via parâmetro público (Bloqueador 2, lib/demoOrderGate.js não
// aceita mais isso). Usado por test/demoOrderGate.test.js e
// test/bybit.test.js pra nunca tocar runtime/demo/ real durante os
// testes, sem duplicar a mesma lógica de mock nos dois arquivos.
const killSwitch = require("../../lib/killSwitch");
const ledger = require("../../lib/demoOrderLedger");
const snapshotModule = require("../../lib/demoAccountSnapshot");
const stateModule = require("../../lib/state");
const { DEFAULT_STATE } = stateModule;

function fakeSnapshot(overrides = {}) {
  return {
    schemaVersion: 3,
    credentialFingerprint: "sha256:fake",
    capturedAtMs: Date.now(),
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
    // Default: leverage efetiva "2" == teto default (DEMO_MAX_LEVERAGE),
    // tradeMode cross, positionIdx one-way -- combinação que PASSA pelas
    // checagens da Rodada 5 sem precisar de override na maioria dos
    // testes; testes que querem provar bloqueio sobrescrevem via
    // `snapshot: { symbolState: {...} }`.
    symbolState: { hasOpenPosition: false, side: null, qty: null, entryPrice: null, stopLossPrice: null, effectiveLeverage: "2", tradeMode: 0, positionIdx: 0 },
    ...overrides,
  };
}

/**
 * Mocka killSwitch/ledger/snapshot/state pro cenário indicado por `t`
 * (restaurado automaticamente ao fim do teste pelo node:test). Devolve
 * `{ recorded, usedIds }` pra inspeção de quais reservas foram gravadas.
 */
function mockDemoAuth(t, { localState = {}, armed = false, killSwitchState = killSwitch.STATES.BLOCK_NEW_EXPOSURE, snapshot, snapshotError, ledgerCounters = {} } = {}) {
  t.mock.method(stateModule, "load", () => ({ ...DEFAULT_STATE, ...localState }));
  t.mock.method(ledger, "recordLastDecision", () => {});
  t.mock.method(ledger, "recordPrivateCallOutcome", () => {}); // telemetria de outcome (lib/bybit.js) -- nunca deveria tocar runtime/demo/ real em teste

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

module.exports = { mockDemoAuth, fakeSnapshot };

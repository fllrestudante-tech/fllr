const test = require("node:test");
const assert = require("node:assert/strict");
const bybit = require("../lib/bybit");
const state = require("../lib/state");

function localOpenState(overrides = {}) {
  return { isOpened: true, side: "Buy", qty: 0.01, entryPrice: 100, ...overrides };
}

test("reconcile: posição real com qty menor que a local -- reporta partiallyClosedQty (Fase D5)", async (t) => {
  t.mock.method(bybit, "getPositions", async () => [{ side: "Buy", size: "0.007", avgPrice: "100" }]);
  const result = await state.reconcile(localOpenState({ qty: 0.01 }));
  assert.ok(Math.abs(result.partiallyClosedQty - 0.003) < 1e-9);
  assert.equal(result.closedExternally, false);
  assert.equal(result.state.isOpened, true);
  assert.equal(result.state.qty, 0.007);
});

test("reconcile: qty igual não reporta partiallyClosedQty", async (t) => {
  t.mock.method(bybit, "getPositions", async () => [{ side: "Buy", size: "0.01", avgPrice: "100" }]);
  const result = await state.reconcile(localOpenState({ qty: 0.01 }));
  assert.equal(result.partiallyClosedQty, 0);
});

test("reconcile: sem posição local aberta -- não reporta partiallyClosedQty mesmo com posição real existindo (abertura nova, não redução)", async (t) => {
  t.mock.method(bybit, "getPositions", async () => [{ side: "Buy", size: "0.01", avgPrice: "100" }]);
  const result = await state.reconcile({ isOpened: false, side: null, qty: null, entryPrice: null });
  assert.equal(result.partiallyClosedQty, 0);
  assert.equal(result.state.isOpened, true);
});

test("reconcile: posição sumiu por completo -- closedExternally true, partiallyClosedQty 0", async (t) => {
  t.mock.method(bybit, "getPositions", async () => []);
  const result = await state.reconcile(localOpenState());
  assert.equal(result.closedExternally, true);
  assert.equal(result.partiallyClosedQty, 0);
  assert.equal(result.state.isOpened, false);
});

test("reconcile: fechamento total não zera stopLossPrice/takeProfitPrice/breakEvenApplied/trailingActivated (handleExternalClose precisa desses valores antes de limpar)", async (t) => {
  t.mock.method(bybit, "getPositions", async () => []);
  const local = localOpenState({ stopLossPrice: 97, takeProfitPrice: 106, breakEvenApplied: true, trailingActivated: false });
  const result = await state.reconcile(local);
  assert.equal(result.state.stopLossPrice, 97);
  assert.equal(result.state.takeProfitPrice, 106);
  assert.equal(result.state.breakEvenApplied, true);
});

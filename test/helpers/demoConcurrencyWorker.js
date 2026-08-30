// Worker de subprocesso REAL usado só por test/demoConcurrency.test.js
// pra provar exclusão mútua entre PROCESSOS distintos (Bloqueador 5) --
// nunca executado como parte da suíte diretamente. Sempre invocado com
// CRYPTO10_DEMO_RUNTIME_DIR apontando pra um diretório TEMPORÁRIO
// isolado, nunca o runtime/demo/ operacional real.
// Modo "setup": só arma o kill switch e grava um snapshot fresco, uma
// única vez, ANTES dos processos concorrentes começarem -- evita que os
// DOIS processos da corrida escrevam o mesmo arquivo de snapshot ao
// mesmo tempo (isso seria uma corrida DIFERENTE da que este teste quer
// provar, sem relação com o lock de reserva). Modo "race" (default): só
// lê o que já está em disco e disputa o lock de reserva de verdade.
async function main() {
  const mode = process.argv[2];

  const stateModule = require("../../lib/state");
  stateModule.load = () => ({ ...stateModule.DEFAULT_STATE, isOpened: false });

  if (mode === "setup") {
    const killSwitch = require("../../lib/killSwitch");
    killSwitch.armDemo(undefined, { reason: "teste-concorrencia-subprocesso" });
    const snapshotModule = require("../../lib/demoAccountSnapshot");
    await snapshotModule.captureDemoAccountSnapshot({
      symbol: "SOLUSDT",
      getWalletBalance: async () => ({ totalEquity: "1000" }),
      getPositions: async () => [{ symbol: "SOLUSDT", side: "", size: "0", leverage: "2", tradeMode: 0, positionIdx: 0 }],
      getOpenOrders: async () => [],
      getInstrumentInfo: async () => ({ qtyStep: "0.1", minOrderQty: "0.1", maxOrderQty: "96000.0", maxMktOrderQty: "12000.0", tickSize: "0.01", minPrice: "0.01", maxPrice: "199999.98", minNotionalValue: "5" }),
    });
    process.stdout.write(JSON.stringify({ ok: true, setup: true }) + "\n");
    return;
  }

  const orderLinkId = process.argv[3];
  const gate = require("../../lib/demoOrderGate");
  try {
    const result = gate.assertDemoOrderAllowed({
      opName: "placeOrder",
      params: { symbol: "SOLUSDT", side: "Buy", orderType: "Market", qty: "1", price: "20", leverage: "2", stopLoss: "19", reduceOnly: false, orderLinkId },
      now: Date.now(),
    });
    process.stdout.write(JSON.stringify({ ok: true, kind: result.kind }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, code: err.code, reason: err.reason || null }) + "\n");
  }
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, code: "WORKER_CRASH", message: err.message }) + "\n");
  process.exitCode = 1;
});

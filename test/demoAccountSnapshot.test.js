const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  SnapshotMissingError,
  SnapshotCorruptError,
  SnapshotStaleError,
  SnapshotEnvironmentMismatchError,
  SnapshotCredentialMismatchError,
  computeCredentialFingerprint,
  computeConservativeExposureUsd,
  captureDemoAccountSnapshot,
  readTrustedSnapshot,
  DEFAULT_MAX_SNAPSHOT_AGE_MS,
} = require("../lib/demoAccountSnapshot");

function tempPath(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bot-cripto10-snapshot-${label}-`));
  return { dir, snapshotPath: path.join(dir, "account-snapshot.json") };
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const NOW = 1_756_000_000_000;
const ENV = { BYBIT_API_KEY: "fake-key-not-a-real-secret", BYBIT_DEMO: "true" };
const GOOD_INSTRUMENT_INFO = async () => ({ qtyStep: "0.1", minOrderQty: "0.1", maxOrderQty: "10", tickSize: "0.01" });

// =====================================================================
// computeCredentialFingerprint -- não-secreto, estável, nunca reversível
// =====================================================================

test("computeCredentialFingerprint: mesma chave -> mesmo fingerprint; chave diferente -> fingerprint diferente", () => {
  const a = computeCredentialFingerprint("chave-1");
  const b = computeCredentialFingerprint("chave-1");
  const c = computeCredentialFingerprint("chave-2");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith("sha256:"));
  assert.ok(!a.includes("chave-1"), "o fingerprint nunca deveria conter a chave original");
});

// =====================================================================
// computeConservativeExposureUsd -- posição + TODAS as ordens abertas
// não-reduceOnly (Bloqueador 4)
// =====================================================================

test("computeConservativeExposureUsd: soma posição + ordens abertas não-reduceOnly, IGNORA ordens reduceOnly=true", () => {
  const positions = [{ qty: "1", entryPrice: "40" }];
  const openOrders = [
    { qty: "1", price: "20", reduceOnly: false },
    { qty: "5", price: "100", reduceOnly: true }, // ignorada -- explicitamente marcada como redução
  ];
  assert.equal(computeConservativeExposureUsd(positions, openOrders), "60"); // 40 + 20, nunca 40+20+500
});

test("computeConservativeExposureUsd: ordem sem reduceOnly explícito (undefined) é contada como SE aumentasse exposição -- nunca presumida segura", () => {
  const openOrders = [{ qty: "2", price: "10" }]; // reduceOnly ausente
  assert.equal(computeConservativeExposureUsd([], openOrders), "20");
});

test("computeConservativeExposureUsd: sem posições nem ordens -> 0", () => {
  assert.equal(computeConservativeExposureUsd([], []), "0");
});

// =====================================================================
// captureDemoAccountSnapshot -- orquestra as 3 leituras privadas
// (injetadas) e grava atomicamente
// =====================================================================

test("captureDemoAccountSnapshot: grava snapshot com exposureUsd conservador, filtra posições zeradas", async (t) => {
  const { dir, snapshotPath } = tempPath("capture-basic");
  t.after(() => cleanup(dir));
  const snapshot = await captureDemoAccountSnapshot({
    env: ENV,
    snapshotPath,
    symbol: "SOLUSDT",
    now: NOW,
    getWalletBalance: async () => ({ totalEquity: "1000" }),
    getPositions: async () => [
      { symbol: "SOLUSDT", side: "Buy", size: "1", avgPrice: "40", stopLoss: "38" },
      { symbol: "BTCUSDT", side: "Buy", size: "0", avgPrice: "0" }, // posição zerada -- deve ser filtrada
    ],
    getOpenOrders: async () => [{ symbol: "SOLUSDT", side: "Buy", qty: "1", price: "20", reduceOnly: false, orderLinkId: "x" }],
    getInstrumentInfo: GOOD_INSTRUMENT_INFO,
  });
  assert.equal(snapshot.positions.length, 1);
  assert.equal(snapshot.positions[0].symbol, "SOLUSDT");
  assert.equal(snapshot.exposureUsd, "60"); // 40 (posição) + 20 (ordem aberta não-reduceOnly)
  assert.equal(snapshot.endpoint, "demo");
  assert.equal(snapshot.capturedAtMs, NOW);
  assert.deepEqual(snapshot.instrumentInfo, { symbol: "SOLUSDT", qtyStep: "0.1", minOrderQty: "0.1", maxOrderQty: "10", tickSize: "0.01" });
  assert.ok(fs.existsSync(snapshotPath));
});

test("captureDemoAccountSnapshot: getInstrumentInfo incompleto (sem qtyStep/minOrderQty/tickSize) -> lança IncompleteInstrumentInfoError, nunca grava snapshot parcial", async (t) => {
  const { dir, snapshotPath } = tempPath("capture-incomplete-instrument");
  t.after(() => cleanup(dir));
  await assert.rejects(
    () =>
      captureDemoAccountSnapshot({
        env: ENV,
        snapshotPath,
        symbol: "SOLUSDT",
        now: NOW,
        getWalletBalance: async () => ({ totalEquity: "1000" }),
        getPositions: async () => [],
        getOpenOrders: async () => [],
        getInstrumentInfo: async () => ({ qtyStep: "0.1" }), // sem minOrderQty/tickSize
      }),
    (err) => {
      assert.equal(err.code, "SNAPSHOT_INSTRUMENT_INFO_INCOMPLETE");
      return true;
    }
  );
  assert.equal(fs.existsSync(snapshotPath), false, "nenhum snapshot deveria ter sido gravado");
});

test("captureDemoAccountSnapshot: BYBIT_DEMO != 'true' -> endpoint gravado como 'not_demo' (nunca mascarado como demo)", async (t) => {
  const { dir, snapshotPath } = tempPath("capture-not-demo");
  t.after(() => cleanup(dir));
  const snapshot = await captureDemoAccountSnapshot({
    env: { ...ENV, BYBIT_DEMO: "false" },
    snapshotPath,
    symbol: "SOLUSDT",
    now: NOW,
    getWalletBalance: async () => ({ totalEquity: "1000" }),
    getPositions: async () => [],
    getOpenOrders: async () => [],
    getInstrumentInfo: GOOD_INSTRUMENT_INFO,
  });
  assert.equal(snapshot.endpoint, "not_demo");
});

// =====================================================================
// readTrustedSnapshot -- toda forma de "não confiável" tem um erro
// tipado próprio, NUNCA um snapshot parcial (Bloqueador 3)
// =====================================================================

test("readTrustedSnapshot: arquivo ausente -> SnapshotMissingError", (t) => {
  const { dir, snapshotPath } = tempPath("read-missing");
  t.after(() => cleanup(dir));
  assert.throws(() => readTrustedSnapshot({ env: ENV, snapshotPath, now: NOW }), SnapshotMissingError);
});

test("readTrustedSnapshot: JSON inválido -> SnapshotCorruptError", (t) => {
  const { dir, snapshotPath } = tempPath("read-corrupt-json");
  t.after(() => cleanup(dir));
  fs.writeFileSync(snapshotPath, "não é json {{{");
  assert.throws(() => readTrustedSnapshot({ env: ENV, snapshotPath, now: NOW }), SnapshotCorruptError);
});

test("readTrustedSnapshot: schemaVersion inesperado -> SnapshotCorruptError", (t) => {
  const { dir, snapshotPath } = tempPath("read-corrupt-schema");
  t.after(() => cleanup(dir));
  fs.writeFileSync(snapshotPath, JSON.stringify({ schemaVersion: 999 }));
  assert.throws(() => readTrustedSnapshot({ env: ENV, snapshotPath, now: NOW }), SnapshotCorruptError);
});

test("readTrustedSnapshot: campos essenciais ausentes (positions/openOrders/exposureUsd) -> SnapshotCorruptError", (t) => {
  const { dir, snapshotPath } = tempPath("read-corrupt-fields");
  t.after(() => cleanup(dir));
  fs.writeFileSync(snapshotPath, JSON.stringify({ schemaVersion: 2, capturedAtMs: NOW, credentialFingerprint: "sha256:x" }));
  assert.throws(() => readTrustedSnapshot({ env: ENV, snapshotPath, now: NOW }), SnapshotCorruptError);
});

test("readTrustedSnapshot: snapshot mais velho que DEFAULT_MAX_SNAPSHOT_AGE_MS -> SnapshotStaleError", async (t) => {
  const { dir, snapshotPath } = tempPath("read-stale");
  t.after(() => cleanup(dir));
  await captureDemoAccountSnapshot({ env: ENV, snapshotPath, symbol: "SOLUSDT", now: NOW, getWalletBalance: async () => ({ totalEquity: "1" }), getPositions: async () => [], getOpenOrders: async () => [], getInstrumentInfo: GOOD_INSTRUMENT_INFO });
  assert.throws(() => readTrustedSnapshot({ env: ENV, snapshotPath, now: NOW + DEFAULT_MAX_SNAPSHOT_AGE_MS + 1 }), SnapshotStaleError);
});

test("readTrustedSnapshot: snapshot 'do futuro' (capturedAtMs > now) -> SnapshotStaleError, nunca aceito", async (t) => {
  const { dir, snapshotPath } = tempPath("read-future");
  t.after(() => cleanup(dir));
  await captureDemoAccountSnapshot({ env: ENV, snapshotPath, symbol: "SOLUSDT", now: NOW + 60000, getWalletBalance: async () => ({ totalEquity: "1" }), getPositions: async () => [], getOpenOrders: async () => [], getInstrumentInfo: GOOD_INSTRUMENT_INFO });
  assert.throws(() => readTrustedSnapshot({ env: ENV, snapshotPath, now: NOW }), SnapshotStaleError);
});

test("readTrustedSnapshot: dentro da janela de frescor -> aceito", async (t) => {
  const { dir, snapshotPath } = tempPath("read-fresh");
  t.after(() => cleanup(dir));
  await captureDemoAccountSnapshot({ env: ENV, snapshotPath, symbol: "SOLUSDT", now: NOW, getWalletBalance: async () => ({ totalEquity: "1" }), getPositions: async () => [], getOpenOrders: async () => [], getInstrumentInfo: GOOD_INSTRUMENT_INFO });
  const snapshot = readTrustedSnapshot({ env: ENV, snapshotPath, now: NOW + 1000 });
  assert.equal(snapshot.capturedAtMs, NOW);
});

test("readTrustedSnapshot: endpoint != 'demo' -> SnapshotEnvironmentMismatchError, nunca aceita snapshot de outro ambiente", async (t) => {
  const { dir, snapshotPath } = tempPath("read-wrong-env");
  t.after(() => cleanup(dir));
  await captureDemoAccountSnapshot({ env: { ...ENV, BYBIT_DEMO: "false" }, snapshotPath, symbol: "SOLUSDT", now: NOW, getWalletBalance: async () => ({ totalEquity: "1" }), getPositions: async () => [], getOpenOrders: async () => [], getInstrumentInfo: GOOD_INSTRUMENT_INFO });
  assert.throws(() => readTrustedSnapshot({ env: ENV, snapshotPath, now: NOW }), SnapshotEnvironmentMismatchError);
});

test("readTrustedSnapshot: fingerprint de credencial diferente do env atual -> SnapshotCredentialMismatchError, nunca reaproveita snapshot de outra conta/chave", async (t) => {
  const { dir, snapshotPath } = tempPath("read-wrong-cred");
  t.after(() => cleanup(dir));
  await captureDemoAccountSnapshot({ env: { ...ENV, BYBIT_API_KEY: "chave-antiga" }, snapshotPath, symbol: "SOLUSDT", now: NOW, getWalletBalance: async () => ({ totalEquity: "1" }), getPositions: async () => [], getOpenOrders: async () => [], getInstrumentInfo: GOOD_INSTRUMENT_INFO });
  assert.throws(() => readTrustedSnapshot({ env: { ...ENV, BYBIT_API_KEY: "chave-nova" }, snapshotPath, now: NOW }), SnapshotCredentialMismatchError);
});

test("nenhum teste deste arquivo importa axios/net/http -- captureDemoAccountSnapshot só recebe funções de leitura injetadas (fixtures locais)", () => {
  const firstTestLine = fs
    .readFileSync(__filename, "utf8")
    .split("\n")
    .findIndex((line) => line.startsWith("test("));
  const importsOnly = fs.readFileSync(__filename, "utf8").split("\n").slice(0, firstTestLine).join("\n");
  for (const token of ["axios", "node:http", '"http"', "node:net", '"net"']) {
    assert.ok(!importsOnly.includes(token), `imports deste arquivo não deveriam mencionar "${token}"`);
  }
});

test("readTrustedSnapshot: instrumentInfo presente mas incompleto no arquivo bruto -> SnapshotCorruptError", (t) => {
  const { dir, snapshotPath } = tempPath("read-corrupt-instrument");
  t.after(() => cleanup(dir));
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({
      schemaVersion: 2,
      capturedAtMs: NOW,
      credentialFingerprint: computeCredentialFingerprint(ENV.BYBIT_API_KEY),
      endpoint: "demo",
      equityUsd: "1",
      positions: [],
      openOrders: [],
      exposureUsd: "0",
      instrumentInfo: { symbol: "SOLUSDT", qtyStep: "0.1" }, // sem minOrderQty/tickSize
    })
  );
  assert.throws(() => readTrustedSnapshot({ env: ENV, snapshotPath, now: NOW }), SnapshotCorruptError);
});

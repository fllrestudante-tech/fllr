const test = require("node:test");
const assert = require("node:assert/strict");
const {
  checkInternetReachable,
  checkProviderHealth,
  classifyConnectivity,
  severityForReason,
  createConnectivityMonitor,
  formatIncidentMessage,
} = require("../lib/connectivityManager");

function fakeProbe(result) {
  return async () => result;
}

test("checkInternetReachable: true se pelo menos um host responder", async () => {
  const probe = async ({ host }) => host === "1.1.1.1"; // só o primeiro responde
  const ok = await checkInternetReachable({ hosts: [{ host: "1.1.1.1", port: 443 }, { host: "8.8.8.8", port: 443 }], probe });
  assert.equal(ok, true);
});

test("checkInternetReachable: false se nenhum host responder", async () => {
  const ok = await checkInternetReachable({ hosts: [{ host: "1.1.1.1", port: 443 }], probe: fakeProbe(false) });
  assert.equal(ok, false);
});

test("checkProviderHealth: ok quando get resolve e validate aprova", async () => {
  const get = async () => ({ data: { retCode: 0 } });
  const result = await checkProviderHealth({ get, url: "x", validate: (res) => res.data.retCode === 0 });
  assert.deepEqual(result, { ok: true, error: null });
});

test("checkProviderHealth: falha quando get rejeita (erro de rede/timeout)", async () => {
  const err = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  const get = async () => {
    throw err;
  };
  const result = await checkProviderHealth({ get, url: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.error, err);
});

test("checkProviderHealth: falha quando validate rejeita a resposta (provider respondeu algo inesperado)", async () => {
  const get = async () => ({ data: { retCode: 10001 } });
  const result = await checkProviderHealth({ get, url: "x", validate: (res) => res.data.retCode === 0 });
  assert.equal(result.ok, false);
});

test("classifyConnectivity: tabela-verdade dos cenários possíveis", () => {
  const noErrors = { bybit: null, coingecko: null, telegram: null };
  assert.equal(classifyConnectivity({ internetOk: false, providerErrors: noErrors }), "internet_down");
  assert.equal(classifyConnectivity({ internetOk: true, providerErrors: noErrors }), "ok");

  const dnsErr = Object.assign(new Error("dns"), { code: "ENOTFOUND" });
  assert.equal(
    classifyConnectivity({ internetOk: true, providerErrors: { bybit: dnsErr, coingecko: null, telegram: null } }),
    "dns_down"
  );

  const genericErr = new Error("500");
  assert.equal(
    classifyConnectivity({ internetOk: true, providerErrors: { bybit: genericErr, coingecko: null, telegram: null } }),
    "bybit_down"
  );
  assert.equal(
    classifyConnectivity({ internetOk: true, providerErrors: { bybit: null, coingecko: genericErr, telegram: null } }),
    "coingecko_down"
  );
  assert.equal(
    classifyConnectivity({ internetOk: true, providerErrors: { bybit: null, coingecko: null, telegram: genericErr } }),
    "telegram_down"
  );
});

test("classifyConnectivity: internet_down vence mesmo se providerErrors também estiver preenchido", () => {
  const err = new Error("x");
  assert.equal(
    classifyConnectivity({ internetOk: false, providerErrors: { bybit: err, coingecko: err, telegram: err } }),
    "internet_down"
  );
});

test("severityForReason: HIGH para internet/dns/bybit, MEDIUM para coingecko/telegram", () => {
  assert.equal(severityForReason("internet_down"), "HIGH");
  assert.equal(severityForReason("dns_down"), "HIGH");
  assert.equal(severityForReason("bybit_down"), "HIGH");
  assert.equal(severityForReason("coingecko_down"), "MEDIUM");
  assert.equal(severityForReason("telegram_down"), "MEDIUM");
});

test("createConnectivityMonitor: uma falha isolada não abre incidente", () => {
  let t = 0;
  const monitor = createConnectivityMonitor({ now: () => t, consecutiveFailuresToOpen: 2 });
  const r1 = monitor.recordCheck("bybit_down");
  assert.equal(r1.action, "none");
  assert.equal(monitor.getOpenIncident(), null);
});

test("createConnectivityMonitor: 2+ falhas seguidas abrem o incidente", () => {
  let t = 1000;
  const monitor = createConnectivityMonitor({ now: () => t, consecutiveFailuresToOpen: 2 });
  monitor.recordCheck("bybit_down");
  t = 2000;
  const r2 = monitor.recordCheck("bybit_down");
  assert.equal(r2.action, "open");
  assert.deepEqual(monitor.getOpenIncident(), { reason: "bybit_down", startedAt: 2000 });
});

test("createConnectivityMonitor: causa pode mudar no meio do incidente -- usa a mais recente", () => {
  let t = 0;
  const monitor = createConnectivityMonitor({ now: () => t, consecutiveFailuresToOpen: 2 });
  monitor.recordCheck("internet_down");
  t = 1000;
  monitor.recordCheck("internet_down"); // abre com internet_down
  t = 2000;
  monitor.recordCheck("bybit_down"); // internet voltou no meio, só a Bybit continua fora
  assert.equal(monitor.getOpenIncident().reason, "bybit_down");
});

test("createConnectivityMonitor: recordCheck('ok') fecha o incidente e calcula durationMs certo", () => {
  let t = 0;
  const monitor = createConnectivityMonitor({ now: () => t, consecutiveFailuresToOpen: 2 });
  monitor.recordCheck("bybit_down");
  t = 1000;
  monitor.recordCheck("bybit_down");
  t = 1000 + 44 * 60000;
  const result = monitor.recordCheck("ok");
  assert.equal(result.action, "close");
  assert.equal(result.incident.durationMs, 44 * 60000);
  assert.equal(monitor.getOpenIncident(), null);
});

test("createConnectivityMonitor: resumeIncident retoma um incidente já aberto (restart do supervisor)", () => {
  let t = 5000;
  const monitor = createConnectivityMonitor({ now: () => t, consecutiveFailuresToOpen: 2 });
  monitor.resumeIncident({ reason: "internet_down", startedAt: 1000 });
  assert.deepEqual(monitor.getOpenIncident(), { reason: "internet_down", startedAt: 1000 });

  t = 10000;
  const result = monitor.recordCheck("ok");
  assert.equal(result.action, "close");
  assert.equal(result.incident.durationMs, 9000);
});

test("formatIncidentMessage: formato exato com fixture de 44 minutos", () => {
  const incident = { reason: "bybit_down", startedAt: Date.UTC(2026, 6, 20, 14, 23), endedAt: Date.UTC(2026, 6, 20, 15, 7), durationMs: 44 * 60000 };
  const msg = formatIncidentMessage(incident);
  assert.match(msg, /14:23/);
  assert.match(msg, /15:07/);
  assert.match(msg, /44min/);
  assert.match(msg, /Bybit/);
  assert.match(msg, /Coleta retomada automaticamente/);
});

test("formatIncidentMessage: inclui resumo de resync quando fornecido", () => {
  const incident = { reason: "internet_down", startedAt: 0, endedAt: 60000, durationMs: 60000 };
  const msg = formatIncidentMessage(incident, { resyncSummary: "candles: 1/1 recuperados" });
  assert.match(msg, /candles: 1\/1 recuperados/);
});

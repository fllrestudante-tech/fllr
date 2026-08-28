const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { createDashboardServer } = require("../scripts/dashboardServer");
const { REQUIRED_TABLES } = require("../lib/webDashboard/dashboardHealth");
const { DASHBOARD_BIND_HOST } = require("../lib/webDashboard/dashboardBindConfig");

// Fixture -- NUNCA o market.db persistente real (banco escrevível, criado e
// destruído por teste, isolado em diretório temporário próprio).
function makeFixtureDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bot-cripto10-dashboardserver-${label}-`));
  const dbPath = path.join(dir, "fixture.db");
  const db = new Database(dbPath);
  for (const table of REQUIRED_TABLES) {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
  }
  db.close();
  return { dir, dbPath };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Sobe um servidor efêmero em 127.0.0.1:0 (porta livre escolhida pelo SO,
// nunca uma porta fixa/real) e devolve a base URL real já resolvida.
function listenEphemeral(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, DASHBOARD_BIND_HOST, () => {
      const addr = server.address();
      resolve({ address: addr.address, port: addr.port, baseUrl: `http://${addr.address}:${addr.port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function get(url, { method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("createDashboardServer: escuta exatamente em 127.0.0.1, nunca em 0.0.0.0/::", async (t) => {
  const server = createDashboardServer();
  const { address } = await listenEphemeral(server);
  t.after(() => closeServer(server));
  assert.equal(address, "127.0.0.1");
});

test("GET /api/v1/health: banco fixture com estrutura mínima, gate desligado -> 200, corpo público estável", async (t) => {
  const { dir, dbPath } = makeFixtureDb("health-ok");
  t.after(() => cleanup(dir));
  const server = createDashboardServer({ dbPath });
  const { baseUrl } = await listenEphemeral(server);
  t.after(() => closeServer(server));

  const res = await get(`${baseUrl}/api/v1/health`);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, {
    status: "ok",
    service: "crypto10-dashboard",
    mode: "safe",
    tradingExecutionEnabled: false,
    database: "ok",
  });
});

test("GET /api/v1/health: banco fixture ausente -> não é 200, resposta sanitizada sem caminho/stack", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-dashboardserver-health-missing-"));
  const missingPath = path.join(dir, "nao-existe.db");
  t.after(() => cleanup(dir));
  const server = createDashboardServer({ dbPath: missingPath });
  const { baseUrl } = await listenEphemeral(server);
  t.after(() => closeServer(server));

  const res = await get(`${baseUrl}/api/v1/health`);
  assert.notEqual(res.statusCode, 200);
  assert.equal(res.statusCode, 503);
  assert.ok(!res.body.includes(missingPath));
  assert.ok(!res.body.includes(dir));
  assert.ok(!res.body.toLowerCase().includes("stack"));
});

test("método diferente de GET em /api/v1/health -> não é 200 (mesma convenção das demais rotas: sem match = 404)", async (t) => {
  const { dir, dbPath } = makeFixtureDb("health-method");
  t.after(() => cleanup(dir));
  const server = createDashboardServer({ dbPath });
  const { baseUrl } = await listenEphemeral(server);
  t.after(() => closeServer(server));

  const res = await get(`${baseUrl}/api/v1/health`, { method: "POST" });
  assert.notEqual(res.statusCode, 200);
});

test("GET /api/v1/health: gate financeiro ligado -> não é 200, mesmo com banco perfeito", async (t) => {
  const prev = process.env.TRADING_EXECUTION_ENABLED;
  process.env.TRADING_EXECUTION_ENABLED = "true";
  t.after(() => {
    if (prev === undefined) delete process.env.TRADING_EXECUTION_ENABLED;
    else process.env.TRADING_EXECUTION_ENABLED = prev;
  });

  const { dir, dbPath } = makeFixtureDb("health-gate-on");
  t.after(() => cleanup(dir));
  const server = createDashboardServer({ dbPath });
  const { baseUrl } = await listenEphemeral(server);
  t.after(() => closeServer(server));

  const res = await get(`${baseUrl}/api/v1/health`);
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.tradingExecutionEnabled, true);
  assert.equal(body.status, "degraded");
});

test("GET /api/v1/health: SUPERVISOR_PROFILE inválido -> não é 200, mode 'invalid'", async (t) => {
  const prev = process.env.SUPERVISOR_PROFILE;
  process.env.SUPERVISOR_PROFILE = "producao-tudo-ligado-fake";
  t.after(() => {
    if (prev === undefined) delete process.env.SUPERVISOR_PROFILE;
    else process.env.SUPERVISOR_PROFILE = prev;
  });

  const { dir, dbPath } = makeFixtureDb("health-invalid-profile");
  t.after(() => cleanup(dir));
  const server = createDashboardServer({ dbPath });
  const { baseUrl } = await listenEphemeral(server);
  t.after(() => closeServer(server));

  const res = await get(`${baseUrl}/api/v1/health`);
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.mode, "invalid");
});

test("rota inexistente continua devolvendo 404 -- dispatch de rotas não foi quebrado pela mudança", async (t) => {
  const { dir, dbPath } = makeFixtureDb("existing-routes");
  t.after(() => cleanup(dir));
  const server = createDashboardServer({ dbPath });
  const { baseUrl } = await listenEphemeral(server);
  t.after(() => closeServer(server));

  const res = await get(`${baseUrl}/api/v1/rota-que-nao-existe`);
  assert.equal(res.statusCode, 404);
  const body = JSON.parse(res.body);
  assert.equal(body.success, false);
});

test("rota /api/v1/header (pré-existente) continua respondendo com o envelope de sempre (success/generatedAt), nunca quebra por causa da rota de health nova", async (t) => {
  const { dir, dbPath } = makeFixtureDb("header-route");
  t.after(() => cleanup(dir));
  const server = createDashboardServer({ dbPath });
  const { baseUrl } = await listenEphemeral(server);
  t.after(() => closeServer(server));

  const res = await get(`${baseUrl}/api/v1/header`);
  const body = JSON.parse(res.body);
  assert.ok("success" in body);
  assert.ok("generatedAt" in body);
});

test("servidor encerra de forma limpa (server.close aceita callback, libera a porta)", async () => {
  const server = createDashboardServer();
  const { port, address } = await listenEphemeral(server);
  await closeServer(server);
  assert.equal(server.listening, false);

  // A porta liberada pode ser reaberta imediatamente por outro servidor.
  const server2 = createDashboardServer();
  await new Promise((resolve, reject) => {
    server2.once("error", reject);
    server2.listen(port, address, resolve);
  });
  await closeServer(server2);
});

test("porta ocupada: o segundo servidor recebe EADDRINUSE e NUNCA escolhe outra porta silenciosamente", async (t) => {
  const serverA = createDashboardServer();
  const { port, address } = await listenEphemeral(serverA);
  t.after(() => closeServer(serverA));

  const serverB = createDashboardServer();
  const err = await new Promise((resolve) => {
    serverB.once("error", resolve);
    serverB.listen(port, address);
  });
  assert.equal(err.code, "EADDRINUSE");
  assert.equal(serverB.listening, false); // nunca ficou escutando em porta nenhuma, muito menos outra escolhida sozinha
});

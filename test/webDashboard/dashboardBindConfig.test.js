const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_DASHBOARD_PORT,
  MIN_DASHBOARD_PORT,
  MAX_DASHBOARD_PORT,
  DASHBOARD_BIND_HOST,
  DashboardPortError,
  resolveDashboardPort,
} = require("../../lib/webDashboard/dashboardBindConfig");

test("DASHBOARD_BIND_HOST: é exatamente '127.0.0.1' -- nunca 0.0.0.0/::/hostname automático", () => {
  assert.equal(DASHBOARD_BIND_HOST, "127.0.0.1");
});

test("DEFAULT_DASHBOARD_PORT: 4300, dentro do intervalo permitido", () => {
  assert.equal(DEFAULT_DASHBOARD_PORT, 4300);
  assert.ok(DEFAULT_DASHBOARD_PORT >= MIN_DASHBOARD_PORT && DEFAULT_DASHBOARD_PORT <= MAX_DASHBOARD_PORT);
});

test("resolveDashboardPort: DASHBOARD_PORT ausente -> porta padrão", () => {
  assert.equal(resolveDashboardPort({}), DEFAULT_DASHBOARD_PORT);
});

test("resolveDashboardPort: DASHBOARD_PORT vazio -> porta padrão", () => {
  assert.equal(resolveDashboardPort({ DASHBOARD_PORT: "" }), DEFAULT_DASHBOARD_PORT);
});

test("resolveDashboardPort: porta válida configurada é respeitada", () => {
  assert.equal(resolveDashboardPort({ DASHBOARD_PORT: "5000" }), 5000);
  assert.equal(resolveDashboardPort({ DASHBOARD_PORT: String(MIN_DASHBOARD_PORT) }), MIN_DASHBOARD_PORT);
  assert.equal(resolveDashboardPort({ DASHBOARD_PORT: String(MAX_DASHBOARD_PORT) }), MAX_DASHBOARD_PORT);
});

test("resolveDashboardPort: valores inválidos lançam DashboardPortError, nunca caem pro default silenciosamente", () => {
  const invalidValues = [
    "abc",
    "3.5",
    "-1",
    "0",
    "80", // abaixo de MIN_DASHBOARD_PORT
    "70000", // acima de MAX_DASHBOARD_PORT
    "1e3", // notação científica
    " 4300", // espaço
    "4300 ",
    "4300;DROP",
    "NaN",
    "Infinity",
    "0x10",
  ];
  for (const value of invalidValues) {
    assert.throws(() => resolveDashboardPort({ DASHBOARD_PORT: value }), DashboardPortError, `valor "${value}" deveria lançar`);
  }
});

test("resolveDashboardPort: mensagem de erro nomeia o valor recebido e o intervalo permitido, nunca segredo", () => {
  assert.throws(() => resolveDashboardPort({ DASHBOARD_PORT: "porta-invalida-fake" }), (err) => {
    assert.ok(err.message.includes("porta-invalida-fake"));
    assert.ok(err.message.includes(String(MIN_DASHBOARD_PORT)));
    assert.ok(err.message.includes(String(MAX_DASHBOARD_PORT)));
    assert.equal(err.code, "DASHBOARD_PORT_INVALID");
    return true;
  });
});

test("resolveDashboardPort: usa process.env por padrão quando nenhum env é passado", () => {
  const prev = process.env.DASHBOARD_PORT;
  delete process.env.DASHBOARD_PORT;
  try {
    assert.equal(resolveDashboardPort(), DEFAULT_DASHBOARD_PORT);
  } finally {
    if (prev === undefined) delete process.env.DASHBOARD_PORT;
    else process.env.DASHBOARD_PORT = prev;
  }
});

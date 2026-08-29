const test = require("node:test");
const assert = require("node:assert/strict");
const { getAllChildrenSummary, getSafeChildrenSummary } = require("../../lib/autostart/childrenSummary");

test("getAllChildrenSummary: inclui 'bot' explicitamente marcado category='trading' -- nunca escondido", () => {
  const all = getAllChildrenSummary();
  const bot = all.find((c) => c.name === "bot");
  assert.ok(bot);
  assert.equal(bot.category, "trading");
});

test("getAllChildrenSummary: nenhum nome/script duplicado", () => {
  const all = getAllChildrenSummary();
  assert.equal(new Set(all.map((c) => c.name)).size, all.length);
  assert.equal(new Set(all.map((c) => c.script)).size, all.length);
});

test("getSafeChildrenSummary: nunca inclui 'bot' (mesma prova de lib/supervisorProfile.js, reexposta aqui)", () => {
  const { children } = getSafeChildrenSummary({});
  assert.equal(children.some((c) => c.name === "bot"), false);
});

test("getSafeChildrenSummary: lista exata sem knowledge_collector quando as dependências estão ausentes", () => {
  const { children, skipped } = getSafeChildrenSummary({});
  const names = children.map((c) => c.name).sort();
  assert.deepEqual(names, ["backup_daemon", "btc_dominance_collector", "bybit_collector", "dashboard_server", "fear_greed_collector", "metrics_sampler"]);
  assert.ok(skipped.some((s) => s.name === "bot"));
});

test("getSafeChildrenSummary: knowledge_collector aparece quando as duas dependências estão presentes", () => {
  const { children } = getSafeChildrenSummary({ FRED_API_KEY: "fake", COINMARKETCAL_API_KEY: "fake" });
  assert.ok(children.some((c) => c.name === "knowledge_collector"));
});

test("getSafeChildrenSummary: usa process.env por padrão", () => {
  assert.doesNotThrow(() => getSafeChildrenSummary());
});

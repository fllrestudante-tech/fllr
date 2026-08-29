const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");

const CLI_PATH = path.join(__dirname, "..", "..", "lib", "autostart", "childrenSummaryCli.js");

test("childrenSummaryCli: imprime JSON válido com safe.children nunca contendo 'bot' e all listando 'bot' marcado trading", () => {
  const result = spawnSync(process.execPath, [CLI_PATH], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed.safe.children));
  assert.equal(parsed.safe.children.some((c) => c.name === "bot"), false);
  const bot = parsed.all.find((c) => c.name === "bot");
  assert.ok(bot);
  assert.equal(bot.category, "trading");
});

test("childrenSummaryCli: nenhum segredo/valor de env na saída -- só nomes/caminhos/categoria", () => {
  const result = spawnSync(process.execPath, [CLI_PATH], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, FRED_API_KEY: "segredo-fake-nao-deve-aparecer" },
  });
  assert.ok(!result.stdout.includes("segredo-fake-nao-deve-aparecer"));
});

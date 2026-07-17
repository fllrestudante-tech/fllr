const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRotatingWriter, dateKey } = require("../lib/logRotation");

function tmpDir() {
  const dir = path.join(os.tmpdir(), `bot-cripto10-test-logs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("dateKey: formata YYYY-MM-DD", () => {
  assert.equal(dateKey(new Date("2026-07-16T23:59:59.000Z")), "2026-07-16");
});

test("createRotatingWriter: escreve no arquivo do dia correspondente a now()", (t, done) => {
  const dir = tmpDir();
  const writer = createRotatingWriter("bot", { logsDir: dir, now: () => new Date("2026-07-16T10:00:00.000Z") });
  writer.write("linha 1\n");
  writer.write("linha 2\n");
  writer.close();
  setTimeout(() => {
    const content = fs.readFileSync(path.join(dir, "2026-07-16", "bot.log"), "utf8");
    assert.equal(content, "linha 1\nlinha 2\n");
    fs.rmSync(dir, { recursive: true, force: true });
    done();
  }, 30);
});

test("createRotatingWriter: troca de arquivo sozinho quando a data (now()) muda", (t, done) => {
  const dir = tmpDir();
  let current = new Date("2026-07-16T23:59:00.000Z");
  const writer = createRotatingWriter("bot", { logsDir: dir, now: () => current });
  writer.write("dia 16\n");
  current = new Date("2026-07-17T00:01:00.000Z");
  writer.write("dia 17\n");
  writer.close();
  setTimeout(() => {
    assert.equal(fs.readFileSync(path.join(dir, "2026-07-16", "bot.log"), "utf8"), "dia 16\n");
    assert.equal(fs.readFileSync(path.join(dir, "2026-07-17", "bot.log"), "utf8"), "dia 17\n");
    fs.rmSync(dir, { recursive: true, force: true });
    done();
  }, 30);
});

test("createRotatingWriter: componentes diferentes ficam em arquivos separados no mesmo dia", (t, done) => {
  const dir = tmpDir();
  const now = () => new Date("2026-07-16T10:00:00.000Z");
  const botWriter = createRotatingWriter("bot", { logsDir: dir, now });
  const collectorWriter = createRotatingWriter("bybit_collector", { logsDir: dir, now });
  botWriter.write("bot log\n");
  collectorWriter.write("collector log\n");
  botWriter.close();
  collectorWriter.close();
  setTimeout(() => {
    assert.equal(fs.readFileSync(path.join(dir, "2026-07-16", "bot.log"), "utf8"), "bot log\n");
    assert.equal(fs.readFileSync(path.join(dir, "2026-07-16", "bybit_collector.log"), "utf8"), "collector log\n");
    fs.rmSync(dir, { recursive: true, force: true });
    done();
  }, 30);
});

test("createRotatingWriter: currentPath reflete o arquivo em uso", (t, done) => {
  const dir = tmpDir();
  const writer = createRotatingWriter("bot", { logsDir: dir, now: () => new Date("2026-07-16T10:00:00.000Z") });
  assert.equal(writer.currentPath, null); // antes do primeiro write
  writer.write("x");
  assert.equal(writer.currentPath, path.join(dir, "2026-07-16", "bot.log"));
  writer.close();
  setTimeout(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    done();
  }, 30);
});

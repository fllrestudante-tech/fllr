const test = require("node:test");
const assert = require("node:assert/strict");
const { parseWmicCsv, sampleProcessResources } = require("../lib/processResourceUsage");

test("parseWmicCsv: parseia saída real do wmic (com \\r\\r\\n e linha em branco antes do header)", () => {
  const raw = "\r\r\nNode,IDProcess,PercentProcessorTime,WorkingSetPrivate\r\r\nFEFEZORD,36208,0,27041792\r\r\nFEFEZORD,35260,2,19148800\r\r\n";
  const result = parseWmicCsv(raw);
  assert.deepEqual(result[36208], { cpuPercent: 0, ramBytes: 27041792 });
  assert.deepEqual(result[35260], { cpuPercent: 2, ramBytes: 19148800 });
});

test("parseWmicCsv: saída vazia/só header retorna objeto vazio", () => {
  assert.deepEqual(parseWmicCsv(""), {});
  assert.deepEqual(parseWmicCsv("Node,IDProcess,PercentProcessorTime,WorkingSetPrivate\r\r\n"), {});
});

test("parseWmicCsv: header sem IDProcess retorna objeto vazio (formato inesperado)", () => {
  assert.deepEqual(parseWmicCsv("Node,Foo,Bar\r\r\nFEFEZORD,1,2\r\r\n"), {});
});

test("sampleProcessResources: lista de pids vazia não chama exec", () => {
  let called = false;
  const result = sampleProcessResources([], { exec: () => { called = true; return Buffer.from(""); } });
  assert.equal(called, false);
  assert.deepEqual(result, {});
});

test("sampleProcessResources: exec falhando (wmic ausente/erro) retorna objeto vazio, não derruba", () => {
  const result = sampleProcessResources([123], {
    exec: () => {
      throw new Error("wmic não encontrado");
    },
  });
  assert.deepEqual(result, {});
});

test("sampleProcessResources: com exec falso, parseia o CSV retornado", () => {
  const fakeCsv = "\r\r\nNode,IDProcess,PercentProcessorTime,WorkingSetPrivate\r\r\nFEFEZORD,123,5,1000000\r\r\n";
  const result = sampleProcessResources([123], { exec: () => Buffer.from(fakeCsv) });
  assert.deepEqual(result[123], { cpuPercent: 5, ramBytes: 1000000 });
});

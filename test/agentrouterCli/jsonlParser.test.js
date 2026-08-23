const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createJsonlParser, normalizeUsage, USAGE_FIELDS } = require("../../lib/agentrouterCli/jsonlParser");

function line(obj) {
  return JSON.stringify(obj) + "\n";
}

test("push+flush: uma linha válida por chamada, resultado completo", () => {
  const p = createJsonlParser();
  p.push(line({ type: "thread.started", thread_id: "t1" }));
  p.push(line({ type: "turn.started" }));
  p.push(line({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "OK" } }));
  p.push(line({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
  p.flush();

  const r = p.getResult();
  assert.equal(r.threadId, "t1");
  assert.equal(r.text, "OK");
  assert.deepEqual(r.usage, {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
  });
  assert.equal(r.complete, true);
  assert.equal(r.errorCount, 0);
  assert.equal(r.overflow, false);
});

test("múltiplas linhas no mesmo chunk (um único push)", () => {
  const p = createJsonlParser();
  const chunk =
    line({ type: "thread.started", thread_id: "t1" }) +
    line({ type: "item.completed", item: { type: "agent_message", text: "OK" } }) +
    line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  p.push(chunk);
  p.flush();

  const r = p.getResult();
  assert.equal(r.text, "OK");
  assert.equal(r.eventCount, 3);
});

test("linha fragmentada em vários chunks (JSON cortado no meio)", () => {
  const p = createJsonlParser();
  const full = line({ type: "item.completed", item: { type: "agent_message", text: "hello world" } });
  const cut = Math.floor(full.length / 2);
  p.push(full.slice(0, cut));
  p.push(full.slice(cut));
  p.push(line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
  p.flush();

  const r = p.getResult();
  assert.equal(r.text, "hello world");
  assert.equal(r.complete, true);
});

test("aceita JSONL com CRLF (\\r\\n)", () => {
  const p = createJsonlParser();
  const crlf =
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }) +
    "\r\n" +
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) +
    "\r\n";
  p.push(crlf);
  p.flush();

  const r = p.getResult();
  assert.equal(r.text, "OK");
  assert.equal(r.complete, true);
  assert.equal(r.errorCount, 0);
});

test("complete=false quando falta agent_message (só turn.completed)", () => {
  const p = createJsonlParser();
  p.push(line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
  p.flush();

  const r = p.getResult();
  assert.equal(r.text, null);
  assert.notEqual(r.usage, null);
  assert.equal(r.complete, false);
});

test("complete=false quando falta turn.completed (só agent_message)", () => {
  const p = createJsonlParser();
  p.push(line({ type: "item.completed", item: { type: "agent_message", text: "OK" } }));
  p.flush();

  const r = p.getResult();
  assert.equal(r.text, "OK");
  assert.equal(r.usage, null);
  assert.equal(r.complete, false);
});

test("múltiplas agent_message no stream -- usa a última, não a primeira", () => {
  const p = createJsonlParser();
  p.push(line({ type: "item.completed", item: { type: "agent_message", text: "first" } }));
  p.push(line({ type: "item.completed", item: { type: "agent_message", text: "second" } }));
  p.push(line({ type: "item.completed", item: { type: "agent_message", text: "final" } }));
  p.push(line({ type: "turn.completed", usage: {} }));
  p.flush();

  assert.equal(p.getResult().text, "final");
});

test("múltiplos turn.completed -- usa o último usage", () => {
  const p = createJsonlParser();
  p.push(line({ type: "item.completed", item: { type: "agent_message", text: "OK" } }));
  p.push(line({ type: "turn.completed", usage: { input_tokens: 1 } }));
  p.push(line({ type: "turn.completed", usage: { input_tokens: 99 } }));
  p.flush();

  assert.equal(p.getResult().usage.input_tokens, 99);
});

test("thread.started repetido -- mantém o PRIMEIRO thread_id, não o último", () => {
  const p = createJsonlParser();
  p.push(line({ type: "thread.started", thread_id: "first" }));
  p.push(line({ type: "thread.started", thread_id: "second" }));
  p.flush();

  assert.equal(p.getResult().threadId, "first");
});

test("linha não-JSON (ex: log de diagnóstico do Codex) é registrada como erro, não lança", () => {
  const p = createJsonlParser();
  assert.doesNotThrow(() => {
    p.push("2026-08-14T18:24:41Z ERROR codex_core::tools::router: alguma coisa\n");
  });
  p.push(line({ type: "item.completed", item: { type: "agent_message", text: "OK" } }));
  p.push(line({ type: "turn.completed", usage: {} }));
  p.flush();

  const r = p.getResult();
  assert.equal(r.text, "OK");
  assert.equal(r.errorCount, 1);
  assert.ok(r.errors.includes("AGENTROUTER_JSONL_INVALID"));
  // erro presente -> nunca "completo", mesmo com texto e usage válidos
  assert.equal(r.complete, false);
});

test("JSON válido mas sem campo `type` -- erro categorizado, não lança", () => {
  const p = createJsonlParser();
  p.push(line({ foo: "bar" }));
  p.flush();
  assert.equal(p.getResult().errorCount, 1);
});

test("linhas vazias são ignoradas silenciosamente (não contam como erro nem evento)", () => {
  const p = createJsonlParser();
  p.push("\n\n   \n");
  p.push(line({ type: "item.completed", item: { type: "agent_message", text: "OK" } }));
  p.flush();

  const r = p.getResult();
  assert.equal(r.errorCount, 0);
  assert.equal(r.eventCount, 1);
});

test("flush() processa a última linha mesmo sem \\n final", () => {
  const p = createJsonlParser();
  const withoutTrailingNewline = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } });
  p.push(withoutTrailingNewline);
  assert.equal(p.getResult().text, null); // ainda não processada -- sem \n, ficou no buffer
  p.flush();
  assert.equal(p.getResult().text, "OK");
});

test("evento desconhecido: contabilizado por type, nunca guarda o objeto inteiro", () => {
  const p = createJsonlParser();
  p.push(line({ type: "command_execution", command: "rm -rf /", secret: "não deveria aparecer em lugar nenhum" }));
  p.flush();

  const r = p.getResult();
  assert.equal(r.eventTypeCounts["command_execution"], 1);
  assert.equal(JSON.stringify(r).includes("rm -rf"), false);
  assert.equal(JSON.stringify(r).includes("secret"), false);
});

test("__proto__ como type não polui o protótipo de eventTypeCounts", () => {
  const p = createJsonlParser();
  p.push(line({ type: "__proto__" }));
  p.push(line({ type: "constructor" }));
  p.flush();

  const r = p.getResult();
  assert.equal(Object.getPrototypeOf({}).polluted, undefined);
  assert.equal(r.eventTypeCounts["__proto__"], 1);
  assert.equal(r.eventTypeCounts["constructor"], 1);
});

test("maxTrackedTypes: além do teto, conta em untrackedTypeCount em vez de nova chave", () => {
  const p = createJsonlParser({ maxTrackedTypes: 2 });
  p.push(line({ type: "type_a" }));
  p.push(line({ type: "type_b" }));
  p.push(line({ type: "type_c" }));
  p.push(line({ type: "type_d" }));
  p.flush();

  const r = p.getResult();
  assert.equal(Object.keys(r.eventTypeCounts).length, 2);
  assert.equal(r.untrackedTypeCount, 2);
});

test("maxEventTypeLength: type gigante é rejeitado como AGENTROUTER_JSONL_INVALID_TYPE, não vira chave", () => {
  const p = createJsonlParser({ maxEventTypeLength: 8 });
  p.push(line({ type: "um_type_muito_mais_longo_que_oito_chars" }));
  p.flush();

  const r = p.getResult();
  assert.equal(Object.keys(r.eventTypeCounts).length, 0);
  assert.ok(r.errors.includes("AGENTROUTER_JSONL_INVALID_TYPE"));
});

test("maxEvents: evento após o teto vira overflow; linha vazia extra depois do teto NÃO derruba sozinha", () => {
  const p = createJsonlParser({ maxEvents: 1 });
  p.push(line({ type: "thread.started", thread_id: "t1" }));
  // exatamente 1 evento processado (o teto) -- linha vazia depois não deve,
  // por si só, ser o que aciona overflow (bug corrigido: ordem de checagem).
  p.push("\n");
  assert.equal(p.getResult().overflow, false);
  p.push(line({ type: "item.completed", item: { type: "agent_message", text: "não deveria entrar" } }));
  p.flush();

  const r = p.getResult();
  assert.equal(r.overflow, true);
  assert.equal(r.text, null);
});

test("maxBufferLength: chunk grande com muitas linhas pequenas VÁLIDAS não é rejeitado", () => {
  const p = createJsonlParser({ maxBufferLength: 100 });
  let bigChunk = "";
  for (let i = 0; i < 50; i++) {
    bigChunk += line({ type: "heartbeat", n: i });
  }
  // bigChunk tem bem mais de 100 bytes no total, mas cada linha é pequena e
  // completa -- não deve estourar o limite, que só vale pro resto sem \n.
  p.push(bigChunk);
  const r = p.getResult();
  assert.equal(r.overflow, false);
  assert.equal(r.eventTypeCounts["heartbeat"], 50);
});

test("maxBufferLength: linha incompleta (sem \\n) que excede o limite gera overflow", () => {
  const p = createJsonlParser({ maxBufferLength: 10 });
  p.push('{"type":"agent_message_that_never_ends_without_newline"');
  const r = p.getResult();
  assert.equal(r.overflow, true);
  assert.ok(r.errors.includes("AGENTROUTER_JSONL_BUFFER_LIMIT"));
});

test("maxErrors: muitas linhas inválidas em sequência acionam overflow e param de processar", () => {
  const p = createJsonlParser({ maxErrors: 3 });
  p.push("linha invalida 1\n");
  p.push("linha invalida 2\n");
  p.push("linha invalida 3\n");
  assert.equal(p.getResult().overflow, true);
  // depois do overflow, eventos válidos não são mais processados
  p.push(line({ type: "item.completed", item: { type: "agent_message", text: "tarde demais" } }));
  p.flush();
  assert.equal(p.getResult().text, null);
});

test("push: rejeita tipo que não é string nem Buffer", () => {
  const p = createJsonlParser();
  assert.throws(() => p.push(123), TypeError);
  assert.throws(() => p.push(null), TypeError);
  assert.throws(() => p.push({}), TypeError);
});

test("push: mistura de Buffer e string na mesma instância lança TypeError", () => {
  const p = createJsonlParser();
  p.push(Buffer.from(line({ type: "thread.started", thread_id: "t1" })));
  assert.throws(() => p.push(line({ type: "turn.started" })), TypeError);
});

test("push: aceita Buffer isoladamente, incluindo caractere UTF-8 multibyte cortado deterministicamente entre chunks", () => {
  const p = createJsonlParser();
  const full = Buffer.from(line({ type: "item.completed", item: { type: "agent_message", text: "café ☕ prêço" } }), "utf8");

  const coffeeBytes = Buffer.from("☕", "utf8");
  const coffeeStart = full.indexOf(coffeeBytes);
  assert.notEqual(coffeeStart, -1);

  // corta no meio literal dos bytes do emoji, não numa fronteira qualquer
  const cut = coffeeStart + 1;
  p.push(full.subarray(0, cut));
  p.push(full.subarray(cut));
  p.push(Buffer.from(line({ type: "turn.completed", usage: {} })));
  p.flush();

  assert.equal(p.getResult().text, "café ☕ prêço");
});

test("normalizeUsage: campos ausentes viram 0, nunca null/NaN", () => {
  const u = normalizeUsage({});
  for (const field of USAGE_FIELDS) assert.equal(u[field], 0);
});

test("normalizeUsage: valores negativos, string ou não-finitos viram 0", () => {
  const u = normalizeUsage({
    input_tokens: -5,
    cached_input_tokens: "10",
    cache_write_input_tokens: NaN,
    output_tokens: Infinity,
    reasoning_output_tokens: null,
  });
  assert.deepEqual(u, {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  });
});

test("normalizeUsage: número válido é truncado para inteiro", () => {
  const u = normalizeUsage({ input_tokens: 12.9 });
  assert.equal(u.input_tokens, 12);
});

test("getResult sem nenhum push: tudo neutro, complete=false", () => {
  const p = createJsonlParser();
  const r = p.getResult();
  assert.equal(r.threadId, null);
  assert.equal(r.text, null);
  assert.equal(r.usage, null);
  assert.equal(r.complete, false);
  assert.equal(r.eventCount, 0);
});

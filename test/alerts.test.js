const test = require("node:test");
const assert = require("node:assert/strict");
const logger = require("../lib/logger");
const {
  sendTelegramAlert,
  alertOnTransitions,
  sanitizeAlertText,
  buildStructuredAlertText,
  UnrecognizedAlertFieldError,
  __resetAlertsRuntimeStateForTests,
  __getAlertsRuntimeStateSizeForTests,
} = require("../lib/alerts");

function resetAndMuteLogAlert(t) {
  __resetAlertsRuntimeStateForTests();
  t.mock.method(logger, "logAlert", () => {});
}

test("sendTelegramAlert: sem token/chatId, não envia e não lança erro", async (t) => {
  resetAndMuteLogAlert(t);
  const result = await sendTelegramAlert("teste", { botToken: "", chatId: "", post: async () => assert.fail("não deveria chamar post") });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "not_configured");
});

test("sendTelegramAlert: com token/chatId, chama o post injetado com a URL e payload corretos", async (t) => {
  resetAndMuteLogAlert(t);
  const calls = [];
  const result = await sendTelegramAlert("🔴 [bybit] ok → down", {
    botToken: "TOKEN123",
    chatId: "999",
    post: async (url, body) => calls.push({ url, body }),
  });
  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/botTOKEN123/sendMessage");
  assert.deepEqual(calls[0].body, { chat_id: "999", text: "🔴 [bybit] ok → down" });
});

test("alertOnTransitions: dispara um alerta por transição, na ordem recebida", async () => {
  const sent = [];
  await alertOnTransitions(
    [
      { name: "bybit", from: "ok", to: "down" },
      { name: "telegram_radar", from: "down", to: "ok" },
    ],
    async (text) => sent.push(text)
  );
  assert.equal(sent.length, 2);
  assert.match(sent[0], /bybit.*ok → down/);
  assert.match(sent[1], /telegram_radar.*down → ok/);
});

test("alertOnTransitions: lista vazia não dispara nada", async () => {
  let called = false;
  await alertOnTransitions([], async () => {
    called = true;
  });
  assert.equal(called, false);
});

// =====================================================================
// sanitizeAlertText -- controle de caracteres, redação de segredo, limite
// de tamanho. Testado isoladamente (função pura, sem rede/estado).
// =====================================================================

test("sanitizeAlertText: remove caracteres de controle C0/C1, preserva \\n e \\t", () => {
  const withControl = "linha1\nlinha2\ttab\x00\x01\x07\x1Bfim\x9C";
  const out = sanitizeAlertText(withControl);
  assert.equal(out, "linha1\nlinha2\ttabfim");
});

test("sanitizeAlertText: redige bot token do Telegram embutido numa URL", () => {
  const out = sanitizeAlertText("erro ao chamar https://api.telegram.org/bot123456789:AAFakeTokenNotRealAbcdefGhi/sendMessage");
  assert.ok(!out.includes("AAFakeTokenNotRealAbcdefGhi"));
  assert.ok(out.includes("bot[REDACTED]"));
});

test("sanitizeAlertText: redige header Authorization colado cru", () => {
  const out = sanitizeAlertText("falha: Authorization: Bearer sk-fake-not-a-real-secret-123456");
  assert.ok(!out.includes("sk-fake-not-a-real-secret-123456"));
  assert.ok(out.includes("Authorization: [REDACTED]"));
});

for (const label of ["api_key", "access_token", "secret", "signature", "password", "senha", "token"]) {
  test(`sanitizeAlertText: redige padrão chave=valor pra "${label}"`, () => {
    const out = sanitizeAlertText(`config: ${label}=abcDEF123456xyz`);
    assert.ok(!out.includes("abcDEF123456xyz"), `valor não deveria sobreviver pra ${label}`);
    assert.ok(out.includes("[REDACTED]"));
  });
}

test("sanitizeAlertText: redige token/key/secret como parâmetro de query string", () => {
  const out = sanitizeAlertText("GET https://example.com/x?foo=1&token=abcdef123456&bar=2");
  assert.ok(!out.includes("abcdef123456"));
  assert.ok(out.includes("token=[REDACTED]"));
  assert.ok(out.includes("foo=1")); // não redige parâmetros que não são segredo
});

test("sanitizeAlertText: trunca mensagens muito longas com marcador, nunca ultrapassa o limite", () => {
  const huge = "x".repeat(10_000);
  const out = sanitizeAlertText(huge);
  assert.ok(out.length <= 3500);
  assert.ok(out.endsWith("[truncado]"));
});

test("sanitizeAlertText: mensagem curta e limpa passa inalterada", () => {
  assert.equal(sanitizeAlertText("🔴 [bybit] ok → down"), "🔴 [bybit] ok → down");
});

// =====================================================================
// buildStructuredAlertText -- allowlist fechada de campos.
// =====================================================================

test("buildStructuredAlertText: campo fora da allowlist lança UnrecognizedAlertFieldError", () => {
  assert.throws(() => buildStructuredAlertText({ severity: "HIGH", freeText: "não permitido" }), UnrecognizedAlertFieldError);
});

test("buildStructuredAlertText: monta texto a partir só dos campos permitidos", () => {
  const text = buildStructuredAlertText({ emoji: "🔴", severity: "HIGH", source: "bybit", message: "conectividade perdida", count: 3, windowMinutes: 15 });
  assert.match(text, /🔴/);
  assert.match(text, /\[HIGH\]/);
  assert.match(text, /\[bybit\]/);
  assert.match(text, /conectividade perdida/);
  assert.match(text, /3 vez\(es\) nos últimos 15min/);
});

test("buildStructuredAlertText: só message -> texto simples, sem lançar mesmo com campos ausentes", () => {
  assert.equal(buildStructuredAlertText({ message: "olá" }), "olá");
});

// =====================================================================
// Deduplicação (fingerprint + janela) -- estado de processo, isolado via
// __resetAlertsRuntimeStateForTests + `now` injetado.
// =====================================================================

test("sendTelegramAlert: mesma mensagem 2x dentro da janela de dedup -> segunda vira 'deduplicated', ZERO post na segunda", async (t) => {
  resetAndMuteLogAlert(t);
  let postCalls = 0;
  const opts = { botToken: "T", chatId: "1", post: async () => { postCalls++; }, now: () => 1_000_000 };

  const first = await sendTelegramAlert("mesma mensagem", opts);
  const second = await sendTelegramAlert("mesma mensagem", opts);

  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(second.reason, "deduplicated");
  assert.equal(postCalls, 1);
});

test("sendTelegramAlert: mesma mensagem, mas FORA da janela de dedup -> envia de novo normalmente", async (t) => {
  resetAndMuteLogAlert(t);
  let postCalls = 0;
  let nowMs = 1_000_000;
  const opts = { botToken: "T", chatId: "1", post: async () => { postCalls++; }, now: () => nowMs, dedupWindowMs: 1000 };

  const first = await sendTelegramAlert("mesma mensagem", opts);
  nowMs += 2000; // além da janela de 1000ms
  const second = await sendTelegramAlert("mesma mensagem", opts);

  assert.equal(first.sent, true);
  assert.equal(second.sent, true);
  assert.equal(postCalls, 2);
});

test("sendTelegramAlert: mensagens DIFERENTES nunca colidem no dedup", async (t) => {
  resetAndMuteLogAlert(t);
  let postCalls = 0;
  const opts = { botToken: "T", chatId: "1", post: async () => { postCalls++; }, now: () => 1_000_000 };
  const a = await sendTelegramAlert("mensagem A", opts);
  const b = await sendTelegramAlert("mensagem B", opts);
  assert.equal(a.sent, true);
  assert.equal(b.sent, true);
  assert.equal(postCalls, 2);
});

// =====================================================================
// Rate limit -- janela global, conservador.
// =====================================================================

test("sendTelegramAlert: rate limit conservador -- ao exceder rateLimitMaxPerWindow, próximas tentativas viram 'rate_limited', ZERO post extra", async (t) => {
  resetAndMuteLogAlert(t);
  let postCalls = 0;
  const opts = { botToken: "T", chatId: "1", post: async () => { postCalls++; }, now: () => 1_000_000, rateLimitMaxPerWindow: 2, dedupWindowMs: 0 };

  const r1 = await sendTelegramAlert("msg 1", opts);
  const r2 = await sendTelegramAlert("msg 2", opts);
  const r3 = await sendTelegramAlert("msg 3", opts);

  assert.equal(r1.sent, true);
  assert.equal(r2.sent, true);
  assert.equal(r3.sent, false);
  assert.equal(r3.reason, "rate_limited");
  assert.equal(postCalls, 2);
});

test("sendTelegramAlert: rate limit é uma janela DESLIZANTE -- tentativas antigas expiram e liberam espaço", async (t) => {
  resetAndMuteLogAlert(t);
  let nowMs = 1_000_000;
  const opts = { botToken: "T", chatId: "1", post: async () => {}, now: () => nowMs, rateLimitMaxPerWindow: 1, rateLimitWindowMs: 1000, dedupWindowMs: 0 };

  const r1 = await sendTelegramAlert("msg 1", opts);
  const r2 = await sendTelegramAlert("msg 2", opts); // ainda dentro da janela -> limitado
  nowMs += 2000; // janela expira
  const r3 = await sendTelegramAlert("msg 3", opts);

  assert.equal(r1.sent, true);
  assert.equal(r2.sent, false);
  assert.equal(r2.reason, "rate_limited");
  assert.equal(r3.sent, true);
});

// =====================================================================
// Fila limitada -- descarte controlado sob excesso de envios EM VOO
// simultâneos (post lento, várias chamadas concorrentes antes da primeira
// terminar).
// =====================================================================

test("sendTelegramAlert: fila cheia (maxQueueSize excedido por envios concorrentes) -> descarte controlado, 'queue_full', nunca cresce sem limite", async (t) => {
  resetAndMuteLogAlert(t);
  let resolvePost;
  const postGate = new Promise((resolve) => { resolvePost = resolve; });
  let postCalls = 0;
  const opts = {
    botToken: "T",
    chatId: "1",
    post: async () => { postCalls++; await postGate; },
    now: () => Date.now(),
    dedupWindowMs: 0,
    rateLimitMaxPerWindow: 100,
    maxQueueSize: 2,
  };

  // 2 envios concorrentes ficam presos EM VOO (post não resolve ainda).
  const p1 = sendTelegramAlert("msg A", opts);
  const p2 = sendTelegramAlert("msg B", opts);
  // 3º chega com a fila cheia -> descartado sem nem tentar rede.
  const r3 = await sendTelegramAlert("msg C", opts);

  assert.equal(r3.sent, false);
  assert.equal(r3.reason, "queue_full");

  resolvePost();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.sent, true);
  assert.equal(r2.sent, true);
  assert.equal(postCalls, 2); // o 3º nunca chegou a chamar post
});

// =====================================================================
// Timeout finito -- repassado ao transporte injetado.
// =====================================================================

test("sendTelegramAlert: timeout finito é repassado ao post (padrão e customizado)", async (t) => {
  resetAndMuteLogAlert(t);
  const configs = [];
  await sendTelegramAlert("msg", { botToken: "T", chatId: "1", post: async (url, body, cfg) => configs.push(cfg) });
  await sendTelegramAlert("outra msg", { botToken: "T", chatId: "1", post: async (url, body, cfg) => configs.push(cfg), timeoutMs: 3000 });

  assert.equal(typeof configs[0].timeout, "number");
  assert.ok(configs[0].timeout > 0);
  assert.equal(configs[1].timeout, 3000);
});

// =====================================================================
// Erro Axios sanitizado -- nunca vaza err.message/URL-com-token; falha do
// Telegram nunca lança (fail-open).
// =====================================================================

test("sendTelegramAlert: post rejeita com erro contendo token na URL/mensagem -> nunca lança, retorno não carrega o texto bruto do erro", async (t) => {
  resetAndMuteLogAlert(t);
  const err = new Error("connect ECONNREFUSED -- url completa: https://api.telegram.org/bot123456789:AAFakeSecretToken/sendMessage");
  err.code = "ECONNREFUSED";
  const result = await sendTelegramAlert("msg", { botToken: "T", chatId: "1", post: async () => { throw err; } });

  assert.equal(result.sent, false);
  assert.equal(result.reason, "send_failed");
  assert.equal(result.errorCode, "ECONNREFUSED");
  assert.ok(!JSON.stringify(result).includes("AAFakeSecretToken"));
});

test("sendTelegramAlert: erro axios com response.status (sem .code) -> errorCode='http_<status>', nunca lança", async (t) => {
  resetAndMuteLogAlert(t);
  const err = new Error("Request failed with status code 429 -- corpo completo com dado sensível anexado");
  err.response = { status: 429, data: { secret_leak: "não deveria aparecer" } };
  const result = await sendTelegramAlert("msg", { botToken: "T", chatId: "1", post: async () => { throw err; } });

  assert.equal(result.sent, false);
  assert.equal(result.errorCode, "http_429");
  assert.ok(!JSON.stringify(result).includes("secret_leak"));
  assert.ok(!JSON.stringify(result).includes("dado sensível"));
});

test("sendTelegramAlert: post lança um valor não-Error (ex: string) -> ainda assim nunca escapa, resolve com sent:false", async (t) => {
  resetAndMuteLogAlert(t);
  const result = await sendTelegramAlert("msg", { botToken: "T", chatId: "1", post: async () => { throw "falha crua"; } });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "send_failed");
});

// =====================================================================
// Métricas locais sanitizadas -- persistidas via logger.logAlert, nunca
// carregam o texto do alerta nem detalhe bruto de erro.
// =====================================================================

test("sendTelegramAlert: cada desfecho (sent/deduplicated/rate_limited/queue_full/failed) grava UMA métrica sanitizada via logger.logAlert", async (t) => {
  __resetAlertsRuntimeStateForTests();
  const recorded = [];
  t.mock.method(logger, "logAlert", (event) => recorded.push(event));

  await sendTelegramAlert("msg única A", { botToken: "T", chatId: "1", post: async () => {}, now: () => 1 });
  await sendTelegramAlert("msg única A", { botToken: "T", chatId: "1", post: async () => {}, now: () => 1 }); // dedup
  const err = new Error("falha simulada com secret=abcdef123456");
  await sendTelegramAlert("msg única B", { botToken: "T", chatId: "1", post: async () => { throw err; }, now: () => 1 });

  const outcomes = recorded.map((r) => r.outcome);
  assert.deepEqual(outcomes, ["sent", "deduplicated", "failed"]);
  for (const r of recorded) {
    assert.equal(r.event, "telegram_alert_outcome");
    assert.equal(typeof r.fingerprint, "string");
    assert.equal(typeof r.length, "number");
    // nunca carrega o texto do alerta em si nem o erro bruto
    assert.ok(!("text" in r));
    assert.ok(!("message" in r));
    assert.ok(!JSON.stringify(r).includes("secret=abcdef123456"));
  }
});

test("sendTelegramAlert: falha ao GRAVAR a métrica (logger.logAlert lança) nunca impede o retorno do alerta -- fail-open também na trilha de métricas", async (t) => {
  __resetAlertsRuntimeStateForTests();
  t.mock.method(logger, "logAlert", () => { throw new Error("disco cheio, simulado"); });
  const result = await sendTelegramAlert("msg", { botToken: "T", chatId: "1", post: async () => {}, now: () => 1 });
  assert.equal(result.sent, true);
});

// =====================================================================
// Re-verificação (round de auditoria do coordenador) -- crescimento sem
// limite de fila/rate-limit/dedup, e sanitização não-excessiva sobre texto
// operacional legítimo (preço/símbolo/números normais).
// =====================================================================

test("sendTelegramAlert: 200 mensagens DISTINTAS ao longo de uma janela longa -- Map de dedup NUNCA cresce sem limite (poda entradas fora da janela a cada chamada)", async (t) => {
  resetAndMuteLogAlert(t);
  let nowMs = 0;
  const opts = { botToken: "T", chatId: "1", post: async () => {}, now: () => nowMs, dedupWindowMs: 1000, rateLimitMaxPerWindow: 100000 };

  for (let i = 0; i < 200; i++) {
    await sendTelegramAlert(`mensagem distinta número ${i}`, opts);
    nowMs += 100; // avança o relógio -- a cada 10 mensagens já passou 1 janela de dedup inteira
  }

  const sizes = __getAlertsRuntimeStateSizeForTests();
  // Nunca deveria acumular as 200 -- só as que ainda estão dentro da janela
  // de 1000ms (no máximo ~10, dado o passo de 100ms por mensagem).
  assert.ok(sizes.dedupMapSize <= 15, `dedupMapSize=${sizes.dedupMapSize} deveria ficar limitado à janela, não crescer com o total de mensagens já vistas`);
});

test("sendTelegramAlert: rate limit array nunca cresce além do necessário pra janela -- mesmo após muitas tentativas ao longo do tempo", async (t) => {
  resetAndMuteLogAlert(t);
  let nowMs = 0;
  const opts = { botToken: "T", chatId: "1", post: async () => {}, now: () => nowMs, dedupWindowMs: 0, rateLimitMaxPerWindow: 5, rateLimitWindowMs: 1000 };

  for (let i = 0; i < 100; i++) {
    await sendTelegramAlert(`msg ${i}`, opts);
    nowMs += 50;
  }

  const sizes = __getAlertsRuntimeStateSizeForTests();
  assert.ok(sizes.rateLimitQueueLength <= 5, `rateLimitQueueLength=${sizes.rateLimitQueueLength} nunca deveria exceder rateLimitMaxPerWindow`);
});

test("sendTelegramAlert: 50 envios concorrentes com maxQueueSize baixo -- inFlightCount nunca excede o limite, mesmo sob rajada", async (t) => {
  resetAndMuteLogAlert(t);
  let resolveAll;
  const gate = new Promise((resolve) => { resolveAll = resolve; });
  let maxObservedInFlight = 0;
  const opts = {
    botToken: "T",
    chatId: "1",
    post: async () => {
      const s = __getAlertsRuntimeStateSizeForTests();
      if (s.inFlightCount > maxObservedInFlight) maxObservedInFlight = s.inFlightCount;
      await gate;
    },
    now: () => Date.now(),
    dedupWindowMs: 0,
    rateLimitMaxPerWindow: 1000,
    maxQueueSize: 3,
  };

  const promises = [];
  for (let i = 0; i < 50; i++) promises.push(sendTelegramAlert(`rajada ${i}`, opts));
  resolveAll();
  const results = await Promise.all(promises);

  assert.ok(maxObservedInFlight <= 3, `inFlightCount chegou a ${maxObservedInFlight}, deveria nunca exceder maxQueueSize=3`);
  const dropped = results.filter((r) => r.reason === "queue_full").length;
  assert.ok(dropped > 0, "com 50 envios concorrentes e maxQueueSize=3, esperava pelo menos um descarte controlado");
  const sent = results.filter((r) => r.sent).length;
  assert.ok(sent > 0, "pelo menos alguns deveriam ter sido enviados com sucesso");
});

test("sanitizeAlertText: preços, símbolos e texto operacional normal NUNCA são redigidos ou truncados agressivamente -- só o que é realmente sensível", () => {
  const casos = [
    "🟢 Sinal de BUY. qty=10.5 stop=39.20 TP escalonado=50%@1R + 50%@2R",
    "🔴 [bybit] ok → down",
    "Conexão perdida às 14:23 (causa: Bybit). Restabelecida às 15:07. Tempo offline: 44min.",
    "⚠️ [HIGH] conectividade perdida -- 3 vezes nos últimos 15min",
    "Posição SOLUSDT fechada: entryPrice=148.32 exitPrice=151.90 pnlUsd=12.45 pnlPct=2.4%",
    "orderLinkId=c10-1735689600000-a1b2c3 side=Buy qty=2.0",
    "equity=1000.00 leverage=2 tradeMode=isolated",
  ];
  for (const texto of casos) {
    assert.equal(sanitizeAlertText(texto), texto, `mensagem operacional legítima não deveria ser alterada: "${texto}"`);
  }
});

test("sanitizeAlertText: palavras como 'signature'/'key'/'token' em contexto NÃO chave=valor (frase normal) não disparam redação", () => {
  const casos = [
    "assinatura da ordem validada com sucesso", // "signature" em PT não bate o padrão em inglês de qualquer forma
    "token de reconexão obtido", // sem '=' ou ':' seguido de valor -- não deveria casar
  ];
  for (const texto of casos) {
    assert.equal(sanitizeAlertText(texto), texto, `frase normal não deveria ser redigida: "${texto}"`);
  }
});

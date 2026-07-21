const test = require("node:test");
const assert = require("node:assert/strict");
const { extractMessageType } = require("../../lib/narrativeEngine/extractMessageType");

test("extractMessageType: ANALYSIS quando há ticker e nenhum marcador mais específico", () => {
  assert.equal(extractMessageType("LDO segue esticando, força compradora", { ticker: "LDO" }), "ANALYSIS");
});

test("extractMessageType: UPDATE quando a mensagem se autodenomina atualização", () => {
  assert.equal(extractMessageType("BTCUSDT.P | Atualização 🔥 mantém topos ascendentes", { ticker: "BTC" }), "UPDATE");
});

test("extractMessageType: WARNING por emoji/termo de alerta", () => {
  assert.equal(extractMessageType("⚠️ Reforçando que este ativo tem tendência baixista", { ticker: null }), "WARNING");
});

test("extractMessageType: MACRO quando cita contexto macro sem ticker", () => {
  assert.equal(extractMessageType("Nasdaq devolveu quase toda alta do dia", { ticker: null }), "MACRO");
});

test("extractMessageType: NEWS quando tem link e nenhum ticker/macro", () => {
  assert.equal(extractMessageType("Vai abalar o mercado, olha esse vídeo https://youtu.be/xyz", { ticker: null }), "WARNING");
  // 'vai abalar' já é WARNING -- teste de NEWS puro abaixo, sem gatilho de warning
  assert.equal(extractMessageType("Saiu um vídeo novo no canal https://youtu.be/xyz", { ticker: null }), "NEWS");
});

test("extractMessageType: CHAT como fallback (conversa administrativa, sem ticker/macro/link)", () => {
  assert.equal(extractMessageType("Próximos passos - fazer o kyc2 quem ainda não fez", { ticker: null }), "CHAT");
});

test("extractMessageType: CHAT pra mensagem vazia ou só emoji", () => {
  assert.equal(extractMessageType("", { ticker: null }), "CHAT");
  assert.equal(extractMessageType("🚀", { ticker: null }), "CHAT");
});

test("extractMessageType: ENTRY exige ticker presente", () => {
  assert.equal(extractMessageType("Fizemos a entrada agora", { ticker: "BTC" }), "ENTRY");
  assert.equal(extractMessageType("Fizemos a entrada agora", { ticker: null }), "CHAT");
});

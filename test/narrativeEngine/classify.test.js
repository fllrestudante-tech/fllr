const test = require("node:test");
const assert = require("node:assert/strict");
const { classify, CLASSIFIER_NAME, CLASSIFIER_VERSION } = require("../../lib/narrativeEngine/classify");

test("classify: exemplo completo (sintético) -- gera ticker/pair/direction/timeframe/signalType/features/confidenceBreakdown coerentes", () => {
  const signal = classify(
    "UNIUSDT rompendo a resistência, cunha ascendente confirmada no 4H, força compradora entrando, volume subindo"
  );

  assert.equal(signal.classifierName, CLASSIFIER_NAME);
  assert.equal(signal.classifierVersion, CLASSIFIER_VERSION);
  assert.equal(signal.ticker, "UNI");
  assert.equal(signal.pair, "UNIUSDT");
  assert.equal(signal.direction, "LONG");
  assert.equal(signal.timeframe, "4H");
  assert.equal(signal.signalType, "Ascending Wedge");
  assert.equal(signal.messageType, "ANALYSIS");
  assert.equal(signal.sentiment, "bullish");
  assert.equal(signal.isCall, true);
  assert.equal(signal.isRelevant, true);
  assert.ok(signal.features.hasTicker);
  assert.ok(signal.features.hasResistance);
  assert.ok(signal.confidenceBreakdown.ticker > 0);
  assert.ok(signal.confidence > 0 && signal.confidence <= 1);
});

test("classify: mensagem administrativa (kyc/próximos passos) -- CHAT, não relevante, sem ticker", () => {
  const signal = classify("Próximos passos - fazer o kyc2 quem ainda não fez (o meu já tinha feito antes)");
  assert.equal(signal.messageType, "CHAT");
  assert.equal(signal.isRelevant, false);
  assert.equal(signal.isCall, false);
  assert.equal(signal.ticker, null);
});

test("classify: detecta link no texto e reflete em features.hasLink (achado real: campo ficava sempre false)", () => {
  const signal = classify("Vai abalar o mercado, veja https://cointelegraph.com/news/exemplo");
  assert.equal(signal.features.hasLink, true);
});

test("classify: mensagem vazia não quebra e retorna tudo neutro/CHAT", () => {
  const signal = classify("");
  assert.equal(signal.messageType, "CHAT");
  assert.equal(signal.ticker, null);
  assert.equal(signal.confidence, 0);
  assert.equal(signal.isCall, false);
});

// Fixtures reais -- 15 últimas mensagens do canal "Velatrader Squad Oficial"
// puxadas ao vivo durante a auditoria desta sessão (histórico público do
// canal, sem dado sensível). Servem de regressão: garantem que o
// classificador não quebra e produz classificações plausíveis contra
// linguagem real dos analistas, não só contra exemplos sintéticos —
// exatamente o gap que o extractSignals antigo tinha e não foi pego a
// tempo. Textos truncados em ~150 caracteres (limite usado na auditoria
// pontual), preservados como estavam.
const REAL_VELATRADER_FIXTURES = [
  "UNIUSDT — Estrutura parecida com LDO, porém considero a UNI um pouco mais forte nesse momento. Vale colocar no radar e ativar o 4H em SV para buscar o",
  "Próximos passos   - fazer o kyc2 quem ainda não fez (o meu já tinha feito antes) - aguardar 11 de agosto para migrarmos",
  "Nasdaq devolveu quase toda alta do dia e touros conservadores seguem esperando pacientemente, cripto já dando sinais de força pois mesmo com esse cená",
  "LDO segue esticando, quanto mais subir, melhor será a oportunidade quando vier a correção 🚀🚀",
  "BTCUSDT.P | Atualização 🔥  O BTC mantém topos e fundos ascendentes no 4H, trabalhando dentro de uma cunha ascendente e testando a resistência princip",
  "Fiquem preparados com esses acontecimentos !!!! Vai abalar o mercado   https://youtu.be/v_SgckVM8Eg",
  "Bom dia Criptotraders! Seguindo mesmo cenário de ontem, Nasdaq tentando se segurar tendo breve repique no momento, touros agressivos operam apartir de",
  "Boa noite Criptotraders! Observem por Nasdaq amanhã, está muito perto de iniciar uma correção no mensal e caso isso ocorra de fato, melhor esperar e v",
  "@todos Acabei de fazer um video atualizando sobre o meu short em petroleo que deve acontecer em um futuro próximo! Tambem comento sobre as minhas posi",
  "⚠️ Reforçando que estamos falando de um ativo que está com tendência baixista no mensal/semanal e esse trade seria uma aposta na reversão da tendência",
  "LDO – Coloquem a LDO no radar. A moeda vem demonstrando força compradora e já abriu um bom espaço de valorização, aumentando a probabilidade de formar",
  "Estou todos os dias acompanhando e caçando o próximo trade pra gente 🫱🏻‍🫲🏼🫱🏻‍🫲🏼🫱🏻‍🫲🏼",
  "🚀",
];

test("classify: histórico real do Velatrader Squad Oficial não quebra o pipeline em nenhuma mensagem", () => {
  for (const text of REAL_VELATRADER_FIXTURES) {
    assert.doesNotThrow(() => classify(text), `classify() não deveria lançar erro pra: "${text}"`);
  }
});

test("classify: histórico real -- casos específicos calibrados manualmente", () => {
  const uniStructure = classify(REAL_VELATRADER_FIXTURES[0]);
  assert.equal(uniStructure.ticker, "UNI");
  assert.equal(uniStructure.pair, "UNIUSDT");

  const kyc = classify(REAL_VELATRADER_FIXTURES[1]);
  assert.equal(kyc.messageType, "CHAT");
  assert.equal(kyc.isRelevant, false);

  const nasdaqMacro = classify(REAL_VELATRADER_FIXTURES[2]);
  assert.equal(nasdaqMacro.messageType, "MACRO");
  assert.equal(nasdaqMacro.ticker, null);

  const ldoEsticando = classify(REAL_VELATRADER_FIXTURES[3]);
  assert.equal(ldoEsticando.ticker, "LDO");
  assert.equal(ldoEsticando.sentiment, "bullish");

  const btcUpdate = classify(REAL_VELATRADER_FIXTURES[4]);
  assert.equal(btcUpdate.ticker, "BTC");
  assert.equal(btcUpdate.pair, "BTCUSDT.P");
  assert.equal(btcUpdate.messageType, "UPDATE");
  assert.equal(btcUpdate.timeframe, "4H");
  assert.equal(btcUpdate.features.hasHigherHighsLows, true);
  assert.equal(btcUpdate.features.hasAscendingWedge, true);

  const warning = classify(REAL_VELATRADER_FIXTURES[5]);
  assert.equal(warning.messageType, "WARNING");

  const boaNoiteMensal = classify(REAL_VELATRADER_FIXTURES[7]);
  assert.equal(boaNoiteMensal.timeframe, "1M");

  const emojiOnly = classify(REAL_VELATRADER_FIXTURES[12]);
  assert.equal(emojiOnly.messageType, "CHAT");
  assert.equal(emojiOnly.isRelevant, false);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAgentRouterAssessmentMeta } = require("../../lib/aiGateway/agentRouterAssessmentMeta");

// Array "envenenado" -- qualquer acesso de propriedade (length, iteração)
// lança. selectLastClosedCandle()/selectLastClosedCandleTimestampMs()
// SEMPRE leem `.length` e iteram a série -- se o helper for chamado, este
// proxy lança e o teste falha. Prova por INSTRUMENTAÇÃO, não por
// inspeção/grep (exigência explícita da correção B).
function poisonCandles() {
  return new Proxy([], {
    get() {
      throw new Error("POISON: selectLastClosedCandleTimestampMs foi chamado com a flag desligada");
    },
  });
}

function countingNowFn(fixedNowMs) {
  const calls = [];
  const fn = () => {
    calls.push(fixedNowMs);
    return fixedNowMs;
  };
  fn.calls = calls;
  return fn;
}

test("flag desligada: devolve undefined SEM chamar nowFn nem acessar candles (helper de candle nunca roda)", () => {
  const nowFn = countingNowFn(1_700_000_000_000);
  const result = buildAgentRouterAssessmentMeta({
    enabled: false,
    triggerReason: "quant_signal",
    candles: poisonCandles(),
    interval: "1",
    nowFn,
  });
  assert.equal(result, undefined);
  assert.equal(nowFn.calls.length, 0);
});

test("flag desligada: mesmo com triggerReason/candles/interval válidos, ainda devolve undefined (flag manda, não os dados)", () => {
  const candles = [[0, "1", "1", "1", "1", "1"], [60_000, "1", "1", "1", "1", "1"]];
  const result = buildAgentRouterAssessmentMeta({ enabled: false, triggerReason: "heartbeat", candles, interval: "1", nowFn: () => 999_999 });
  assert.equal(result, undefined);
});

test("flag ligada: usa exatamente decision.reason (triggerReason), candles e interval recebidos -- e lê nowFn UMA única vez", () => {
  const candles = [
    [0, "1", "1", "1", "1", "1"],
    [60_000, "1", "1", "1", "1", "1"],
    [120_000, "1", "1", "1", "1", "1"],
  ];
  const nowFn = countingNowFn(122_000); // 60000+60000=120000 <= now (fechado); 120000+60000=180000 > now (aberto)
  const result = buildAgentRouterAssessmentMeta({ enabled: true, triggerReason: "quant_signal", candles, interval: "1", nowFn });
  assert.deepEqual(result, { triggerReason: "quant_signal", lastClosedCandleTimestampMs: 60_000 });
  assert.equal(nowFn.calls.length, 1);
});

test("flag ligada: triggerReason é repassado literalmente (inclusive um valor desconhecido) -- classificação/validação NÃO acontece aqui", () => {
  const candles = [[0, "1", "1", "1", "1", "1"]];
  const result = buildAgentRouterAssessmentMeta({ enabled: true, triggerReason: "algum_trigger_desconhecido", candles, interval: "1", nowFn: () => 999_999 });
  assert.equal(result.triggerReason, "algum_trigger_desconhecido");
  // não lança aqui -- UnknownTriggerReasonError só pode nascer dentro de
  // getAssessment()/agentRouterGate.js, nunca antes dele (exigência
  // explícita da correção B).
});

test("flag ligada: candle inválido (nenhum fechado, interval desconhecido, série malformada) vira lastClosedCandleTimestampMs=null -- NUNCA lança aqui", () => {
  const candles = [[0, "1", "1", "1", "1", "1"]];
  const aindaAberto = buildAgentRouterAssessmentMeta({ enabled: true, triggerReason: "quant_signal", candles, interval: "1", nowFn: () => 30_000 });
  assert.equal(aindaAberto.lastClosedCandleTimestampMs, null);

  const intervaloDesconhecido = buildAgentRouterAssessmentMeta({ enabled: true, triggerReason: "quant_signal", candles, interval: "9999", nowFn: () => 999_999 });
  assert.equal(intervaloDesconhecido.lastClosedCandleTimestampMs, null);

  const semCandles = buildAgentRouterAssessmentMeta({ enabled: true, triggerReason: "heartbeat", candles: [], interval: "1", nowFn: () => 999_999 });
  assert.equal(semCandles.lastClosedCandleTimestampMs, null);

  const candlesInvalidos = buildAgentRouterAssessmentMeta({ enabled: true, triggerReason: "heartbeat", candles: "not-an-array", interval: "1", nowFn: () => 999_999 });
  assert.equal(candlesInvalidos.lastClosedCandleTimestampMs, null);
});

test("assessmentMeta nunca é mesclado a nenhum objeto de contexto -- é sempre um objeto novo e independente, só com as 2 chaves documentadas", () => {
  const candles = [[0, "1", "1", "1", "1", "1"]];
  const result = buildAgentRouterAssessmentMeta({ enabled: true, triggerReason: "quant_signal", candles, interval: "1", nowFn: () => 60_000 });
  assert.deepEqual(Object.keys(result).sort(), ["lastClosedCandleTimestampMs", "triggerReason"]);
});

test("nowFn default é Date.now quando omitido (produção real) -- só confirma que não lança sem o parâmetro", () => {
  const candles = [[0, "1", "1", "1", "1", "1"]];
  assert.doesNotThrow(() => buildAgentRouterAssessmentMeta({ enabled: true, triggerReason: "heartbeat", candles, interval: "1" }));
  assert.doesNotThrow(() => buildAgentRouterAssessmentMeta({ enabled: false, triggerReason: "heartbeat", candles, interval: "1" }));
});

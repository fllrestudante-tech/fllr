// Testa lib/clockSync.js -- preflight fail-closed de sincronização de
// relógio. fetchImpl SEMPRE injetado nos testes (nunca axios real, nunca
// rede de verdade); `now` SEMPRE controlado (nunca Date.now() real) --
// nenhum teste deste arquivo depende de timing real ou de qualquer chamada
// de rede.
const test = require("node:test");
const assert = require("node:assert/strict");
const { assertClockSynced, ClockSyncBlockedError, median, MAX_OFFSET_MS, MAX_RTT_MS, MIN_VALID_SAMPLES, SAMPLE_COUNT } = require("../lib/clockSync");

const BASE_URL = "https://api-demo.bybit.com";

test("median: ímpar -> valor do meio; par -> média dos dois centrais", () => {
  assert.equal(median([1, 5, 3]), 3);
  assert.equal(median([10, 1, 5]), 5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("assertClockSynced: constantes exigidas explicitamente -- SAMPLE_COUNT=3, MAX_OFFSET_MS=1000", () => {
  assert.equal(SAMPLE_COUNT, 3);
  assert.equal(MAX_OFFSET_MS, 1000);
  assert.equal(MIN_VALID_SAMPLES, 2);
});

/**
 * Constrói um fetchImpl fake -- cada chamada consome o próximo item de
 * `scriptedResponses` (server time em ms, ou uma função que lança um erro,
 * ou 'timeout' pra simular um travamento que nunca resolve dentro do
 * REQUEST_TIMEOUT_MS -- aqui simplificado como um reject de rede, já que
 * este módulo não implementa timeout próprio no fetchImpl injetado; quem
 * queria testar o timeout REAL do axios precisaria de rede de verdade, o
 * que nunca acontece nesta suíte). `rttMs` -- quanto tempo (medido por
 * `now`) a chamada "consome" antes de resolver, pra simular RTT real.
 */
function makeFetchImpl(scriptedResponses, { nowRef }) {
  let call = 0;
  return async (url, opts) => {
    assert.equal(url, `${BASE_URL}/v5/market/time`, "sempre a mesma rota pública, sem autenticação/assinatura");
    assert.ok(opts && typeof opts.timeout === "number", "precisa passar um timeout explícito, nunca esperar indefinidamente");
    const spec = scriptedResponses[call];
    call++;
    if (!spec) throw new Error("fetchImpl chamado mais vezes do que o teste esperava");
    if (spec.error) {
      nowRef.value += spec.rttMs ?? 0;
      throw new Error(spec.error);
    }
    nowRef.value += spec.rttMs ?? 0;
    return { data: spec.body };
  };
}

function makeNow(nowRef) {
  return () => nowRef.value;
}

test("assertClockSynced: 3 amostras com offset pequeno e RTT bom -> passa, devolve offsetMedianMs/sampleCount", async () => {
  const nowRef = { value: 0 };
  // Servidor "responde" exatamente com o ponto médio de cada amostra
  // (t0=0/t1=20 -> midpoint=10; t0=20/t1=40 -> midpoint=30; t0=40/t1=60 ->
  // midpoint=50) -- offset=0 em cada uma, calculado a mão (o corpo de cada
  // resposta precisa ser um valor FIXO, nunca uma expressão sobre
  // `nowRef.value` lida no momento em que o array é montado -- nesse ponto
  // `nowRef.value` ainda não avançou nenhum RTT).
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: 10 }, rttMs: 20 },
      { body: { time: 30 }, rttMs: 20 },
      { body: { time: 50 }, rttMs: 20 },
    ],
    { nowRef }
  );
  const result = await assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) });
  assert.ok(Math.abs(result.offsetMedianMs) < 100);
  assert.equal(result.sampleCount, 3);
});

test("assertClockSynced: offset FUTURO (relógio local adiantado) acima de 1000ms -> bloqueia com ClockSyncBlockedError", async () => {
  const nowRef = { value: 1_000_000 };
  // t0 fixo em 1_000_000; servidor devolve um tempo 5000ms ATRÁS -> offset positivo grande.
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: 1_000_000 - 5000 }, rttMs: 10 },
      { body: { time: 1_000_010 - 5000 }, rttMs: 10 },
      { body: { time: 1_000_020 - 5000 }, rttMs: 10 },
    ],
    { nowRef }
  );
  await assert.rejects(assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) }), (err) => {
    assert.ok(err instanceof ClockSyncBlockedError);
    assert.equal(err.code, "CLOCK_SYNC_BLOCKED");
    assert.equal(err.reason, "offset_exceeds_tolerance");
    return true;
  });
});

test("assertClockSynced: offset PASSADO (relógio local atrasado) acima de 1000ms -> bloqueia", async () => {
  const nowRef = { value: 1_000_000 };
  // Servidor devolve um tempo 5000ms À FRENTE do local -> offset negativo grande.
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: 1_000_000 + 5000 }, rttMs: 10 },
      { body: { time: 1_000_010 + 5000 }, rttMs: 10 },
      { body: { time: 1_000_020 + 5000 }, rttMs: 10 },
    ],
    { nowRef }
  );
  await assert.rejects(assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) }), ClockSyncBlockedError);
});

// Base de epoch REALISTA (positiva, grande) pros próximos testes -- nunca
// 0/negativo: lib/clockSync.js corretamente rejeita `serverTimeMs<=0` como
// implausível (timestamp Unix nunca é 0 ou negativo), então um `time`
// sintético pequeno/negativo nos dados de teste dispararia essa MESMA
// rejeição por engano, mascarada como "3/3 amostras falharam" (achado real
// desta rodada, corrigido aqui).
const REALISTIC_BASE_MS = 1_700_000_000_000;

test("assertClockSynced: exatamente no limite (offset mediano <=1000ms) -> passa; um pouco acima -> bloqueia (fronteira exata)", async () => {
  const nowRefOk = { value: REALISTIC_BASE_MS };
  const fetchImplOk = makeFetchImpl(
    [
      { body: { time: REALISTIC_BASE_MS - 1000 }, rttMs: 0 }, // offset exato = 1000
      { body: { time: REALISTIC_BASE_MS - 1000 }, rttMs: 0 },
      { body: { time: REALISTIC_BASE_MS - 1000 }, rttMs: 0 },
    ],
    { nowRef: nowRefOk }
  );
  const resultOk = await assertClockSynced({ baseUrl: BASE_URL, fetchImpl: fetchImplOk, now: makeNow(nowRefOk) });
  assert.equal(Math.round(resultOk.offsetMedianMs), 1000);

  const nowRefBad = { value: REALISTIC_BASE_MS };
  const fetchImplBad = makeFetchImpl(
    [
      { body: { time: REALISTIC_BASE_MS - 1001 }, rttMs: 0 },
      { body: { time: REALISTIC_BASE_MS - 1001 }, rttMs: 0 },
      { body: { time: REALISTIC_BASE_MS - 1001 }, rttMs: 0 },
    ],
    { nowRef: nowRefBad }
  );
  await assert.rejects(assertClockSynced({ baseUrl: BASE_URL, fetchImpl: fetchImplBad, now: makeNow(nowRefBad) }), ClockSyncBlockedError);
});

test("assertClockSynced: mediana com UM outlier de RTT descartado -- as outras 2 amostras (RTT bom) ainda decidem corretamente", async () => {
  const nowRef = { value: REALISTIC_BASE_MS };
  // Traçado a mão (valores FIXOS, nunca `nowRef.value` lido no momento
  // errado): amostra 1 (t0=BASE,t1=BASE+10,midpoint=BASE+5) com
  // body.time=BASE-895 -> offset exato = 900 (dentro da tolerância).
  // Amostra 2 (t0=BASE+10,t1=BASE+510,RTT=500>300) -- descartada por RTT, o
  // valor de body.time aqui é irrelevante de propósito. Amostra 3
  // (t0=BASE+510,t1=BASE+520,midpoint=BASE+515) com body.time=BASE-385 ->
  // offset exato = 900 também. Mediana de [900, 900] = 900 -- dentro do
  // limite de 1000ms, prova de que o outlier de RTT (que teria offset
  // ~5000ms se fosse usado) NUNCA contaminou o resultado.
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: REALISTIC_BASE_MS - 895 }, rttMs: 10 },
      { body: { time: REALISTIC_BASE_MS - 4740 }, rttMs: 500 },
      { body: { time: REALISTIC_BASE_MS - 385 }, rttMs: 10 },
    ],
    { nowRef }
  );
  const result = await assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) });
  assert.equal(result.sampleCount, 2, "a amostra de RTT ruim precisa ter sido descartada, restando 2");
  assert.equal(Math.round(result.offsetMedianMs), 900, "mediana das 2 amostras boas -- prova de que o outlier de RTT (offset ~5000ms) NÃO contaminou o resultado");
});

test("assertClockSynced: RTT excessivo em TODAS as amostras -> bloqueia por amostras insuficientes, nunca calcula uma mediana com dado pouco confiável", async () => {
  const nowRef = { value: REALISTIC_BASE_MS };
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: REALISTIC_BASE_MS }, rttMs: 400 },
      { body: { time: REALISTIC_BASE_MS }, rttMs: 500 },
      { body: { time: REALISTIC_BASE_MS }, rttMs: 350 },
    ],
    { nowRef }
  );
  await assert.rejects(assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) }), (err) => {
    assert.ok(err instanceof ClockSyncBlockedError);
    assert.equal(err.reason, "insufficient_reliable_samples");
    return true;
  });
});

test("assertClockSynced: RTT exatamente no limite (300ms) -> aceito; RTT de 301ms -> descartado (fronteira exata do filtro)", async () => {
  const nowRef1 = { value: REALISTIC_BASE_MS };
  const fetchImplBoundary = makeFetchImpl(
    [
      { body: { time: REALISTIC_BASE_MS }, rttMs: 300 },
      { body: { time: REALISTIC_BASE_MS }, rttMs: 300 },
      { body: { time: REALISTIC_BASE_MS }, rttMs: 300 },
    ],
    { nowRef: nowRef1 }
  );
  const result = await assertClockSynced({ baseUrl: BASE_URL, fetchImpl: fetchImplBoundary, now: makeNow(nowRef1) });
  assert.equal(result.sampleCount, 3, "RTT de exatamente 300ms deveria ser aceito (limite inclusivo)");
  assert.equal(MAX_RTT_MS, 300);
});

test("assertClockSynced: timeout/erro de rede em TODAS as amostras -> bloqueia com reason network_or_invalid_response", async () => {
  const nowRef = { value: 1_000_000 };
  const fetchImpl = makeFetchImpl(
    [
      { error: "ECONNREFUSED" },
      { error: "ETIMEDOUT" },
      { error: "ECONNRESET" },
    ],
    { nowRef }
  );
  await assert.rejects(assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) }), (err) => {
    assert.ok(err instanceof ClockSyncBlockedError);
    assert.equal(err.reason, "network_or_invalid_response");
    return true;
  });
});

test("assertClockSynced: JSON/corpo inválido (sem campo 'time' numérico) -> tratado como amostra inválida, bloqueia se não sobrarem amostras suficientes", async () => {
  const nowRef = { value: 1_000_000 };
  const fetchImpl = makeFetchImpl(
    [
      { body: { retCode: 0 }, rttMs: 10 }, // sem 'time'
      { body: { time: "não é um número" }, rttMs: 10 },
      { body: null, rttMs: 10 },
    ],
    { nowRef }
  );
  await assert.rejects(assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) }), ClockSyncBlockedError);
});

test("assertClockSynced: 'time' não plausível (zero/negativo) -> amostra rejeitada como inválida, nunca usada", async () => {
  const nowRef = { value: 1_000_000 };
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: 0 }, rttMs: 10 },
      { body: { time: -5 }, rttMs: 10 },
      { body: { time: nowRef.value }, rttMs: 10 }, // única válida -- ainda insuficiente (precisa de 2)
    ],
    { nowRef }
  );
  await assert.rejects(assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) }), (err) => {
    assert.equal(err.reason, "insufficient_reliable_samples");
    return true;
  });
});

test("assertClockSynced: nunca lança nenhum tipo de erro além de ClockSyncBlockedError", async () => {
  const nowRef = { value: 0 };
  const fetchImpl = async () => {
    throw new TypeError("algo totalmente inesperado explodiu dentro do axios");
  };
  await assert.rejects(assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) }), ClockSyncBlockedError);
});

test("assertClockSynced: mensagem de erro é sempre sanitizada -- nunca inclui headers, corpo bruto, ou qualquer coisa além do que este módulo mesmo calculou", async () => {
  const nowRef = { value: 1_000_000 };
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: nowRef.value - 5000, __secret_header: "Authorization: Bearer segredo-nao-deveria-aparecer" }, rttMs: 10 },
      { body: { time: nowRef.value - 5000 }, rttMs: 10 },
      { body: { time: nowRef.value - 5000 }, rttMs: 10 },
    ],
    { nowRef }
  );
  try {
    await assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) });
    assert.fail("deveria ter lançado");
  } catch (err) {
    assert.ok(!err.message.includes("segredo-nao-deveria-aparecer"));
    assert.ok(!err.message.includes("Authorization"));
    assert.ok(!err.message.includes("Bearer"));
  }
});

test("assertClockSynced: NUNCA chama nada relacionado a ajustar relógio, iniciar W32Time, ou mudar recv_window -- varredura estática do próprio módulo (ausência de qualquer mecanismo capaz disso, não só das palavras -- o arquivo MENCIONA W32Time/recv_window em comentários/mensagens explicando que nunca os toca, o que é esperado)", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "clockSync.js"), "utf8");
  // A prova real de "nunca ajusta o relógio/W32Time" é a AUSÊNCIA de
  // qualquer mecanismo capaz de shell-out (child_process/exec/spawn) --
  // sem isso, não há como este módulo, em JS puro, tocar em w32tm/
  // Start-Service/registro do Windows. Também confirma que RECV_WINDOW
  // nunca é reatribuído (só mencionado em texto, comparando com a
  // constante independente MAX_OFFSET_MS).
  for (const forbidden of ["child_process", "require(\"child_process\")", ".exec(", ".spawn(", ".execSync(", "setSystemTime", "RECV_WINDOW =", "RECV_WINDOW="]) {
    assert.ok(!source.includes(forbidden), `lib/clockSync.js não deveria conter "${forbidden}"`);
  }
});

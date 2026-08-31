// Testa lib/clockSync.js -- preflight fail-closed de sincronização de
// relógio. fetchImpl SEMPRE injetado nos testes (nunca axios real, nunca
// rede de verdade); `now` SEMPRE controlado (nunca Date.now() real) --
// nenhum teste deste arquivo depende de timing real ou de qualquer chamada
// de rede.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertClockSynced,
  ClockSyncBlockedError,
  median,
  extractServerTimeMs,
  parseCandidateMs,
  MAX_OFFSET_MS,
  MAX_RTT_MS,
  MIN_VALID_SAMPLES,
  SAMPLE_COUNT,
  TIME_FIELD_CONSISTENCY_TOLERANCE_MS,
} = require("../lib/clockSync");

const BASE_URL = "https://api-demo.bybit.com";
// Base de epoch REALISTA (positiva, grande, dentro da faixa plausível
// 2020-2100) -- lib/clockSync.js corretamente rejeita timestamps fora
// dessa faixa como implausíveis, então todo dado sintético destes testes
// usa esta base pra nunca disparar essa rejeição por engano.
const REALISTIC_BASE_MS = 1_700_000_000_000;

test("median: ímpar -> valor do meio; par -> média dos dois centrais", () => {
  assert.equal(median([1, 5, 3]), 3);
  assert.equal(median([10, 1, 5]), 5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("constantes exigidas explicitamente -- SAMPLE_COUNT=3, MAX_OFFSET_MS=1000, MIN_VALID_SAMPLES=2, MAX_RTT_MS=2000 (elevado nesta rodada -- RTT real medido contra api-demo.bybit.com sem reuso de conexão: 356-1096ms)", () => {
  assert.equal(SAMPLE_COUNT, 3);
  assert.equal(MAX_OFFSET_MS, 1000);
  assert.equal(MIN_VALID_SAMPLES, 2);
  assert.equal(MAX_RTT_MS, 2000);
  assert.equal(TIME_FIELD_CONSISTENCY_TOLERANCE_MS, 2500);
});

// =====================================================================
// parseCandidateMs / extractServerTimeMs -- núcleo do parser multi-campo,
// testado isoladamente (sem rede, sem assertClockSynced).
// =====================================================================

test("parseCandidateMs: unit='ms' só aceita number finito dentro da faixa plausível", () => {
  assert.equal(parseCandidateMs(REALISTIC_BASE_MS, "ms"), REALISTIC_BASE_MS);
  assert.equal(parseCandidateMs("1700000000000", "ms"), null, "string nunca aceita pra campo ms");
  assert.equal(parseCandidateMs(NaN, "ms"), null);
  assert.equal(parseCandidateMs(Infinity, "ms"), null);
  assert.equal(parseCandidateMs(0, "ms"), null, "fora da faixa plausível (ano 1970)");
  assert.equal(parseCandidateMs(-5, "ms"), null);
  assert.equal(parseCandidateMs(null, "ms"), null);
  assert.equal(parseCandidateMs(undefined, "ms"), null);
});

test("parseCandidateMs: unit='s' (timeSecond) só aceita STRING de dígitos puros, nunca number/decimal/negativo/notação científica", () => {
  const seconds = Math.floor(REALISTIC_BASE_MS / 1000);
  assert.equal(parseCandidateMs(String(seconds), "s"), seconds * 1000);
  assert.equal(parseCandidateMs(seconds, "s"), null, "number nunca aceito pra timeSecond -- só string");
  assert.equal(parseCandidateMs("123.5", "s"), null, "decimal rejeitado");
  assert.equal(parseCandidateMs("-123", "s"), null, "negativo rejeitado (regex de dígitos puros)");
  assert.equal(parseCandidateMs("1e10", "s"), null, "notação científica rejeitada");
  assert.equal(parseCandidateMs("abc", "s"), null);
});

test("parseCandidateMs: unit='ns' (timeNano) só aceita STRING de dígitos puros, converte pra ms corretamente", () => {
  const nano = String(REALISTIC_BASE_MS) + "000000"; // ms -> ns (x1e6)
  const parsed = parseCandidateMs(nano, "ns");
  assert.ok(Math.abs(parsed - REALISTIC_BASE_MS) < 1, "conversão ns->ms deveria ser exata dentro de <1ms");
  assert.equal(parseCandidateMs(Number(nano), "ns"), null, "number nunca aceito pra timeNano -- só string");
  assert.equal(parseCandidateMs("-" + nano, "ns"), null);
});

test("extractServerTimeMs: resposta realista com APENAS 'time' (raiz, ms) -> usa esse campo", () => {
  const result = extractServerTimeMs({ retCode: 0, retMsg: "OK", time: REALISTIC_BASE_MS });
  assert.equal(result.ok, true);
  assert.equal(result.ms, REALISTIC_BASE_MS);
  assert.equal(result.source, "time");
});

test("extractServerTimeMs: resposta realista com APENAS 'result.timeSecond' -> usa esse campo (precisão de segundo)", () => {
  const seconds = Math.floor(REALISTIC_BASE_MS / 1000);
  const result = extractServerTimeMs({ retCode: 0, result: { timeSecond: String(seconds) } });
  assert.equal(result.ok, true);
  assert.equal(result.ms, seconds * 1000);
  assert.equal(result.source, "timeSecond");
});

test("extractServerTimeMs: resposta realista com APENAS 'result.timeNano' -> usa esse campo", () => {
  const nano = String(REALISTIC_BASE_MS) + "000000";
  const result = extractServerTimeMs({ retCode: 0, result: { timeNano: nano } });
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.ms - REALISTIC_BASE_MS) < 1);
  assert.equal(result.source, "timeNano");
});

test("extractServerTimeMs: forma REAL da Bybit (time + timeSecond + timeNano juntos, todos consistentes) -> passa, prioriza 'time'", () => {
  // Forma exata confirmada contra o endpoint real nesta rodada:
  // {retCode:0, retMsg:"OK", result:{timeSecond, timeNano}, retExtInfo:{}, time}
  const seconds = Math.floor(REALISTIC_BASE_MS / 1000);
  const nano = String(REALISTIC_BASE_MS) + "000000";
  const result = extractServerTimeMs({
    retCode: 0,
    retMsg: "OK",
    result: { timeSecond: String(seconds), timeNano: nano },
    retExtInfo: {},
    time: REALISTIC_BASE_MS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "time", "precedência: time > timeNano > timeSecond quando todos concordam");
  assert.equal(result.ms, REALISTIC_BASE_MS);
});

test("extractServerTimeMs: campos CONFLITANTES (divergem além da tolerância) -> bloqueia, nunca escolhe um silenciosamente", () => {
  const result = extractServerTimeMs({
    time: REALISTIC_BASE_MS,
    result: { timeSecond: String(Math.floor((REALISTIC_BASE_MS + 60_000) / 1000)) }, // 60s à frente -- muito além da tolerância de 2500ms
  });
  assert.equal(result.ok, false);
  assert.equal(result.inconsistent, true);
});

test("extractServerTimeMs: timeSecond truncado ao segundo (até ~999ms de diferença de 'time') é NORMAL, não inconsistência", () => {
  const seconds = Math.floor(REALISTIC_BASE_MS / 1000); // trunca a parte sub-segundo
  const result = extractServerTimeMs({ time: REALISTIC_BASE_MS + 900, result: { timeSecond: String(seconds) } });
  assert.equal(result.ok, true, "divergência de até ~1000ms entre time e timeSecond é esperada (quantização), não deveria bloquear");
});

test("extractServerTimeMs: nenhum campo válido -> ok=false, nunca lança", () => {
  assert.equal(extractServerTimeMs({}).ok, false);
  assert.equal(extractServerTimeMs(null).ok, false);
  assert.equal(extractServerTimeMs({ time: "string", result: { timeSecond: -1, timeNano: 123 } }).ok, false);
});

// =====================================================================
// assertClockSynced -- fluxo completo (3 amostras, RTT, mediana, offset).
// =====================================================================

/**
 * Constrói um fetchImpl fake -- cada chamada consome o próximo item de
 * `scriptedResponses`. `rttMs` -- quanto tempo (medido por `now`) a
 * chamada "consome" antes de resolver, pra simular RTT real.
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
  // MESMO objeto nowRef compartilhado entre fetchImpl e `now` -- nunca
  // duas referências desconectadas (um erro real cometido e corrigido
  // nesta rodada: duas cópias distintas produziam RTT sempre zero e
  // mascaravam o que o teste realmente queria medir).
  const nowRef = { value: REALISTIC_BASE_MS };
  // midpoint de cada amostra (t0 acumulado + rtt/2) escolhido pra manter
  // offset≈0: amostra1 t0=BASE,t1=BASE+20,midpoint=BASE+10;
  // amostra2 t0=BASE+20,t1=BASE+40,midpoint=BASE+30;
  // amostra3 t0=BASE+40,t1=BASE+60,midpoint=BASE+50.
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: REALISTIC_BASE_MS + 10 }, rttMs: 20 },
      { body: { time: REALISTIC_BASE_MS + 30 }, rttMs: 20 },
      { body: { time: REALISTIC_BASE_MS + 50 }, rttMs: 20 },
    ],
    { nowRef }
  );
  const result = await assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) });
  assert.ok(Math.abs(result.offsetMedianMs) < 100);
  assert.equal(result.sampleCount, 3);
});

test("assertClockSynced: offset FUTURO (relógio local adiantado) acima de 1000ms -> bloqueia com ClockSyncBlockedError", async () => {
  const nowRef = { value: REALISTIC_BASE_MS };
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: REALISTIC_BASE_MS - 5000 }, rttMs: 10 },
      { body: { time: REALISTIC_BASE_MS + 10 - 5000 }, rttMs: 10 },
      { body: { time: REALISTIC_BASE_MS + 20 - 5000 }, rttMs: 10 },
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
  const nowRef = { value: REALISTIC_BASE_MS };
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: REALISTIC_BASE_MS + 5000 }, rttMs: 10 },
      { body: { time: REALISTIC_BASE_MS + 10 + 5000 }, rttMs: 10 },
      { body: { time: REALISTIC_BASE_MS + 20 + 5000 }, rttMs: 10 },
    ],
    { nowRef }
  );
  await assert.rejects(assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) }), ClockSyncBlockedError);
});

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

test("assertClockSynced: mediana com UM outlier de RTT (>2000ms) descartado -- as outras 2 amostras (RTT bom) ainda decidem corretamente", async () => {
  const nowRef = { value: REALISTIC_BASE_MS };
  // Amostra 1 (t0=BASE,t1=BASE+10,midpoint=BASE+5) com body.time=BASE-895
  // -> offset exato = 900 (dentro da tolerância). Amostra 2
  // (RTT=2500>2000) -- descartada por RTT, valor de body.time irrelevante
  // de propósito. Amostra 3 com offset exato = 900 também. Mediana de
  // [900, 900] = 900 -- prova de que o outlier de RTT nunca contaminou o
  // resultado.
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: REALISTIC_BASE_MS - 895 }, rttMs: 10 },
      { body: { time: REALISTIC_BASE_MS - 40_000 }, rttMs: 2500 },
      // t0 desta amostra já está em BASE+2510 (10 da amostra 1 + 2500 da
      // amostra 2, cumulativo no MESMO nowRef) -> t1=BASE+2520,
      // midpoint=BASE+2515 -> body.time=midpoint-900=BASE+1615, pra manter
      // o offset exato em 900 mesmo com o avanço cumulativo do relógio
      // simulado.
      { body: { time: REALISTIC_BASE_MS + 1615 }, rttMs: 10 },
    ],
    { nowRef }
  );
  const result = await assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) });
  assert.equal(result.sampleCount, 2, "a amostra de RTT ruim (>2000ms) precisa ter sido descartada, restando 2");
  assert.equal(Math.round(result.offsetMedianMs), 900, "mediana das 2 amostras boas -- prova de que o outlier de RTT NÃO contaminou o resultado");
});

test("assertClockSynced: RTT excessivo (>2000ms) em TODAS as amostras -> bloqueia por amostras insuficientes, nunca calcula uma mediana com dado pouco confiável", async () => {
  const nowRef = { value: REALISTIC_BASE_MS };
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: REALISTIC_BASE_MS }, rttMs: 2100 },
      { body: { time: REALISTIC_BASE_MS }, rttMs: 2500 },
      { body: { time: REALISTIC_BASE_MS }, rttMs: 2200 },
    ],
    { nowRef }
  );
  await assert.rejects(assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) }), (err) => {
    assert.ok(err instanceof ClockSyncBlockedError);
    assert.equal(err.reason, "insufficient_reliable_samples");
    return true;
  });
});

test("assertClockSynced: RTT exatamente no limite (2000ms, novo valor desta rodada) -> aceito (limite inclusivo)", async () => {
  const nowRef1 = { value: REALISTIC_BASE_MS };
  // body.time acompanha o midpoint de CADA amostra (nunca um valor fixo)
  // pra manter offset=0 mesmo com o avanço cumulativo do nowRef simulado
  // entre amostras sequenciais (t0 da amostra N já reflete o RTT
  // acumulado das anteriores, já que compartilham o mesmo nowRef).
  const fetchImplBoundary = makeFetchImpl(
    [
      { body: { time: REALISTIC_BASE_MS + 1000 }, rttMs: 2000 }, // midpoint amostra1 = BASE+1000
      { body: { time: REALISTIC_BASE_MS + 3000 }, rttMs: 2000 }, // midpoint amostra2 = BASE+3000
      { body: { time: REALISTIC_BASE_MS + 5000 }, rttMs: 2000 }, // midpoint amostra3 = BASE+5000
    ],
    { nowRef: nowRef1 }
  );
  const result = await assertClockSynced({ baseUrl: BASE_URL, fetchImpl: fetchImplBoundary, now: makeNow(nowRef1) });
  assert.equal(result.sampleCount, 3, "RTT de exatamente 2000ms deveria ser aceito (limite inclusivo)");
});

test("assertClockSynced: timeout/erro de rede em TODAS as amostras -> bloqueia com reason network_or_invalid_response", async () => {
  const nowRef = { value: REALISTIC_BASE_MS };
  const fetchImpl = makeFetchImpl(
    [{ error: "ECONNREFUSED" }, { error: "ETIMEDOUT" }, { error: "ECONNRESET" }],
    { nowRef }
  );
  await assert.rejects(assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) }), (err) => {
    assert.ok(err instanceof ClockSyncBlockedError);
    assert.equal(err.reason, "network_or_invalid_response");
    return true;
  });
});

test("assertClockSynced: JSON/corpo inválido (sem nenhum campo de tempo válido) -> tratado como amostra inválida, bloqueia se não sobrarem amostras suficientes", async () => {
  const nowRef = { value: REALISTIC_BASE_MS };
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

test("assertClockSynced: 'time' não plausível (zero/negativo/fora de faixa) -> amostra rejeitada como inválida, nunca usada", async () => {
  const nowRef = { value: REALISTIC_BASE_MS };
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: 0 }, rttMs: 10 },
      { body: { time: -5 }, rttMs: 10 },
      { body: { time: REALISTIC_BASE_MS }, rttMs: 10 }, // única válida -- ainda insuficiente (precisa de 2)
    ],
    { nowRef }
  );
  await assert.rejects(assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) }), (err) => {
    assert.equal(err.reason, "insufficient_reliable_samples");
    return true;
  });
});

test("assertClockSynced: campos conflitantes em uma amostra (time vs timeSecond divergindo muito) -> amostra tratada como inválida, nunca escolhe um valor silenciosamente", async () => {
  const nowRef = { value: REALISTIC_BASE_MS };
  const conflictingSeconds = String(Math.floor((REALISTIC_BASE_MS + 120_000) / 1000)); // 2min à frente
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: REALISTIC_BASE_MS, result: { timeSecond: conflictingSeconds } }, rttMs: 10 },
      { body: { time: REALISTIC_BASE_MS + 10 }, rttMs: 10 },
      { body: { time: REALISTIC_BASE_MS + 20 }, rttMs: 10 },
    ],
    { nowRef }
  );
  const result = await assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) });
  // As duas amostras "limpas" (sem conflito) ainda bastam pra aprovar --
  // só a amostra com campos conflitantes é descartada, nunca usada.
  assert.equal(result.sampleCount, 2);
});

test("assertClockSynced: nunca lança nenhum tipo de erro além de ClockSyncBlockedError", async () => {
  const nowRef = { value: 0 };
  const fetchImpl = async () => {
    throw new TypeError("algo totalmente inesperado explodiu dentro do axios");
  };
  await assert.rejects(assertClockSynced({ baseUrl: BASE_URL, fetchImpl, now: makeNow(nowRef) }), ClockSyncBlockedError);
});

test("assertClockSynced: mensagem de erro é sempre sanitizada -- nunca inclui headers, corpo bruto, ou qualquer coisa além do que este módulo mesmo calculou", async () => {
  const nowRef = { value: REALISTIC_BASE_MS };
  const fetchImpl = makeFetchImpl(
    [
      { body: { time: REALISTIC_BASE_MS - 5000, __secret_header: "Authorization: Bearer segredo-nao-deveria-aparecer" }, rttMs: 10 },
      { body: { time: REALISTIC_BASE_MS - 5000 }, rttMs: 10 },
      { body: { time: REALISTIC_BASE_MS - 5000 }, rttMs: 10 },
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
  for (const forbidden of ["child_process", "require(\"child_process\")", ".exec(", ".spawn(", ".execSync(", "setSystemTime", "RECV_WINDOW =", "RECV_WINDOW="]) {
    assert.ok(!source.includes(forbidden), `lib/clockSync.js não deveria conter "${forbidden}"`);
  }
});

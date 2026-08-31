// Verificação fail-closed de sincronização de relógio -- terceiro gate do
// boot do perfil demo (ver index.js::boot(), chamado como primeira linha,
// antes de QUALQUER leitura pública ou privada). Um relógio dessincronizado
// é tratado com a MESMA severidade que credenciais ausentes ou perfil
// errado -- nunca "tenta mesmo assim, torcendo pra dar certo" (foi
// exatamente isso que produziu retCode=10002 numa sessão real deste
// projeto: relógio sem sincronização ativa após um crash/reboot).
//
// Só usa o endpoint PÚBLICO /v5/market/time (sem chave, sem HMAC, sem
// assinatura) no MESMO BASE_URL já resolvido estritamente pro perfil demo
// (lib/bybit.js::BASE_URL) -- nunca um host hardcoded à parte, nunca a
// mesma superfície privada que este preflight existe pra proteger.
//
// NUNCA ajusta o relógio local, NUNCA inicia/mexe no W32Time, NUNCA
// aumenta recv_window pra "resolver" um offset ruim -- só mede e decide
// permitir ou bloquear o boot. A decisão de sincronizar o relógio de
// verdade é sempre humana/operacional, fora deste módulo.
//
// Achado real (auditoria de crash-loop, ver histórico do projeto): validado
// contra o endpoint real de /v5/market/time -- a resposta tem SEMPRE os
// três campos (`time` raiz em ms, `result.timeSecond` em s, `result.
// timeNano` em ns), então o parser original (só `data.time`) já estava
// correto. A causa real do crash-loop foi RTT real medido (300-1100ms sem
// reuso de conexão HTTP) sempre excedendo o MAX_RTT_MS antigo (300ms) --
// as 3 amostras eram descartadas por RTT em TODA tentativa, nunca por
// relógio de fato dessincronizado (offset real medido: dezenas a poucas
// centenas de ms, bem dentro da tolerância). Corrigido nesta rodada:
// MAX_RTT_MS elevado pra refletir a latência real observada (com margem),
// e o parser ganhou suporte explícito e validado aos 3 campos (multi-
// fonte, com checagem de consistência) por robustez, não porque o campo
// `time` sozinho tivesse falhado.
const axios = require("axios");

const TIME_PATH = "/v5/market/time";

// 3 amostras -- número finito, nunca retry infinito. MIN_VALID_SAMPLES=2 ==
// maioria simples: tolera UM outlier de RTT sem invalidar a medição inteira,
// mas duas amostras ruins já são motivo suficiente pra não confiar no offset.
const SAMPLE_COUNT = 3;
const MIN_VALID_SAMPLES = 2;

// Limite de tolerância do offset -- exigido explicitamente, mesma margem
// usada em toda a auditoria desta sessão (bem abaixo do recv_window=5000ms
// de lib/bybit.js, nunca o mesmo número -- este preflight é uma camada
// INDEPENDENTE, não uma extensão do recv_window).
const MAX_OFFSET_MS = 1000;

// RTT acima disso torna a estimativa de offset pouco confiável. Elevado
// nesta rodada (era 300ms) depois de medir o RTT REAL contra
// api-demo.bybit.com sem reuso de conexão (axios.get novo a cada amostra,
// de propósito -- nunca compartilha keep-alive entre amostras, pra cada
// uma ser uma medição independente): observado 356-1096ms em condições
// normais (handshake TLS completo por amostra). 2000ms cobre esse
// cenário real com folga, ainda descartando conexões genuinamente
// degradadas (mais de 40% do REQUEST_TIMEOUT_MS por amostra).
const MAX_RTT_MS = 2000;

// Timeout curto por amostra -- nunca deixa uma amostra pendurada
// indefinidamente; 3 amostras x 5s no pior caso (todas travando) ainda é um
// tempo finito e curto de boot, nunca um retry sem fim.
const REQUEST_TIMEOUT_MS = 5000;

// Faixa plausível de epoch (ms) -- qualquer campo de tempo fora disso é
// tratado como implausível/corrompido, nunca aceito. Ampla de propósito
// (não é uma checagem de offset, só uma defesa contra um campo com lixo/
// unidade errada/overflow).
const MIN_PLAUSIBLE_EPOCH_MS = Date.parse("2020-01-01T00:00:00Z");
const MAX_PLAUSIBLE_EPOCH_MS = Date.parse("2100-01-01T00:00:00Z");

// Quando MAIS de um campo de tempo está presente na mesma resposta, todos
// precisam concordar dentro desta tolerância -- nunca escolhe silenciosamente
// um em caso de divergência (bloqueia a amostra inteira). Maior que
// MAX_OFFSET_MS de propósito: `timeSecond` trunca até 999ms de precisão
// (perde a parte sub-segundo), então uma divergência de até ~1000ms entre
// `timeSecond` e `time`/`timeNano` é esperada e normal, não um sinal de
// corrupção -- a margem cobre essa quantização mais uma folga de jitter
// razoável entre campos da MESMA resposta HTTP.
const TIME_FIELD_CONSISTENCY_TOLERANCE_MS = 2500;

/**
 * Erro público estável -- mensagem SEMPRE sanitizada (nunca headers,
 * assinatura, ou corpo bruto da resposta), só números/contagens que este
 * módulo mesmo calculou. `reason` é um código curto e estável, pro chamador
 * (index.js::boot()) logar/decidir sem parsear a mensagem em texto livre.
 */
class ClockSyncBlockedError extends Error {
  constructor(reason, detail) {
    super(
      `Relógio local não pôde ser confirmado como sincronizado (${reason})${detail ? ` -- ${detail}` : ""}. Boot do perfil demo bloqueado -- nenhuma leitura privada foi feita. Este módulo nunca ajusta o relógio, nunca inicia o W32Time, nunca aumenta o recv_window; sincronize o relógio do sistema e tente de novo.`
    );
    this.name = this.constructor.name;
    this.code = "CLOCK_SYNC_BLOCKED";
    this.reason = reason;
  }
}

/** Mediana, não média -- resistente a um outlier isolado sem pedir mais amostras. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Converte UM campo bruto pra epoch em ms, validando formato e faixa
 * ESTRITAMENTE -- nunca aceita number pra campos que deveriam ser string
 * (timeSecond/timeNano, evita notação científica/decimal/negativo via
 * regex de dígitos puros), nunca aceita string pra `time` (deveria ser
 * number). `null` pra qualquer coisa ausente/malformada/implausível --
 * nunca lança, nunca inventa um valor.
 */
function parseCandidateMs(raw, unit) {
  if (raw === undefined || raw === null) return null;
  let ms;
  if (unit === "ms") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    ms = raw;
  } else {
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    ms = unit === "s" ? n * 1000 : n / 1e6; // "ns" -> ms
  }
  if (ms < MIN_PLAUSIBLE_EPOCH_MS || ms > MAX_PLAUSIBLE_EPOCH_MS) return null;
  return ms;
}

/**
 * Extrai o timestamp do servidor (ms) da resposta, com precedência clara
 * e validação de consistência entre campos:
 *   - candidatos: `time` (raiz, number, ms) / `result.timeNano` (string,
 *     ns) / `result.timeSecond` (string, s) -- cada um validado
 *     independentemente por parseCandidateMs;
 *   - se MAIS de um candidato válido existir, todos precisam concordar
 *     dentro de TIME_FIELD_CONSISTENCY_TOLERANCE_MS -- divergência além
 *     disso BLOQUEIA a amostra inteira (nunca escolhe um silenciosamente);
 *   - precedência entre os concordantes: `time` (já em ms, mais direto) >
 *     `timeNano` (maior precisão) > `timeSecond` (menor precisão,
 *     truncado ao segundo);
 *   - nenhum candidato válido -> amostra inválida.
 */
function extractServerTimeMs(data) {
  const result = (data && data.result) || {};
  const candidates = [];
  const fromTime = parseCandidateMs(data && data.time, "ms");
  if (fromTime !== null) candidates.push({ source: "time", ms: fromTime });
  const fromNano = parseCandidateMs(result.timeNano, "ns");
  if (fromNano !== null) candidates.push({ source: "timeNano", ms: fromNano });
  const fromSecond = parseCandidateMs(result.timeSecond, "s");
  if (fromSecond !== null) candidates.push({ source: "timeSecond", ms: fromSecond });

  if (candidates.length === 0) return { ok: false };

  if (candidates.length > 1) {
    const values = candidates.map((c) => c.ms);
    const spread = Math.max(...values) - Math.min(...values);
    if (spread > TIME_FIELD_CONSISTENCY_TOLERANCE_MS) {
      return { ok: false, inconsistent: true };
    }
  }

  const chosen = candidates.find((c) => c.source === "time") || candidates.find((c) => c.source === "timeNano") || candidates[0];
  return { ok: true, ms: chosen.ms, source: chosen.source };
}

/**
 * Uma amostra -- t0 (antes)/t1 (depois) medidos localmente, timestamp do
 * servidor extraído da resposta via extractServerTimeMs. Offset = ponto
 * médio (t0+t1)/2 (melhor estimativa de QUANDO o servidor gerou aquele
 * timestamp, técnica NTP-like padrão) menos o timestamp do servidor --
 * positivo quando o relógio local está ADIANTADO. Nunca lança pra quem
 * chama -- qualquer falha (rede, timeout, corpo inválido, campos
 * inconsistentes) vira `{ ok: false }`, nunca derruba as outras amostras.
 */
async function takeSample({ baseUrl, fetchImpl, now }) {
  const t0 = now();
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${TIME_PATH}`, { timeout: REQUEST_TIMEOUT_MS });
  } catch {
    return { ok: false, reason: "network_error" };
  }
  const t1 = now();

  const extracted = extractServerTimeMs(response && response.data);
  if (!extracted.ok) {
    return { ok: false, reason: extracted.inconsistent ? "inconsistent_time_fields" : "invalid_response" };
  }

  const rtt = t1 - t0;
  if (rtt < 0) {
    // t1 < t0 -- só acontece se `now` não for monótono (nunca deveria, mas
    // nunca confia numa medição negativa em vez de assumir sucesso).
    return { ok: false, reason: "invalid_response" };
  }

  const midpoint = (t0 + t1) / 2;
  return { ok: true, rtt, offsetMs: midpoint - extracted.ms, source: extracted.source };
}

/**
 * Ponto de entrada -- resolve normalmente com `{ offsetMedianMs,
 * sampleCount }` se conseguir confirmar sincronização dentro da
 * tolerância; lança ClockSyncBlockedError em QUALQUER outro caso (rede,
 * resposta inválida, campos inconsistentes, amostras insuficientes após
 * descartar RTT ruim, ou offset fora da margem) -- nunca lança nenhum
 * outro tipo de erro. `fetchImpl`/`now`/`sampleCount` injetáveis só pra
 * teste (produção sempre usa `axios.get`/`Date.now`/3, os defaults).
 */
async function assertClockSynced({ baseUrl, fetchImpl = axios.get, now = Date.now, sampleCount = SAMPLE_COUNT } = {}) {
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push(await takeSample({ baseUrl, fetchImpl, now }));
  }

  const validRtt = samples.filter((s) => s.ok && s.rtt <= MAX_RTT_MS);
  if (validRtt.length < MIN_VALID_SAMPLES) {
    const allFailed = samples.every((s) => !s.ok);
    if (allFailed) {
      throw new ClockSyncBlockedError("network_or_invalid_response", `${samples.length}/${samples.length} amostras falharam (rede/resposta inválida/inconsistente)`);
    }
    throw new ClockSyncBlockedError(
      "insufficient_reliable_samples",
      `${validRtt.length}/${samples.length} amostra(s) com RTT<=${MAX_RTT_MS}ms (mínimo exigido: ${MIN_VALID_SAMPLES})`
    );
  }

  const offsetMedianMs = median(validRtt.map((s) => s.offsetMs));
  if (Math.abs(offsetMedianMs) > MAX_OFFSET_MS) {
    throw new ClockSyncBlockedError("offset_exceeds_tolerance", `offset mediano=${Math.round(offsetMedianMs)}ms, tolerância=±${MAX_OFFSET_MS}ms`);
  }

  return { offsetMedianMs, sampleCount: validRtt.length };
}

module.exports = {
  assertClockSynced,
  ClockSyncBlockedError,
  median,
  extractServerTimeMs,
  parseCandidateMs,
  SAMPLE_COUNT,
  MIN_VALID_SAMPLES,
  MAX_OFFSET_MS,
  MAX_RTT_MS,
  REQUEST_TIMEOUT_MS,
  TIME_FIELD_CONSISTENCY_TOLERANCE_MS,
  MIN_PLAUSIBLE_EPOCH_MS,
  MAX_PLAUSIBLE_EPOCH_MS,
};

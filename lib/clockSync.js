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

// RTT acima disso torna a estimativa de offset pouco confiável -- metade de
// um RTT de 300ms (150ms) já é uma fatia grande da margem de 1000ms que
// este módulo tenta proteger; RTTs maiores (rede doméstica ruim, VPN,
// congestionamento) são descartados em vez de usados numa estimativa que
// seria essencialmente um chute. Não é o mesmo número do MAX_OFFSET_MS de
// propósito -- um RTT de "algumas centenas de ms" é razoável pra rede
// doméstica comum, mas um OFFSET de relógio dessa magnitude não é.
const MAX_RTT_MS = 300;

// Timeout curto por amostra -- nunca deixa uma amostra pendurada
// indefinidamente; 3 amostras x 5s no pior caso (todas travando) ainda é um
// tempo finito e curto de boot, nunca um retry sem fim.
const REQUEST_TIMEOUT_MS = 5000;

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
 * Uma amostra -- t0 (antes)/t1 (depois) medidos localmente, timestamp do
 * servidor extraído da resposta. Offset = ponto médio (t0+t1)/2 (melhor
 * estimativa de QUANDO o servidor gerou aquele timestamp, técnica NTP-like
 * padrão) menos o timestamp do servidor -- positivo quando o relógio local
 * está ADIANTADO. Nunca lança pra quem chama -- qualquer falha (rede,
 * timeout, corpo inválido) vira `{ ok: false }`, nunca derruba as outras
 * amostras.
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

  const data = response && response.data;
  const serverTimeMs = data && typeof data.time === "number" ? data.time : NaN;
  if (!Number.isFinite(serverTimeMs) || serverTimeMs <= 0) {
    return { ok: false, reason: "invalid_response" };
  }

  const rtt = t1 - t0;
  if (rtt < 0) {
    // t1 < t0 -- só acontece se `now` não for monótono (nunca deveria, mas
    // nunca confia numa medição negativa em vez de assumir sucesso).
    return { ok: false, reason: "invalid_response" };
  }

  const midpoint = (t0 + t1) / 2;
  return { ok: true, rtt, offsetMs: midpoint - serverTimeMs };
}

/**
 * Ponto de entrada -- resolve normalmente com `{ offsetMedianMs,
 * sampleCount }` se conseguir confirmar sincronização dentro da
 * tolerância; lança ClockSyncBlockedError em QUALQUER outro caso (rede,
 * resposta inválida, amostras insuficientes após descartar RTT ruim, ou
 * offset fora da margem) -- nunca lança nenhum outro tipo de erro.
 * `fetchImpl`/`now`/`sampleCount` injetáveis só pra teste (produção sempre
 * usa `axios.get`/`Date.now`/3, os defaults).
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
      throw new ClockSyncBlockedError("network_or_invalid_response", `${samples.length}/${samples.length} amostras falharam (rede/resposta inválida)`);
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
  SAMPLE_COUNT,
  MIN_VALID_SAMPLES,
  MAX_OFFSET_MS,
  MAX_RTT_MS,
  REQUEST_TIMEOUT_MS,
};

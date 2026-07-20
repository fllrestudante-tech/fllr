// Connectivity Manager -- única fonte de verdade sobre saúde de rede/providers
// da plataforma. Ninguém mais (bot, coletores) deveria reimplementar "será
// que a internet caiu ou só a Bybit está fora" -- só perguntam pro snapshot
// que este módulo publica (ver lib/connectivityStatus.js, o lado de leitura).
//
// Sondas são todas single-shot, sem retry: usar lib/httpRetry.js aqui
// travaria o tick por até ~30-60s (4 tentativas com backoff), o oposto do
// que uma sonda de diagnóstico precisa -- o objetivo é responder rápido
// "está no ar ou não", não insistir.
const net = require("net");
const axios = require("axios");
const config = require("../config");
const bybit = require("./bybit");
const coingecko = require("./coingecko");

const DEFAULT_INTERNET_HOSTS = [
  { host: "1.1.1.1", port: 443 },
  { host: "8.8.8.8", port: 443 },
];

// IPs literais, não hostname -- durante uma queda real, o resolver DNS local
// costuma degradar/travar antes do transporte, o que faria uma sonda baseada
// em dns.resolve() confundir "meu DNS quebrou" com "não tem internet".
function tcpProbe({ host, port, timeoutMs = 3000, connect = net.createConnection }) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);

    function finish(ok) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    }

    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

async function checkInternetReachable({ hosts = DEFAULT_INTERNET_HOSTS, probe = tcpProbe, timeoutMs = 3000 } = {}) {
  const results = await Promise.all(hosts.map((h) => probe({ ...h, timeoutMs })));
  return results.some(Boolean);
}

// Factory genérica -- Bybit/CoinGecko/Telegram só diferem em url/validação,
// não justificam 3 implementações copiadas (mesmo espírito de
// lib/collectors/collectorMetrics.js ser domain-agnostic).
async function checkProviderHealth({ get = axios.get, url, timeoutMs = 3000, validate = () => true }) {
  try {
    const res = await get(url, { timeout: timeoutMs });
    return validate(res) ? { ok: true, error: null } : { ok: false, error: new Error("resposta inesperada") };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function checkBybitHealth({ get, timeoutMs } = {}) {
  return checkProviderHealth({
    get,
    url: `${bybit.BASE_URL}/v5/market/time`,
    timeoutMs,
    validate: (res) => !!(res.data && res.data.retCode === 0),
  });
}

function checkCoinGeckoHealth({ get, timeoutMs } = {}) {
  return checkProviderHealth({
    get,
    url: coingecko.BASE_URL,
    timeoutMs,
    validate: (res) => !!(res.data && res.data.data),
  });
}

// Sem token configurado não é "Telegram fora do ar" -- é "não configurado
// ainda" (TELEGRAM_ALERT_BOT_TOKEN pendente). Não gera falso incidente.
function checkTelegramHealth({ get, timeoutMs, botToken = config.alerts.telegramBotToken } = {}) {
  if (!botToken) return Promise.resolve({ ok: true, error: null, skipped: true });
  return checkProviderHealth({
    get,
    url: `https://api.telegram.org/bot${botToken}/getMe`,
    timeoutMs,
    validate: (res) => !!(res.data && res.data.ok),
  });
}

const DNS_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);

/**
 * Pura, sem I/O. internetOk decide primeiro (é a causa raiz mesmo quando os
 * providers também falhariam por tabela). Um erro de DNS (ENOTFOUND/EAI_AGAIN)
 * em qualquer provider com internet ok indica resolução de nome quebrada
 * especificamente -- todo provider baseado em hostname cairia junto nesse
 * caso, então isso vence sobre apontar um provider individual como culpado.
 */
function classifyConnectivity({ internetOk, providerErrors }) {
  if (!internetOk) return "internet_down";
  const dnsFailed = Object.values(providerErrors).some((err) => err && DNS_ERROR_CODES.has(err.code));
  if (dnsFailed) return "dns_down";
  if (providerErrors.bybit) return "bybit_down";
  if (providerErrors.coingecko) return "coingecko_down";
  if (providerErrors.telegram) return "telegram_down";
  return "ok";
}

const SEVERITY_BY_REASON = {
  internet_down: "HIGH",
  dns_down: "HIGH",
  bybit_down: "HIGH",
  coingecko_down: "MEDIUM",
  telegram_down: "MEDIUM",
};

// Hipótese inicial de severidade, não valor travado -- mesma disciplina já
// aplicada aos pesos do score de oportunidades: ajustável quando houver dado
// real de impacto por tipo de incidente.
function severityForReason(reason) {
  return SEVERITY_BY_REASON[reason] || "MEDIUM";
}

/**
 * Máquina de estado pura do incidente -- não sonda nada, só decide
 * abrir/fechar/manter com base na classificação já computada em cada tick.
 * `consecutiveFailuresToOpen` evita abrir incidente por uma falha isolada
 * (timeout de rede pontual não é uma queda real).
 */
function createConnectivityMonitor({ now = Date.now, consecutiveFailuresToOpen = 2 } = {}) {
  let consecutiveFailures = 0;
  let openIncident = null; // { reason, startedAt }

  function recordCheck(status) {
    const timestamp = now();

    if (status === "ok") {
      consecutiveFailures = 0;
      if (openIncident) {
        const incident = { ...openIncident, endedAt: timestamp, durationMs: timestamp - openIncident.startedAt };
        openIncident = null;
        return { action: "close", incident };
      }
      return { action: "none", incident: null };
    }

    consecutiveFailures++;
    if (openIncident) {
      openIncident.reason = status; // causa pode mudar no meio do incidente -- usa a mais recente conhecida
      return { action: "none", incident: null };
    }
    if (consecutiveFailures >= consecutiveFailuresToOpen) {
      openIncident = { reason: status, startedAt: timestamp };
      return { action: "open", incident: { ...openIncident } };
    }
    return { action: "none", incident: null };
  }

  function getOpenIncident() {
    return openIncident ? { ...openIncident } : null;
  }

  // Cobre o supervisor reiniciar no meio de um incidente já em curso (lido de
  // volta de system_incidents) -- sem isso, um monitor recém-criado "esquece"
  // silenciosamente o incidente aberto e nunca dispararia o alerta de resolução.
  function resumeIncident(incident) {
    openIncident = { reason: incident.reason, startedAt: new Date(incident.startedAt).getTime() };
  }

  return { recordCheck, getOpenIncident, resumeIncident };
}

function defaultFormatTime(ms) {
  return new Date(ms).toISOString().slice(11, 16);
}

const REASON_LABEL = {
  internet_down: "internet",
  dns_down: "DNS",
  bybit_down: "Bybit",
  coingecko_down: "CoinGecko",
  telegram_down: "Telegram",
};

function formatIncidentMessage(incident, { formatTime = defaultFormatTime, resyncSummary = null } = {}) {
  const startedLabel = formatTime(incident.startedAt);
  const endedLabel = formatTime(incident.endedAt);
  const minutes = Math.round(incident.durationMs / 60000);
  const reasonLabel = REASON_LABEL[incident.reason] || incident.reason;
  const suffix = resyncSummary ? `Coleta retomada automaticamente (${resyncSummary}).` : "Coleta retomada automaticamente.";
  return (
    `🔌 Conexão perdida às ${startedLabel} (causa: ${reasonLabel}). ` +
    `Restabelecida às ${endedLabel}. Tempo offline: ${minutes}min. ${suffix}`
  );
}

module.exports = {
  tcpProbe,
  checkInternetReachable,
  checkProviderHealth,
  checkBybitHealth,
  checkCoinGeckoHealth,
  checkTelegramHealth,
  classifyConnectivity,
  severityForReason,
  createConnectivityMonitor,
  formatIncidentMessage,
  DEFAULT_INTERNET_HOSTS,
};

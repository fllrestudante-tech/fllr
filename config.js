require("dotenv").config();

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

function num(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  bybit: {
    apiKey: process.env.BYBIT_API_KEY || "",
    apiSecret: process.env.BYBIT_API_SECRET || "",
    testnet: bool(process.env.BYBIT_TESTNET, false),
    demo: bool(process.env.BYBIT_DEMO, true), // Demo Trading (api-demo.bybit.com) — conta de teste isolada do site principal, precisa de chave gerada nela
    category: "linear", // USDT Perpétuo
  },

  symbol: process.env.SYMBOL || "SOLUSDT",
  interval: process.env.INTERVAL || "1",

  leverageMax: num(process.env.LEVERAGE_MAX, 5),
  riskPerTradePct: num(process.env.RISK_PER_TRADE_PCT, 0.01),
  dailyLossLimitPct: num(process.env.DAILY_LOSS_LIMIT_PCT, 0.05),
  targetReturnPerTradePct: num(process.env.TARGET_RETURN_PER_TRADE_PCT, 0.06),

  backtestIntervalHours: num(process.env.BACKTEST_INTERVAL_HOURS, 6),
  healthCheckIntervalMs: num(process.env.HEALTH_CHECK_INTERVAL_MS, 60000),

  alerts: {
    telegramBotToken: process.env.TELEGRAM_ALERT_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_ALERT_CHAT_ID || "",
  },

  knowledge: {
    coinMarketCalApiKey: process.env.COINMARKETCAL_API_KEY || "",
    fredApiKey: process.env.FRED_API_KEY || "",
  },

  // SLA Registry (Runtime Metrics Engine, Fase B) -- expectedIntervalMs é de
  // quanto em quanto tempo esse domínio deveria produzir dado novo; provider
  // agrupa domínios da mesma fonte externa pro API Health. Domínio não
  // listado aqui cai em defaultExpectedIntervalMs automaticamente (cobre
  // providers novos do Knowledge Collector sem precisar editar isto).
  sla: {
    defaultExpectedIntervalMs: 60 * 60 * 1000,
    toleranceMultiplier: 2,
    domains: {
      candles: { expectedIntervalMs: 60 * 1000, provider: "bybit" },
      // funding: o coletor faz poll a cada 5min, mas o Bybit só assenta um
      // funding rate NOVO a cada 8h (00:00/08:00/16:00 UTC) -- confirmado
      // contra o market.db real (delta constante de 8h entre linhas). Usar
      // o intervalo de poll aqui fazia o Coverage Score reportar 0% mesmo
      // com o coletor saudável -- achado real via lib/dataCoverage.js.
      funding: { expectedIntervalMs: 8 * 60 * 60 * 1000, provider: "bybit" },
      open_interest: { expectedIntervalMs: 5 * 60 * 1000, provider: "bybit" },
      ticker: { expectedIntervalMs: 60 * 1000, provider: "bybit" },
      long_short_ratio: { expectedIntervalMs: 5 * 60 * 1000, provider: "bybit" },
      fear_greed: { expectedIntervalMs: 24 * 60 * 60 * 1000, provider: "fear_greed" },
      btc_dominance: { expectedIntervalMs: 60 * 60 * 1000, provider: "coingecko" },
      coinmarketcal: { expectedIntervalMs: 60 * 60 * 1000, provider: "coinmarketcal" },
      fred: { expectedIntervalMs: 24 * 60 * 60 * 1000, provider: "fred" },
      fomc_calendar: { expectedIntervalMs: 24 * 60 * 60 * 1000, provider: "fomc_calendar" },
    },
  },

  // Limites dentro dos quais o auto-tuning (lib/backtest.js) pode variar parâmetros.
  // Isso impede que o ajuste automático "invente" uma estratégia totalmente diferente.
  tuningBounds: {
    emaShort: { min: 5, max: 12 },
    emaLong: { min: 40, max: 80 },
    rsiPeriod: { min: 10, max: 21 },
    stochOversold: { min: 10, max: 30 },
    stochOverbought: { min: 70, max: 90 },
    stopLossPct: { min: 0.03, max: 0.03 }, // fixo em 3% do preço de entrada (min=max desativa a variação do auto-tuning)
  },

  loopIntervalMs: 10000,
  loopMaxDelayMs: num(process.env.LOOP_MAX_DELAY_MS, 120000), // teto do backoff do loop durante falhas consecutivas (lib/backoff.js)
  cooldownMs: 60000,

  paths: {
    dataDir: __dirname + "/data",
    stateFile: __dirname + "/data/state.json",
    tuningFile: __dirname + "/data/tuning.json",
    tradesLog: __dirname + "/data/trades.jsonl",
    alertsLog: __dirname + "/data/alerts.jsonl",
  },
};

if (!config.bybit.apiKey || !config.bybit.apiSecret) {
  console.warn(
    "⚠️  BYBIT_API_KEY / BYBIT_API_SECRET não configurados no .env — o bot não vai conseguir autenticar na Bybit."
  );
}

module.exports = config;

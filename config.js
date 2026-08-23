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

const KNOWN_AI_PROVIDERS = new Set(["agentrouter", "anthropic", "openai"]);

/**
 * Puro -- decide a ordem de fallback dos providers de IA a partir do env.
 * AI_PROVIDER_ORDER (explícito) tem precedência; ausente/vazio cai pro par
 * legado AI_PRIMARY_PROVIDER/AI_SECONDARY_PROVIDER (preservado, nunca
 * removido). Dedupe preserva a primeira ocorrência. Provider fora de
 * {agentrouter, anthropic, openai} lança erro claro. AI_PROVIDER_ORDER
 * setada mas sem nenhuma entrada válida (ex: ",,,") lança em vez de
 * desligar a IA inteira sem avisar ninguém.
 */
function parseProviderOrder(env = {}) {
  const explicitRaw = typeof env.AI_PROVIDER_ORDER === "string" ? env.AI_PROVIDER_ORDER.trim() : "";

  const source = explicitRaw
    ? explicitRaw.split(",")
    : [env.AI_PRIMARY_PROVIDER || "anthropic", env.AI_SECONDARY_PROVIDER || "openai"];

  const candidates = source.map((value) => String(value).trim()).filter(Boolean);

  if (explicitRaw && candidates.length === 0) {
    throw new Error("AI_PROVIDER_ORDER: nenhuma entrada válida informada");
  }

  const order = [];
  for (const name of candidates) {
    if (!KNOWN_AI_PROVIDERS.has(name)) {
      throw new Error(`AI_PROVIDER_ORDER: provider desconhecido "${name}" -- válidos: ${[...KNOWN_AI_PROVIDERS].join(", ")}`);
    }
    if (!order.includes(name)) order.push(name);
  }

  if (order.length === 0) {
    throw new Error("AI_PROVIDER_ORDER: nenhuma entrada válida informada");
  }

  return order;
}

const AI_PROVIDER_ORDER = parseProviderOrder(process.env);

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

  // Fase D1 (Exit Engine) -- tempo máximo que uma posição pode ficar aberta
  // antes do bot fechar a mercado, independente de sinal/SL/TP. Default =
  // 120 candles de 1min (120min), mesmo valor que lib/backtest.js::simulate()
  // já assumia como MAX_HOLD_CANDLES desde sempre -- portar pro live não é
  // um número novo, é fechar uma divergência de fidelidade backtest↔produção.
  maxHoldMinutes: num(process.env.MAX_HOLD_MINUTES, 120),

  // Fase D2 (Circuit Breaker) -- pausa novas entradas quando qualquer um dos
  // 3 gatilhos disparar: sequência de perdas, drawdown diário elevado (menor
  // que o dailyLossLimitPct "duro" abaixo, serve de aviso antes dele) ou
  // volatilidade extrema (lib/volatilityRegime.js). Não fecha posição já
  // aberta, só bloqueia lib/risk.js::canExecute.
  circuitBreakerLossStreak: num(process.env.CIRCUIT_BREAKER_LOSS_STREAK, 3),
  circuitBreakerPauseMs: num(process.env.CIRCUIT_BREAKER_PAUSE_MS, 6 * 60 * 60 * 1000),
  circuitBreakerDailyDrawdownPct: num(process.env.CIRCUIT_BREAKER_DAILY_DRAWDOWN_PCT, 0.03),
  circuitBreakerOnHighVolatility: bool(process.env.CIRCUIT_BREAKER_ON_HIGH_VOLATILITY, true),

  // Fase D4 (Trailing ATR adaptativo) -- distância do trailing = ATR(14) na
  // ativação × multiplicador, variando pelo mesmo regime de volatilidade do
  // circuit breaker (lib/volatilityRegime.js). Só ativa depois do break even
  // (D3), com activePrice calculado pra nunca deixar o piso do trailing pior
  // que a entrada -- ver index.js::applyTrailingStop.
  trailingStopAtrMultiplier: {
    low: num(process.env.TRAILING_ATR_MULTIPLIER_LOW, 1.5),
    normal: num(process.env.TRAILING_ATR_MULTIPLIER_NORMAL, 2),
    high: num(process.env.TRAILING_ATR_MULTIPLIER_HIGH, 3),
  },

  // Fase D5 (TP Escalonado) -- níveis em array, não hardcoded, pra testar
  // splits diferentes (20/30/50, 40/30/30...) só mudando config, sem
  // recompilar nada. `r` é múltiplo de R (distância do stop original,
  // mesma unidade do break even/trailing); `qtyPct` é a fração da posição
  // fechada nesse nível. Com stopLossPct=2,5%, r=1.2/2.4/3.6 equivalem a
  // ~3%/6%/9% de movimento de preço a partir da entrada (decisão do
  // usuário, 2026-08-11). `closeRemainder: true` no último nível faz
  // lib/risk.js::planOrder atribuir a ele o que sobrou do qty total (em vez
  // de qtyPct×qty), garantindo que a posição feche 100% nesse nível sem
  // deixar sobra por arredondamento de qtyStep -- antes só 60% tinha TP fixo
  // e o resto corria indefinidamente em break even/trailing (D3/D4); agora
  // o trailing ainda protege o que estiver aberto ANTES de bater cada nível,
  // mas o fechamento final da operação é garantido em ~9%. Confirmado contra
  // a API real da Bybit (Demo): TP parciais (tpslMode="Partial") coexistem
  // sem conflito com o trailingStop na mesma posição.
  tpLevels: [
    { r: 1.2, qtyPct: 0.3 }, // TP1 ~3%
    { r: 2.4, qtyPct: 0.3 }, // TP2 ~6% (acumulado 60%)
    { r: 3.6, qtyPct: 0.4, closeRemainder: true }, // TP3 ~9% -- fecha a operação inteira
  ],

  // Item 1 do sequenciamento de Brains: lib/backtest.js passa a preferir
  // candles já persistidos em data/market.db em vez de só buscar 1000 ao
  // vivo da Bybit a cada rodada. lookbackDays limita o tamanho da consulta
  // conforme o banco cresce ao longo de meses (sem isso, a query SELECT
  // fica maior a cada dia que o coletor roda).
  backtestDbLookbackDays: num(process.env.BACKTEST_DB_LOOKBACK_DAYS, 30),

  // Structure Brain (swings/BOS/CHOCH) -- lookback configurável desde o
  // início porque o futuro Replay Engine vai querer comparar 3/5/7/9
  // candles de cada lado do fractal, não travado num valor só.
  // equalTolerancePct/sweepReversalLookahead são do Liquidity Brain (mesmos
  // swings, módulo de leitura diferente). exhaustionLookback é do FVG Brain
  // (reaproveitado pelo Order Block Brain também -- mesmo conceito de
  // "rompido há tempo demais sem atividade = já era"). confirmAge/
  // mitigationThreshold são do Order Block Brain -- candles pra um bloco
  // sobreviver antes de virar CONFIRMED, e % da zona "comida" antes de
  // virar MITIGATED (hipóteses documentadas, não validadas por backtest).
  structure: {
    lookback: num(process.env.STRUCTURE_LOOKBACK, 5),
    equalTolerancePct: num(process.env.STRUCTURE_EQUAL_TOLERANCE_PCT, 0.1),
    sweepReversalLookahead: num(process.env.STRUCTURE_SWEEP_LOOKAHEAD, 10),
    exhaustionLookback: num(process.env.STRUCTURE_EXHAUSTION_LOOKBACK, 50),
    confirmAge: num(process.env.STRUCTURE_CONFIRM_AGE, 3),
    mitigationThreshold: num(process.env.STRUCTURE_MITIGATION_THRESHOLD, 0.5),
  },

  // Replay Engine -- percorre o market.db candle a candle (em passos),
  // roda todos os Brains, espera outcomeHorizonCandles pra medir o que o
  // preço fez de verdade e julgar SUCCESS/FAIL contra a direção fundida
  // do Context Fusion. stepCandles evita processar/duplicar leitura a
  // cada 1min (janelas consecutivas se sobrepõem quase inteiras);
  // windowCandles limita o custo de cada passo (Structure/Liquidity/FVG/
  // Order Block não precisam do histórico inteiro pra decidir o que
  // importa agora). outcomeThresholdPct é hipótese, não validada -- é
  // exatamente o tipo de número que este motor existe pra calibrar no
  // futuro, não pra assumir certo de saída.
  replay: {
    stepCandles: num(process.env.REPLAY_STEP_CANDLES, 15),
    windowCandles: num(process.env.REPLAY_WINDOW_CANDLES, 1500),
    outcomeHorizonCandles: num(process.env.REPLAY_OUTCOME_HORIZON_CANDLES, 30),
    outcomeThresholdPct: num(process.env.REPLAY_OUTCOME_THRESHOLD_PCT, 0.3),
    lookbackDays: num(process.env.REPLAY_LOOKBACK_DAYS, 365),
    // Brain Analytics -- critério objetivo de amostra mínima antes do
    // Decision Brain poder nascer (número dado pelo próprio usuário).
    minSnapshotsForDecisionBrain: num(process.env.REPLAY_MIN_SNAPSHOTS_FOR_DECISION_BRAIN, 20000),
  },

  alerts: {
    telegramBotToken: process.env.TELEGRAM_ALERT_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_ALERT_CHAT_ID || "",
  },

  // Dashboard Operacional Web -- servidor HTTP nativo, só leitura, nunca
  // chama a Bybit (ver scripts/dashboardServer.js).
  dashboard: {
    port: num(process.env.DASHBOARD_PORT, 4300),
  },

  knowledge: {
    coinMarketCalApiKey: process.env.COINMARKETCAL_API_KEY || "",
    fredApiKey: process.env.FRED_API_KEY || "",
  },

  // AI Gateway (Fase 1 + integração com o loop de trading, 2026-08-11) --
  // enriquecimento de contexto via IA. Participa da análise a cada ciclo
  // (index.js::cycle(), via lib/aiGateway/decisionCyclePolicy.js), mas em
  // SHADOW MODE: só gera e audita um AI Assessment, nunca chama
  // lib/risk.js/openPosition/closePosition (ver README de segurança no
  // topo de index.js::maybeRunAiAssessment). primaryProvider/secondaryProvider
  // definem a ordem de fallback sequencial (nunca fan-out simultâneo).
  ai: {
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    // Migração pra gpt-5.6-luna (decisão do usuário, 2026-08-13, após teste
    // real comparativo contra gpt-4o-mini -- ver commit deste arquivo):
    // análise qualitativamente mais rica e mais aderente às regras
    // explícitas do prompt, aceita como custo absoluto (~$0,0017/chamada
    // observado, ainda muito barato em termos absolutos). gpt-4o-mini
    // continua na tabela de pricing abaixo só pra resolver custo de
    // chamadas históricas já gravadas no log antes desta migração --
    // nenhuma chamada nova usa esse model a menos que OPENAI_MODEL
    // sobrescreva isso no .env.
    openaiModel: process.env.OPENAI_MODEL || "gpt-5.6-luna",
    // gpt-5.x (família reasoning, sucessora do o-series) não aceita
    // temperature customizada -- só reasoning_effort. Confirmado por teste
    // real: gpt-5.6-luna respondeu 400 "Unsupported value" pra
    // temperature:0.2. "none" reproduz a config do teste manual aprovado
    // (evita gastar tokens de raciocínio ocultos numa tarefa que já é
    // estruturada por schema). Ver lib/openaiClient.js::isReasoningFamily.
    openaiReasoningEffort: process.env.OPENAI_REASONING_EFFORT || "none",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    // Haiku 3.5 foi retirado da Claude API de primeira parte.
    // Default atualizado para um modelo disponível no catálogo da conta.
    anthropicModel: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
    // Sem AI_PROVIDER_ORDER, preserva o comportamento legado:
    // anthropic -> openai.
    // Na ativação operacional aprovada em 2026-08-15:
    // agentrouter -> anthropic -> openai.
    //
    // providerOrder substitui os 2 slots fixos por uma lista. AI_PROVIDER_ORDER
    // (explícito) tem precedência sobre AI_PRIMARY_PROVIDER/AI_SECONDARY_PROVIDER
    // (legado, preservado). Ver parseProviderOrder() no topo deste arquivo.
    providerOrder: AI_PROVIDER_ORDER,
    primaryProvider: AI_PROVIDER_ORDER[0] || null,
    secondaryProvider: AI_PROVIDER_ORDER[1] || null,

    // AgentRouter -- transporte via subprocesso Codex CLI
    // (lib/agentrouterClient.js), não HTTP direto (comprovado nesta
    // integração: só o cliente Codex oficial autentica). Só o que o
    // subprocesso de fato usa -- a API key NUNCA é lida aqui nem em nenhum
    // outro lugar do processo do bot; autenticação mora exclusivamente em
    // ~/.codex/config.toml, que o próprio Codex CLI acha sozinho
    // (USERPROFILE/HOME). Modelo validado nos testes desta integração
    // (2026-08-14/15): gpt-5.6-sol.
    agentRouterModel: process.env.AGENTROUTER_MODEL || "gpt-5.6-sol",
    agentRouterCodexCommand: process.env.AGENTROUTER_CODEX_COMMAND || "codex",
    agentRouterTimeoutMs: num(process.env.AGENTROUTER_TIMEOUT_MS, 60000),
    agentRouterGracefulShutdownMs: num(process.env.AGENTROUTER_GRACEFUL_SHUTDOWN_MS, 5000),

    requestTimeoutMs: num(process.env.AI_REQUEST_TIMEOUT_MS, 20000),
    // 500 -> 2000 (2026-08-13): gpt-5.6-luna produz respostas bem mais
    // analíticas (986 tokens observados no teste real, vs ~300-350 do
    // gpt-4o-mini) -- 500 arriscava truncar o JSON no meio (parseError
    // silencioso). 2000 é ~2x o maior valor observado, ainda um teto real
    // contra resposta anormalmente longa, não "sem limite".
    maxOutputTokens: num(process.env.AI_MAX_OUTPUT_TOKENS, 2000),

    // Fase 2 (AI Shadow Evaluation) -- cadência do scripts/aiShadowEvaluator.js,
    // standalone, não conectado ao loop de trading. Default = mesma janela
    // "slow tier" que scripts/metricsSampler.js já usa pra computar os 3
    // Brains + Context Fusion. Reaproveitado também como teto (heartbeat) do
    // AI Decision Cycle abaixo, pra manter uma única noção de cadência lenta
    // no projeto em vez de duas configs quase-iguais.
    shadowIntervalMs: num(process.env.AI_SHADOW_INTERVAL_MS, 15 * 60 * 1000),

    // AI Decision Cycle (lib/aiGateway/decisionCyclePolicy.js) -- piso de
    // tempo entre chamadas de IA disparadas pelo loop de trading (10s),
    // mesmo com sinal quantitativo (buy/sell) se repetindo tick a tick.
    // Existe só pra controlar custo -- sem isso, um sinal "buy" bloqueado
    // por cooldown/circuit breaker pagaria uma chamada nova a cada 10s.
    minCallIntervalMs: num(process.env.AI_MIN_CALL_INTERVAL_MS, 5 * 60 * 1000),

    // Custo real (lib/aiGateway/costMetrics.js, AI_COST_ESTIMATE_24H/30D) --
    // preço por 1 milhão de tokens. gpt-4o-mini verificado em 2026-08-11;
    // gpt-5.6-luna verificado em 2026-08-13 (fonte: OpenAI pricing page,
    // corte de 80% em 30/07/2026 -- preço padrão novo, não promoção
    // temporária); Anthropic claude-3-5-haiku verificado em 2026-08-11
    // (retirada da Claude API confirmada em 2026-08-14 -- ver comentário de
    // anthropicModel acima -- preço preservado só pra custo de chamadas
    // históricas); Anthropic claude-haiku-4-5 verificado em 2026-08-14
    // (fonte: platform.claude.com/docs/en/about-claude/pricing, tabela
    // "Model pricing"). Hipótese documentada, não travada pra sempre -- se o
    // provider mudar o preço, atualizar aqui (não há API pra consultar
    // preço em tempo real). Chave = prefixo do nome do modelo (casa contra
    // o model versionado que o provider devolve, ex: "gpt-4o-mini-2024-07-18").
    // gpt-4o-mini e claude-3-5-haiku permanecem aqui só pra resolver o custo
    // de chamadas históricas já gravadas no log antes de cada migração --
    // nenhum dos dois é o model usado por padrão hoje (ver openaiModel/
    // anthropicModel acima).
    // cachedInputPer1M só é usado quando o provider extrai separadamente os
    // tokens servidos do cache. O provider Anthropic atual ainda não expõe
    // cachedTokens ao costMetrics; por isso as entradas Anthropic omitem esse
    // campo e todo input observado é estimado conservadoramente como entrada
    // normal. O suporte a cache será tratado em mudança separada.
    pricing: {
      openai: {
        "gpt-4o-mini": { inputPer1M: 0.15, cachedInputPer1M: 0.075, outputPer1M: 0.6 },
        "gpt-5.6-luna": { inputPer1M: 0.2, cachedInputPer1M: 0.02, outputPer1M: 1.2 },
      },
      anthropic: {
        "claude-3-5-haiku": { inputPer1M: 0.8, outputPer1M: 4.0 },
        "claude-haiku-4-5": { inputPer1M: 1.0, outputPer1M: 5.0 },
      },
    },
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
    stopLossPct: { min: 0.025, max: 0.025 }, // fixo em 2,5% do preço de entrada (min=max desativa a variação do auto-tuning)
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
    aiAssessmentsLog: __dirname + "/data/ai-assessments.jsonl",
  },
};

if (!config.bybit.apiKey || !config.bybit.apiSecret) {
  console.warn(
    "⚠️  BYBIT_API_KEY / BYBIT_API_SECRET não configurados no .env — o bot não vai conseguir autenticar na Bybit."
  );
}

if (!config.ai.openaiApiKey && !config.ai.anthropicApiKey) {
  console.warn(
    "⚠️  Nenhuma chave de IA configurada (OPENAI_API_KEY / ANTHROPIC_API_KEY) — AI Gateway ficará indisponível (infra de enriquecimento ainda não conectada ao loop, não bloqueia o bot)."
  );
}

Object.defineProperty(config, "parseProviderOrder", {
  value: parseProviderOrder,
  enumerable: false,
});

module.exports = config;

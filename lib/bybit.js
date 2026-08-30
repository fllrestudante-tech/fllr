const crypto = require("crypto");
const axios = require("axios");
const config = require("../config");
const { withRetry } = require("./httpRetry");
const { isTradingExecutionEnabled, assertTradingExecutionEnabled, TradingExecutionBlockedError } = require("./tradingExecutionGate");
const { resolveSupervisorProfile } = require("./supervisorProfile");
const demoTradingGate = require("./demoTradingGate");
const { DEMO_PROFILE_NAME } = demoTradingGate;
const demoOrderGate = require("./demoOrderGate");
const demoOrderLedger = require("./demoOrderLedger");
const decimal = require("./decimalSafety");

// BASE_URL (calculado uma vez, no require, a partir de config.js::bool()
// permissivo) continua existindo SÓ pros endpoints PÚBLICOS (sem
// autenticação -- getInstrumentInfo/getKlines/getTickers/etc.), onde
// resolver o destino errado não move dinheiro nenhum, só dado de
// mercado. TODA chamada PRIVADA (privateGet/privatePost) NUNCA usa esta
// constante -- resolve o endpoint de novo, estritamente, a cada chamada
// (ver resolvePrivateBaseUrl) -- Bloqueador 8: BASE_URL fixo no require()
// não poderia refletir uma mudança de env em runtime nem ser validado
// contra o perfil atual no momento exato da chamada.
const BASE_URL = config.bybit.demo
  ? "https://api-demo.bybit.com"
  : config.bybit.testnet
  ? "https://api-testnet.bybit.com"
  : "https://api.bybit.com";

const RECV_WINDOW = "5000";

/**
 * Resolução ESTRITA do endpoint privado, recalculada em CADA chamada
 * (nunca cacheada) -- delega inteiramente a
 * lib/demoTradingGate.js::resolveStrictBaseUrl (comparação === "true"/
 * "false", nunca o bool() permissivo de config.js). O valor devolvido
 * aqui é usado, sem nenhuma transformação, tanto pra montar a URL do
 * Axios quanto (implicitamente, via lib/demoTradingGate.js::validateDemoBoot)
 * pra validar que o perfil demo está de fato batendo pro endpoint de
 * Demo -- as duas checagens usam a MESMA função, nunca podem divergir.
 */
function resolvePrivateBaseUrl(env = process.env) {
  return demoTradingGate.resolveStrictBaseUrl(env);
}

function buildQueryString(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function sign(payloadString, timestamp) {
  const raw = timestamp + config.bybit.apiKey + RECV_WINDOW + payloadString;
  return crypto.createHmac("sha256", config.bybit.apiSecret).update(raw).digest("hex");
}

// =====================================================================
// Autorização -- DUAS capacidades distintas (Bloqueador 2):
//   leitura privada demo  != mutação financeira demo.
// TRADING_EXECUTION_ENABLED continua sendo o gate mais forte (autoriza
// QUALQUER chamada privada, leitura ou mutação, em QUALQUER perfil --
// comportamento 100% preservado, nenhum teste existente quebra). O que
// muda é que, especificamente no perfil demo, uma LEITURA agora TAMBÉM
// pode ser autorizada por um caminho mais estreito
// (DEMO_PRIVATE_READ_ENABLED="true") que NUNCA por si só habilita
// mutação -- mutação sempre exige TRADING_EXECUTION_ENABLED=true E,
// quando o perfil é demo, também o gate canônico de ordem
// (lib/demoOrderGate.js::assertDemoOrderAllowed).
// =====================================================================

function resolveProfileSafely(env) {
  try {
    return resolveSupervisorProfile(env);
  } catch {
    return null; // perfil não reconhecido -- não é responsabilidade deste módulo relançar isso (index.js/supervisor.js já fazem isso no boot)
  }
}

/** Chamado no topo de toda LEITURA privada (privateGet). */
function assertPrivateReadAuthorized(env = process.env) {
  if (isTradingExecutionEnabled(env)) return; // gate forte já cobre leitura, comportamento pré-existente 100% preservado
  const profile = resolveProfileSafely(env);
  if (profile === DEMO_PROFILE_NAME) {
    demoOrderGate.assertDemoPrivateReadAllowed(env); // lança se endpoint/credenciais/DEMO_PRIVATE_READ_ENABLED não baterem
    return;
  }
  throw new TradingExecutionBlockedError();
}

/**
 * Chamado no topo de toda MUTAÇÃO privada (privatePost). `opName` é o
 * nome exato da função pública deste módulo que está chamando (ex.:
 * "placeOrder") -- usado pro gate canônico classificar e validar a
 * operação. `gateParams` são os campos TIPADOS (string decimal/boolean,
 * nunca number -- ver lib/decimalSafety.js) que o gate precisa pra
 * classificar e validar -- nunca o `body` já serializado pro Bybit.
 *
 * Bloqueador 7: TRADING_EXECUTION_ENABLED=true NUNCA é suficiente sozinho
 * pra autorizar mutação, em NENHUM perfil -- inclusive fora do perfil
 * demo. lib/demoOrderGate.js::assertDemoOrderAllowed já bloqueia
 * incondicionalmente (DEMO_ORDER_WRONG_PROFILE) qualquer perfil diferente
 * de "demo", então chamá-lo SEMPRE (nunca condicionalmente por perfil)
 * garante que toda mutação financeira, em qualquer perfil -- safe,
 * ausente, inválido, testnet, mainnet ou demo -- passa pela MESMA porta
 * única, sem exceção e sem early-return por profile.
 *
 * Assinatura sem nenhum parâmetro de override (Bloqueador 2) -- nenhum
 * chamador, produção ou teste, consegue trocar caminho de kill
 * switch/ledger/snapshot/clock passando algo aqui.
 */
function assertPrivateMutationAuthorized(env, opName, gateParams) {
  assertTradingExecutionEnabled(env); // gate forte -- ainda exigido como camada adicional, mas nunca mais suficiente sozinho
  return demoOrderGate.assertDemoOrderAllowed({ env, opName, params: gateParams, now: Date.now() });
}

function authHeaders(payloadString) {
  const timestamp = Date.now().toString();
  return {
    "X-BAPI-API-KEY": config.bybit.apiKey,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    "X-BAPI-SIGN": sign(payloadString, timestamp),
    "Content-Type": "application/json",
  };
}

// fn é re-executada do zero a cada tentativa de retry (dentro de withRetry) —
// necessário porque timestamp/assinatura HMAC só são válidos por RECV_WINDOW.
// `opName` -- usado só pra registrar o resultado real (sucesso/falha) no
// rastreador de erros consecutivos do perfil demo (lib/demoOrderLedger.js) --
// nunca afeta a autorização de leitura em si (essa já foi decidida em
// assertPrivateReadAuthorized, ANTES do retry/rede). Endpoint resolvido
// ESTRITAMENTE aqui, a cada chamada (Bloqueador 8) -- a mesma `url`
// calculada é a que o Axios efetivamente recebe, sem nenhum passo
// intermediário que possa divergir.
async function privateGet(path, params = {}, opName = null) {
  assertPrivateReadAuthorized(); // bloqueia ANTES de qualquer request -- ver comentário acima (puro env, sem caminho de arquivo pra injetar)
  const baseUrl = resolvePrivateBaseUrl(process.env);
  try {
    const result = await withRetry(async () => {
      const qs = buildQueryString(params);
      const headers = authHeaders(qs);
      const url = qs ? `${baseUrl}${path}?${qs}` : `${baseUrl}${path}`;
      const { data } = await axios.get(url, { headers });
      if (data.retCode !== 0) {
        throw new Error(`Bybit ${path} retCode=${data.retCode} ${data.retMsg}`);
      }
      return data.result;
    });
    recordDemoOutcomeIfApplicable(true, opName);
    return result;
  } catch (err) {
    recordDemoOutcomeIfApplicable(false, opName);
    throw err;
  }
}

/**
 * `gateParams` -- campos TIPADOS (string decimal/boolean, nunca number)
 * usados pra classificação/limites do perfil demo
 * (lib/demoOrderGate.js) -- nunca o `body` já serializado em string pro
 * Bybit. Chamado incondicionalmente pra QUALQUER perfil (Bloqueador 7) --
 * é assertPrivateMutationAuthorized/demoOrderGate quem decide bloquear.
 * Endpoint resolvido ESTRITAMENTE aqui, a cada chamada (Bloqueador 8).
 */
async function privatePost(path, body = {}, opName = null, gateParams = {}) {
  assertPrivateMutationAuthorized(process.env, opName, gateParams); // bloqueia ANTES de qualquer request -- gate forte + gate canônico de ordem, sempre
  const baseUrl = resolvePrivateBaseUrl(process.env);
  try {
    const result = await withRetry(async () => {
      const bodyString = JSON.stringify(body);
      const headers = authHeaders(bodyString);
      const { data } = await axios.post(`${baseUrl}${path}`, bodyString, { headers });
      if (data.retCode !== 0) {
        throw new Error(`Bybit ${path} retCode=${data.retCode} ${data.retMsg}`);
      }
      return data.result;
    });
    recordDemoOutcomeIfApplicable(true, opName);
    return result;
  } catch (err) {
    recordDemoOutcomeIfApplicable(false, opName);
    throw err;
  }
}

/**
 * No-op fora do perfil demo -- nunca lança (telemetria, não autorização).
 * Sempre usa o caminho REAL de lib/demoOrderLedger.js (nunca um override
 * de caminho vindo de fora -- Bloqueador 2); testes que precisam isolar
 * isto usam t.mock.method(demoOrderLedger, "recordPrivateCallOutcome", ...)
 * ou um runtime relocado via CRYPTO10_DEMO_RUNTIME_DIR em subprocesso.
 */
function recordDemoOutcomeIfApplicable(success, opName) {
  try {
    if (resolveProfileSafely(process.env) !== DEMO_PROFILE_NAME) return;
    demoOrderLedger.recordPrivateCallOutcome(demoOrderLedger.DEFAULT_OUTCOMES_PATH, { success, context: opName });
  } catch {
    // nunca deixa telemetria derrubar uma chamada real que já terminou
  }
}

// -------- Público (sem autenticação) --------

const instrumentInfoCache = {};

/**
 * Metadata do instrumento incompleta/inválida -- NUNCA devolve `null`
 * silencioso pra um campo obrigatório (Rodada 5, item 1). Um campo
 * ausente/vazio/malformado aqui significa que o resto do código (gate de
 * risco, cálculo de notional/exposição) não tem como validar a ordem com
 * segurança -- lançar é o único comportamento aceitável.
 */
class InstrumentInfoError extends Error {
  constructor(symbol, field, detail) {
    super(`Metadata do instrumento ${symbol} inválida/ausente: ${field} -- ${detail}`);
    this.name = this.constructor.name;
    this.code = "INSTRUMENT_INFO_INVALID";
    this.field = field;
  }
}

/** Valida um campo decimal obrigatório e devolve a STRING original da Bybit -- nunca Number/parseFloat. */
function requireInstrumentDecimalField(raw, field, symbol) {
  if (raw === undefined || raw === null || raw === "") {
    throw new InstrumentInfoError(symbol, field, "ausente");
  }
  try {
    decimal.parseStrictDecimal(raw, field); // só valida o formato -- devolve a string ORIGINAL abaixo, não a normalizada
  } catch (err) {
    throw new InstrumentInfoError(symbol, field, `formato inválido (${err.message})`);
  }
  return String(raw);
}

// qtyStep/tickSize/minOrderQty/maxOrderQty/maxMktOrderQty/minPrice/
// maxPrice/minNotionalValue ficam TODOS como string (precisão original da
// Bybit) -- arredondar/converter pra Number perde casas decimais e
// reintroduz exatamente o erro de ponto flutuante que
// lib/decimalSafety.js existe pra eliminar, além de já ter causado o erro
// "Qty invalid"/"Price invalid" historicamente.
async function getInstrumentInfo(symbol = config.symbol) {
  if (instrumentInfoCache[symbol]) return instrumentInfoCache[symbol];
  return withRetry(async () => {
    const qs = buildQueryString({ category: config.bybit.category, symbol });
    const { data } = await axios.get(`${BASE_URL}/v5/market/instruments-info?${qs}`);
    if (data.retCode !== 0) {
      throw new Error(`Bybit getInstrumentInfo retCode=${data.retCode} ${data.retMsg}`);
    }
    const info = data.result.list[0];
    if (!info) throw new InstrumentInfoError(symbol, "symbol", "símbolo não encontrado na resposta da Bybit");
    const lot = info.lotSizeFilter || {};
    const price = info.priceFilter || {};
    const parsed = {
      symbol: info.symbol || symbol,
      qtyStep: requireInstrumentDecimalField(lot.qtyStep, "qtyStep", symbol),
      minOrderQty: requireInstrumentDecimalField(lot.minOrderQty, "minOrderQty", symbol),
      maxOrderQty: requireInstrumentDecimalField(lot.maxOrderQty, "maxOrderQty", symbol),
      maxMktOrderQty: requireInstrumentDecimalField(lot.maxMktOrderQty, "maxMktOrderQty", symbol),
      tickSize: requireInstrumentDecimalField(price.tickSize, "tickSize", symbol),
      minPrice: requireInstrumentDecimalField(price.minPrice, "minPrice", symbol),
      maxPrice: requireInstrumentDecimalField(price.maxPrice, "maxPrice", symbol),
      minNotionalValue: requireInstrumentDecimalField(lot.minNotionalValue, "minNotionalValue", symbol),
    };
    instrumentInfoCache[symbol] = parsed;
    return parsed;
  });
}

// {start,end} (ms epoch) são opcionais -- Bybit v5 já aceita nativamente,
// nunca foram usados aqui até o backfill (lib/backfill.js) precisar
// re-buscar um intervalo específico perdido durante uma queda de conectividade.
async function getKlines(symbol = config.symbol, interval = config.interval, limit = 500, { start, end } = {}) {
  return withRetry(async () => {
    const qs = buildQueryString({ category: config.bybit.category, symbol, interval, limit, start, end });
    const { data } = await axios.get(`${BASE_URL}/v5/market/kline?${qs}`);
    if (data.retCode !== 0) {
      throw new Error(`Bybit getKlines retCode=${data.retCode} ${data.retMsg}`);
    }
    // Bybit retorna mais recente primeiro — inverter para ficar cronológico como o resto do código espera
    // list item: [startTime, open, high, low, close, volume, turnover]
    return data.result.list
      .slice()
      .reverse()
      .map((c) => [Number(c[0]), c[1], c[2], c[3], c[4], c[5]]);
  });
}

async function getFundingHistory(symbol = config.symbol, limit = 1, { start, end } = {}) {
  return withRetry(async () => {
    const qs = buildQueryString({ category: config.bybit.category, symbol, limit, startTime: start, endTime: end });
    const { data } = await axios.get(`${BASE_URL}/v5/market/funding/history?${qs}`);
    if (data.retCode !== 0) {
      throw new Error(`Bybit getFundingHistory retCode=${data.retCode} ${data.retMsg}`);
    }
    return data.result.list; // [{symbol, fundingRate, fundingRateTimestamp}], mais recente primeiro
  });
}

async function getOpenInterest(symbol = config.symbol, intervalTime = "5min", limit = 1, { start, end } = {}) {
  return withRetry(async () => {
    const qs = buildQueryString({ category: config.bybit.category, symbol, intervalTime, limit, startTime: start, endTime: end });
    const { data } = await axios.get(`${BASE_URL}/v5/market/open-interest?${qs}`);
    if (data.retCode !== 0) {
      throw new Error(`Bybit getOpenInterest retCode=${data.retCode} ${data.retMsg}`);
    }
    return data.result.list; // [{openInterest, timestamp}], mais recente primeiro
  });
}

async function getTickers(symbol = config.symbol) {
  return withRetry(async () => {
    const qs = buildQueryString({ category: config.bybit.category, symbol });
    const { data } = await axios.get(`${BASE_URL}/v5/market/tickers?${qs}`);
    if (data.retCode !== 0) {
      throw new Error(`Bybit getTickers retCode=${data.retCode} ${data.retMsg}`);
    }
    return data.result.list; // [{lastPrice, markPrice, indexPrice, bid1Price, ask1Price, volume24h, ...}]
  });
}

async function getLongShortRatio(symbol = config.symbol, period = "5min", limit = 1) {
  return withRetry(async () => {
    const qs = buildQueryString({ category: config.bybit.category, symbol, period, limit });
    const { data } = await axios.get(`${BASE_URL}/v5/market/account-ratio?${qs}`);
    if (data.retCode !== 0) {
      throw new Error(`Bybit getLongShortRatio retCode=${data.retCode} ${data.retMsg}`);
    }
    return data.result.list; // [{symbol, buyRatio, sellRatio, timestamp}], mais recente primeiro
  });
}

// -------- Privado (autenticado) --------

async function getWalletBalance(accountType = "UNIFIED") {
  const result = await privateGet("/v5/account/wallet-balance", { accountType }, "getWalletBalance");
  const account = result.list && result.list[0];
  if (!account) throw new Error("Bybit getWalletBalance: resposta vazia");
  return {
    totalEquity: parseFloat(account.totalEquity),
    totalAvailableBalance: parseFloat(account.totalAvailableBalance),
    raw: account,
  };
}

async function getPositions(symbol = config.symbol) {
  const result = await privateGet("/v5/position/list", { category: config.bybit.category, symbol }, "getPositions");
  return result.list || [];
}

// Usado para descobrir o PnL real de um trade fechado automaticamente pelo
// stop-loss/take-profit anexado à ordem (Bybit executa isso no servidor —
// o bot só fica sabendo checando esse endpoint ou o position/list ficando vazio).
async function getClosedPnl(symbol = config.symbol, limit = 1) {
  const result = await privateGet("/v5/position/closed-pnl", { category: config.bybit.category, symbol, limit }, "getClosedPnl");
  return result.list || [];
}

// Ordens abertas (pendentes/parcialmente preenchidas) -- fonte pro
// snapshot autenticado da conta Demo (lib/demoAccountSnapshot.js,
// Bloqueador 4: exposição projetada precisa incluir ordens abertas, não
// só a posição já executada). Classificado como READ -- nunca move
// exposição por si só.
async function getOpenOrders(symbol = config.symbol) {
  const result = await privateGet("/v5/order/realtime", { category: config.bybit.category, symbol }, "getOpenOrders");
  return result.list || [];
}

// setLeverage só é autorizado hoje como REDUÇÃO segura com conta flat
// (SAFE_LEVERAGE_REDUCTION, item 4 da Rodada 6) -- ver
// lib/demoOrderGate.js::assertSafeLeverageReductionAllowed -- nunca mais
// tratado como aumento de exposição/ARMED_DEMO. buyLeverage/sellLeverage
// vão explícitos no gateParams (nunca só `leverage`) pra o gate validar
// a simetria por si mesmo, nunca confiando implicitamente que os dois
// lados do body sempre coincidem. `leverage` vira string decimal pro
// gate (lib/decimalSafety.js) -- nunca Number() (Bloqueador 1).
async function setLeverage(symbol = config.symbol, leverage = config.leverageMax) {
  const leverageStr = String(leverage);
  return privatePost(
    "/v5/position/set-leverage",
    { category: config.bybit.category, symbol, buyLeverage: leverageStr, sellLeverage: leverageStr },
    "setLeverage",
    { symbol, leverage: leverageStr, buyLeverage: leverageStr, sellLeverage: leverageStr }
  );
}

// Cancela UMA ordem aberta específica -- CANCEL nunca aumenta exposição
// (na pior hipótese, cancela algo que ainda não executou), por isso
// nunca exige ARMED_DEMO (Bloqueador 9), só perfil/credenciais/gate
// financeiro demo (via privatePost -- assertPrivateMutationAuthorized
// sempre roda). orderId OU orderLinkId -- ao menos um é obrigatório
// (a própria Bybit exige isso; o gate local não reforça essa exigência
// específica, mas a request falha do lado da Bybit se ambos vierem
// ausentes/undefined).
async function cancelOrder({ symbol = config.symbol, orderId, orderLinkId } = {}) {
  const body = { category: config.bybit.category, symbol };
  if (orderId) body.orderId = orderId;
  if (orderLinkId) body.orderLinkId = orderLinkId;
  return privatePost("/v5/order/cancel", body, "cancelOrder", { symbol, orderId, orderLinkId });
}

// Cancela TODAS as ordens abertas do símbolo permitido -- mesma
// classificação CANCEL, mesma dispensa de ARMED_DEMO.
async function cancelAllOrders(symbol = config.symbol) {
  const body = { category: config.bybit.category, symbol };
  return privatePost("/v5/order/cancel-all", body, "cancelAllOrders", { symbol });
}

/**
 * side: "Buy" | "Sell"
 * stopLoss / takeProfit: preços absolutos (não %), opcional
 * price: SÓ usado pra cálculo de notional pelo gate do perfil demo
 *   (lib/demoOrderGate.js) -- NUNCA enviado à Bybit (ordem é Market, o
 *   preço de execução é decidido pela corretora).
 * orderLinkId: identificador único da tentativa -- obrigatório no perfil
 *   demo (garante idempotência dos dois lados: o gate local rejeita reuso
 *   -- lib/demoOrderGate.js -- e a própria Bybit também trata orderLinkId
 *   repetido como a MESMA ordem, nunca duplicando). Fora do perfil demo
 *   continua opcional, comportamento pré-existente preservado.
 */
// `instrumentInfo` NUNCA é aceito aqui (item 1 da Rodada 4) -- esta
// função não tem como provar que uma metadata fornecida pelo chamador é
// autêntica/fresca/do símbolo certo. O gate canônico
// (lib/demoOrderGate.js) busca instrumentInfo exclusivamente do snapshot
// confiável (lib/demoAccountSnapshot.js) antes de validar a ordem --
// nunca de um parâmetro que um chamador (index.js, ou qualquer bug/
// payload futuro) pudesse forjar.
async function placeOrder({ symbol = config.symbol, side, qty, price, stopLoss, takeProfit, reduceOnly = false, orderLinkId }) {
  const body = {
    category: config.bybit.category,
    symbol,
    side,
    orderType: "Market",
    qty: String(qty),
    timeInForce: "IOC",
    reduceOnly,
  };
  if (stopLoss) body.stopLoss = String(stopLoss);
  if (takeProfit) body.takeProfit = String(takeProfit);
  if (orderLinkId) body.orderLinkId = orderLinkId;
  // gateParams usa string decimal (nunca Number -- Bloqueador 1 da
  // Rodada 3) pros mesmos qty/price/stopLoss que vão pro body acima -- o
  // gate normaliza (floor de qty pro qtyStep, nunca pra cima, usando a
  // metadata do símbolo lida do snapshot) e devolve em `.normalized`;
  // este wrapper NÃO reescreve o body com o valor normalizado nesta
  // rodada -- o corpo acima já foi montado com a string original antes
  // do gate rodar, então a normalização do gate é uma segunda camada de
  // proteção (bloqueia se a ordem já enviada estivesse fora dos limites),
  // nunca a única linha de defesa.
  // orderType incluído explicitamente no gateParams (item 2 da Rodada 5)
  // -- este wrapper só cria ordens "Market" hoje (body.orderType acima é
  // sempre esse literal), mas o gate precisa saber disso pra escolher o
  // teto certo do instrumento (maxMktOrderQty pra Market, maxOrderQty
  // pra um futuro Limit) -- nunca assume implicitamente.
  return privatePost("/v5/order/create", body, "placeOrder", { symbol, side, orderType: body.orderType, qty: String(qty), price: String(price), stopLoss, reduceOnly, orderLinkId });
}

// Fase D3 (Break Even) -- amende o stop-loss de uma posição já aberta sem
// recriar a ordem. stopLoss é preço absoluto (não %), mesma convenção de
// placeOrder. Usado pra mover o stop pra entrada (risco zero) quando o
// preço andar +1R a favor -- ver lib/tradeLifecycle.js::isBreakEvenDue.
async function setTradingStop({ symbol = config.symbol, stopLoss, trailingStop, activePrice, tpslMode, takeProfit, tpSize }) {
  const body = { category: config.bybit.category, symbol, positionIdx: 0 };
  if (stopLoss !== undefined) body.stopLoss = String(stopLoss);
  if (trailingStop !== undefined) body.trailingStop = String(trailingStop);
  if (activePrice !== undefined) body.activePrice = String(activePrice);
  // Fase D5 (TP Escalonado) -- tpslMode="Partial" faz cada chamada ADICIONAR
  // uma perna nova de take-profit em vez de substituir a anterior (diferente
  // do modo "Full", que sobrescreve). takeProfit+tpSize precisam vir juntos.
  if (tpslMode !== undefined) body.tpslMode = tpslMode;
  if (takeProfit !== undefined) body.takeProfit = String(takeProfit);
  if (tpSize !== undefined) body.tpSize = String(tpSize);
  return privatePost("/v5/position/trading-stop", body, "setTradingStop", { symbol, stopLoss });
}

// Só funciona em Demo Trading (config.bybit.demo). Máximos por chamada: BTC 15, ETH 200, USDT/USDC 100000. Rate limit: 1/min.
// Classificado como ADMINISTRATION -- não move posição/exposição, mas
// ainda exige ARMED_DEMO + snapshot confiável (nunca liberado só pelo
// gate de leitura).
async function applyDemoFunds(coin, amount) {
  return privatePost("/v5/account/demo-apply-money", { adjustType: 0, utaDemoApplyMoney: [{ coin, amountStr: String(amount) }] }, "applyDemoFunds", { coin, amount: String(amount) });
}

module.exports = {
  BASE_URL,
  resolvePrivateBaseUrl,
  assertPrivateReadAuthorized,
  assertPrivateMutationAuthorized,
  InstrumentInfoError,
  getInstrumentInfo,
  getKlines,
  getFundingHistory,
  getOpenInterest,
  getTickers,
  getLongShortRatio,
  getWalletBalance,
  getPositions,
  getClosedPnl,
  getOpenOrders,
  setLeverage,
  setTradingStop,
  placeOrder,
  cancelOrder,
  cancelAllOrders,
  applyDemoFunds,
};

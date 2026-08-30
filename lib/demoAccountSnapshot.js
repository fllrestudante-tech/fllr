// Snapshot autenticado da conta Demo -- única fonte aceita de
// posição/ordens abertas/exposição pra autorizar AUMENTO de exposição
// (lib/demoOrderGate.js). NUNCA construído por dashboard, AgentRouter,
// Telegram ou parâmetro do chamador -- só por captureDemoAccountSnapshot(),
// que só aceita as funções de LEITURA privada reais (getWalletBalance/
// getPositions/getOpenOrders, injetadas -- nunca importa lib/bybit.js
// diretamente, pra nunca criar ciclo de require e pra deixar o
// chamador real (scripts/supervisor.js ou index.js) decidir a instância
// concreta de transporte).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { atomicWriteJsonSync } = require("./atomicWrite");
const { demoRuntimeDir } = require("./demoRuntimePaths");
const decimal = require("./decimalSafety");

const DEFAULT_SNAPSHOT_PATH = path.join(demoRuntimeDir(), "account-snapshot.json");
// v3 (Rodada 5) -- instrumentInfo ganha maxOrderQty/maxMktOrderQty/
// minPrice/maxPrice/minNotionalValue OBRIGATÓRIOS (v2 só exigia qtyStep/
// minOrderQty/tickSize); e o snapshot ganha `symbolState`
// (leverage efetiva/tradeMode/positionIdx/estado de posição do símbolo
// operado, capturados mesmo quando não há posição aberta -- item 4/5 da
// Rodada 5). Um snapshot v2 (sem esses campos) precisa ser rejeitado
// como incompatível, nunca aceito parcialmente -- daí o bump de versão.
const SCHEMA_VERSION = 3;
const DEFAULT_MAX_SNAPSHOT_AGE_MS = 2 * 60 * 1000; // 2min -- bem mais apertado que o ARMED_DEMO (15min): o snapshot precisa refletir a conta AGORA, não só "recentemente"

class SnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}
class SnapshotMissingError extends SnapshotError {
  constructor() {
    super("SNAPSHOT_MISSING", "Nenhum snapshot autenticado da conta Demo encontrado -- nova exposição bloqueada até o coletor privado Demo produzir um.");
  }
}
class SnapshotCorruptError extends SnapshotError {
  constructor(detail) {
    super("SNAPSHOT_CORRUPT", `Snapshot da conta Demo corrompido ou com formato inesperado (${detail}) -- nova exposição bloqueada, nunca reconstruído a partir de dado parcial.`);
  }
}
class SnapshotStaleError extends SnapshotError {
  constructor(ageMs, maxAgeMs) {
    super("SNAPSHOT_STALE", `Snapshot da conta Demo tem ${ageMs}ms (máximo aceito: ${maxAgeMs}ms) -- nova exposição bloqueada até um snapshot fresco ser capturado.`);
    this.ageMs = ageMs;
  }
}
class SnapshotEnvironmentMismatchError extends SnapshotError {
  constructor() {
    super("SNAPSHOT_ENVIRONMENT_MISMATCH", "Snapshot não foi marcado como originado do endpoint Demo -- nova exposição bloqueada (nunca aceita snapshot de outro ambiente).");
  }
}
class SnapshotCredentialMismatchError extends SnapshotError {
  constructor() {
    super("SNAPSHOT_CREDENTIAL_MISMATCH", "Fingerprint de credencial do snapshot não bate com as credenciais atualmente configuradas -- nova exposição bloqueada (snapshot de uma conta/chave diferente nunca é reaproveitado).");
  }
}
class IncompleteInstrumentInfoError extends SnapshotError {
  constructor(symbol, missingField) {
    super(
      "SNAPSHOT_INSTRUMENT_INFO_INCOMPLETE",
      `Metadata pública do instrumento ${symbol} incompleta${missingField ? ` (${missingField} ausente)` : ""} -- snapshot não gravado, nunca persiste um snapshot sem essa metadata.`
    );
    this.missingField = missingField || null;
  }
}

/**
 * Fingerprint ESTÁVEL e NÃO-SECRETO da credencial atual -- hash SHA-256
 * da API key, nunca a key em si. Muda se a key mudar (detecta troca de
 * conta/ambiente), nunca permite reconstruir a key original.
 */
function computeCredentialFingerprint(apiKey) {
  return "sha256:" + crypto.createHash("sha256").update(String(apiKey)).digest("hex");
}

/**
 * Soma conservadora de exposição: |posição| + soma de TODAS as ordens
 * abertas que não estão explicitamente marcadas reduceOnly=true (uma
 * ordem cujo efeito não dá pra confirmar como redução é contada como
 * SE aumentasse exposição -- nunca ignorada, nunca presumida segura).
 */
function computeConservativeExposureUsd(positions, openOrders) {
  let total = "0";
  for (const p of positions) {
    const notional = decimal.multiplyDecimalStrings(p.qty, p.entryPrice, "position.qty", "position.entryPrice");
    total = decimal.addDecimalStrings(total, notional);
  }
  for (const o of openOrders) {
    if (o.reduceOnly === true) continue; // única exceção -- explicitamente marcada como redução
    const notional = decimal.multiplyDecimalStrings(o.qty, o.price, "openOrder.qty", "openOrder.price");
    total = decimal.addDecimalStrings(total, notional);
  }
  return total;
}

const REQUIRED_INSTRUMENT_FIELDS = ["qtyStep", "minOrderQty", "maxOrderQty", "maxMktOrderQty", "tickSize", "minPrice", "maxPrice", "minNotionalValue"];

/**
 * Estado do símbolo operado (item 4/5 da Rodada 5) -- leverage efetiva,
 * tradeMode, positionIdx e se há posição aberta, extraídos da linha da
 * Bybit correspondente ao símbolo MESMO quando size="0" (a Bybit sempre
 * devolve uma linha por slot symbol/side, mesmo sem posição -- é dessa
 * linha que vem a leverage/modo REALMENTE configurados na conta, que
 * continuam valendo independente de haver posição aberta agora).
 *
 * Devolve `null` (estado DESCONHECIDO, nunca um palpite) se:
 *  - não há exatamente 1 linha pro símbolo (ausente, ou hedge mode com
 *    múltiplas linhas -- este projeto só suporta one-way mode); ou
 *  - `size` não é um decimal legível; ou
 *  - `leverage` não é um decimal legível (o gate trata leverage efetiva
 *    desconhecida como bloqueio de aumento de exposição).
 */
function extractSymbolState(rawPositions, symbol) {
  const rows = rawPositions.filter((p) => p.symbol === symbol);
  if (rows.length !== 1) return null;
  const row = rows[0];

  let sizeStr;
  let hasOpenPosition;
  try {
    sizeStr = decimal.parseNonNegativeDecimalAllowZero(row.size ?? "0", "position.size");
    hasOpenPosition = decimal.compareDecimalStrings(sizeStr, "0") > 0;
  } catch {
    return null;
  }

  let effectiveLeverage = null;
  try {
    effectiveLeverage = decimal.parseStrictDecimal(row.leverage, "position.leverage");
  } catch {
    effectiveLeverage = null; // ausente/ilegível -- desconhecida, nunca um valor inventado
  }

  return {
    hasOpenPosition,
    side: hasOpenPosition ? row.side || null : null,
    qty: hasOpenPosition ? sizeStr : null,
    entryPrice: hasOpenPosition && row.avgPrice ? decimal.parseStrictDecimal(row.avgPrice, "position.avgPrice") : null,
    stopLossPrice: hasOpenPosition && row.stopLoss && row.stopLoss !== "" ? decimal.parseStrictDecimal(row.stopLoss, "position.stopLoss") : null,
    effectiveLeverage,
    tradeMode: typeof row.tradeMode === "number" ? row.tradeMode : null,
    positionIdx: typeof row.positionIdx === "number" ? row.positionIdx : null,
  };
}

/**
 * Captura um snapshot NOVO chamando as 4 leituras reais (injetadas) e
 * grava atomicamente. Só quem já passou por assertPrivateReadAuthorized
 * (as próprias funções de lib/bybit.js já fazem isso internamente)
 * deveria estar chamando isto -- este módulo não reimplementa nem
 * contorna esse gate, só orquestra o resultado.
 */
async function captureDemoAccountSnapshot({ env = process.env, getWalletBalance, getPositions, getOpenOrders, getInstrumentInfo, symbol, snapshotPath = DEFAULT_SNAPSHOT_PATH, now = Date.now() }) {
  const [balance, rawPositions, rawOpenOrders, rawInstrumentInfo] = await Promise.all([getWalletBalance(), getPositions(symbol), getOpenOrders(symbol), getInstrumentInfo(symbol)]);

  // Metadata pública do instrumento -- capturada na MESMA rodada atômica
  // que o resto do snapshot, pra herdar as mesmas garantias de frescor/
  // ambiente/autenticidade da leitura privada (nunca um campo solto com
  // timestamp próprio, nunca opcional). Qualquer campo obrigatório
  // ausente -> lança aqui mesmo, ANTES de gravar qualquer coisa -- nunca
  // persiste um snapshot parcial que pareça válido (item 1 da Rodada 5:
  // a própria lib/bybit.js::getInstrumentInfo real já valida isso, mas
  // este módulo NUNCA confia cegamente numa função injetada -- valida de
  // novo, sempre).
  if (!rawInstrumentInfo || typeof rawInstrumentInfo !== "object") {
    throw new IncompleteInstrumentInfoError(symbol);
  }
  for (const field of REQUIRED_INSTRUMENT_FIELDS) {
    if (rawInstrumentInfo[field] === undefined || rawInstrumentInfo[field] === null || rawInstrumentInfo[field] === "") {
      throw new IncompleteInstrumentInfoError(symbol, field);
    }
  }
  const instrumentInfo = {
    symbol,
    qtyStep: String(rawInstrumentInfo.qtyStep),
    minOrderQty: String(rawInstrumentInfo.minOrderQty),
    maxOrderQty: String(rawInstrumentInfo.maxOrderQty),
    maxMktOrderQty: String(rawInstrumentInfo.maxMktOrderQty),
    tickSize: String(rawInstrumentInfo.tickSize),
    minPrice: String(rawInstrumentInfo.minPrice),
    maxPrice: String(rawInstrumentInfo.maxPrice),
    minNotionalValue: String(rawInstrumentInfo.minNotionalValue),
  };

  const positions = rawPositions
    .filter((p) => decimal.compareDecimalStrings(decimal.parseNonNegativeDecimalAllowZero(p.size ?? "0"), "0") > 0)
    .map((p) => ({ symbol: p.symbol, side: p.side, qty: decimal.parseStrictDecimal(p.size, "position.size"), entryPrice: decimal.parseStrictDecimal(p.avgPrice, "position.avgPrice"), stopLossPrice: p.stopLoss && p.stopLoss !== "" ? decimal.parseStrictDecimal(p.stopLoss, "position.stopLoss") : null }));

  const openOrders = rawOpenOrders.map((o) => ({
    symbol: o.symbol,
    side: o.side,
    qty: decimal.parseStrictDecimal(o.qty, "openOrder.qty"),
    price: decimal.parseStrictDecimal(o.price, "openOrder.price"),
    reduceOnly: Boolean(o.reduceOnly),
    orderLinkId: o.orderLinkId || null,
  }));

  const exposureUsd = computeConservativeExposureUsd(positions, openOrders);
  const symbolState = extractSymbolState(rawPositions, symbol);

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    credentialFingerprint: computeCredentialFingerprint(env.BYBIT_API_KEY),
    capturedAtMs: now,
    endpoint: env.BYBIT_DEMO === "true" ? "demo" : "not_demo",
    equityUsd: decimal.parseNonNegativeDecimalAllowZero(String(balance.totalEquity ?? "0"), "equity"),
    positions,
    openOrders,
    exposureUsd,
    instrumentInfo,
    symbolState,
  };

  const dir = path.dirname(snapshotPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteJsonSync(snapshotPath, snapshot);
  return snapshot;
}

/**
 * Lê e valida o snapshot pra uso em autorização de AUMENTO de exposição.
 * Lança um erro específico e tipado pra CADA forma de "não confiável" --
 * ausente, corrompido, velho, ambiente errado, credencial diferente.
 * Nunca devolve um snapshot parcialmente válido.
 */
function readTrustedSnapshot({ env = process.env, snapshotPath = DEFAULT_SNAPSHOT_PATH, maxAgeMs = DEFAULT_MAX_SNAPSHOT_AGE_MS, now = Date.now() } = {}) {
  if (!fs.existsSync(snapshotPath)) throw new SnapshotMissingError();

  let snapshot;
  try {
    const raw = fs.readFileSync(snapshotPath, "utf8");
    snapshot = JSON.parse(raw);
  } catch {
    throw new SnapshotCorruptError("JSON inválido");
  }

  if (snapshot.schemaVersion !== SCHEMA_VERSION) throw new SnapshotCorruptError(`schemaVersion inesperado: ${JSON.stringify(snapshot.schemaVersion)}`);
  if (typeof snapshot.capturedAtMs !== "number" || !Number.isFinite(snapshot.capturedAtMs)) throw new SnapshotCorruptError("capturedAtMs ausente/inválido");
  if (typeof snapshot.credentialFingerprint !== "string" || !snapshot.credentialFingerprint.startsWith("sha256:")) throw new SnapshotCorruptError("credentialFingerprint ausente/inválido");
  if (!Array.isArray(snapshot.positions) || !Array.isArray(snapshot.openOrders)) throw new SnapshotCorruptError("positions/openOrders ausentes ou não são array");
  if (typeof snapshot.exposureUsd !== "string" || typeof snapshot.equityUsd !== "string") throw new SnapshotCorruptError("exposureUsd/equityUsd ausentes ou não são string decimal");
  const info = snapshot.instrumentInfo;
  if (!info || typeof info !== "object" || typeof info.symbol !== "string") {
    throw new SnapshotCorruptError("instrumentInfo ausente");
  }
  for (const field of REQUIRED_INSTRUMENT_FIELDS) {
    if (typeof info[field] !== "string") throw new SnapshotCorruptError(`instrumentInfo.${field} ausente ou não é string decimal`);
  }
  // symbolState PRECISA existir como chave (null é um valor válido --
  // "estado desconhecido", ver extractSymbolState) -- só um snapshot v2
  // OU um snapshot corrompido/truncado não teria a chave nenhuma.
  if (!("symbolState" in snapshot)) throw new SnapshotCorruptError("symbolState ausente");
  if (snapshot.symbolState !== null) {
    const s = snapshot.symbolState;
    if (typeof s !== "object" || typeof s.hasOpenPosition !== "boolean" || typeof s.tradeMode !== "number" || typeof s.positionIdx !== "number") {
      throw new SnapshotCorruptError("symbolState presente mas em formato inesperado");
    }
    if (s.effectiveLeverage !== null && typeof s.effectiveLeverage !== "string") {
      throw new SnapshotCorruptError("symbolState.effectiveLeverage em formato inesperado");
    }
  }

  const ageMs = now - snapshot.capturedAtMs;
  if (ageMs < 0 || ageMs > maxAgeMs) throw new SnapshotStaleError(ageMs, maxAgeMs);

  if (snapshot.endpoint !== "demo") throw new SnapshotEnvironmentMismatchError();

  const expectedFingerprint = computeCredentialFingerprint(env.BYBIT_API_KEY);
  if (snapshot.credentialFingerprint !== expectedFingerprint) throw new SnapshotCredentialMismatchError();

  return snapshot;
}

module.exports = {
  DEFAULT_SNAPSHOT_PATH,
  DEFAULT_MAX_SNAPSHOT_AGE_MS,
  SCHEMA_VERSION,
  SnapshotError,
  SnapshotMissingError,
  SnapshotCorruptError,
  SnapshotStaleError,
  SnapshotEnvironmentMismatchError,
  SnapshotCredentialMismatchError,
  IncompleteInstrumentInfoError,
  REQUIRED_INSTRUMENT_FIELDS,
  computeCredentialFingerprint,
  computeConservativeExposureUsd,
  extractSymbolState,
  captureDemoAccountSnapshot,
  readTrustedSnapshot,
};

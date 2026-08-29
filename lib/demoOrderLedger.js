// Ledger local do perfil demo -- rastreia timestamps de ordens recentes
// (frequência/cooldown) e orderLinkId já usados (idempotência). TUDO
// síncrono (fs.*Sync) de propósito. A atomicidade DENTRO de um processo
// vem do event loop de thread única (nenhum `await` entre ler e gravar
// aqui) -- mas isso NUNCA protege contra dois PROCESSOS Node distintos
// (dois `node index.js`, um manual + um da tarefa agendada, etc.):
// nesse caso é lib/demoReservationLock.js (lock exclusivo via
// O_EXCL/"wx", cross-process) que lib/demoOrderGate.js usa em volta de
// toda a decisão de aumento de exposição -- este módulo só cuida da
// leitura/escrita dos dados em si, nunca decide sozinho quem tem
// permissão de escrever.
const fs = require("fs");
const path = require("path");
const { atomicWriteJsonSync } = require("./atomicWrite");
const { demoRuntimeDir } = require("./demoRuntimePaths");

const DEFAULT_LEDGER_PATH = path.join(demoRuntimeDir(), "order-ledger.json");
const DEFAULT_OUTCOMES_PATH = path.join(demoRuntimeDir(), "private-call-outcomes.json");
const DEFAULT_LAST_DECISION_PATH = path.join(demoRuntimeDir(), "last-decision.json");
const RETENTION_MS = 24 * 60 * 60 * 1000; // entradas mais velhas que isso são podadas a cada escrita
const MAX_OUTCOMES_TRACKED = 50; // só precisa da cauda recente pra contar erros consecutivos
const READ_OP_NAMES = new Set(["getWalletBalance", "getPositions", "getClosedPnl"]);

function emptyLedger() {
  return { orders: [] }; // cada item: { orderLinkId, symbol, kind, atMs }
}

function emptyOutcomes() {
  return { outcomes: [] }; // cada item: { success: boolean, atMs, context }
}

class CorruptOrderLedgerError extends Error {
  constructor() {
    super("Ledger de ordens do perfil demo corrompido ou ilegível -- não é possível provar frequência/cooldown/idempotência, bloqueado por segurança.");
    this.name = this.constructor.name;
    this.code = "CORRUPT_ORDER_LEDGER";
  }
}

class CorruptPrivateCallOutcomesError extends Error {
  constructor() {
    super("Histórico de outcomes de chamadas privadas do perfil demo corrompido -- não é possível confirmar erros consecutivos, bloqueado por segurança para fins de AUTORIZAÇÃO de novo aumento de exposição.");
    this.name = this.constructor.name;
    this.code = "CORRUPT_PRIVATE_CALL_OUTCOMES";
  }
}

/**
 * Lê o ledger. Arquivo ausente -> ledger vazio (estado inicial normal,
 * nunca bloqueia). Arquivo presente mas corrompido -> lança
 * CorruptOrderLedgerError -- fail-closed, nunca finge que está vazio
 * (isso apagaria silenciosamente o histórico de cooldown/frequência e
 * poderia permitir uma ordem que deveria estar bloqueada).
 */
function readLedger(filePath = DEFAULT_LEDGER_PATH) {
  if (!fs.existsSync(filePath)) return emptyLedger();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.orders)) throw new Error("formato inesperado");
    return parsed;
  } catch {
    throw new CorruptOrderLedgerError();
  }
}

function pruneOld(ledger, now) {
  return { orders: ledger.orders.filter((o) => now - o.atMs <= RETENTION_MS) };
}

function writeLedger(filePath, ledger) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteJsonSync(filePath, ledger);
}

/** Timestamps (ms) de ordens dentro dos últimos `windowMs` a partir de `now`. */
function getRecentOrderTimestamps(filePath = DEFAULT_LEDGER_PATH, { windowMs, now = Date.now() } = {}) {
  const ledger = readLedger(filePath);
  const windowStart = now - windowMs;
  return ledger.orders.filter((o) => o.atMs > windowStart && o.atMs <= now).map((o) => o.atMs);
}

function getLastOrderAt(filePath = DEFAULT_LEDGER_PATH) {
  const ledger = readLedger(filePath);
  if (ledger.orders.length === 0) return null;
  return Math.max(...ledger.orders.map((o) => o.atMs));
}

function isOrderLinkIdUsed(filePath = DEFAULT_LEDGER_PATH, orderLinkId) {
  const ledger = readLedger(filePath);
  return ledger.orders.some((o) => o.orderLinkId === orderLinkId);
}

/**
 * Grava a RESERVA de uma tentativa de ordem -- síncrono, read-modify-write
 * completo numa única chamada (nunca dividido em duas operações separadas
 * que um `await` no meio poderia intercalar). Chamado pelo gate SOMENTE
 * depois que todos os limites já passaram, como o último passo antes de
 * autorizar -- registra mesmo que a chamada HTTP real venha a falhar
 * depois (a reserva conta como "tentativa", não como "sucesso confirmado"
 * -- consistente com o resto do projeto, ex.: lastTradeTime já é gravado
 * mesmo quando placeOrder falha em index.js::openPosition).
 */
function recordOrderAttempt(filePath = DEFAULT_LEDGER_PATH, { orderLinkId, symbol, kind, atMs = Date.now() }) {
  const ledger = readLedger(filePath);
  const pruned = pruneOld(ledger, atMs);
  pruned.orders.push({ orderLinkId, symbol, kind, atMs });
  writeLedger(filePath, pruned);
}

/**
 * Registra o RESULTADO real de uma chamada privada (depois do
 * axios.get/post resolver ou rejeitar) -- chamado por lib/bybit.js em
 * .then()/.catch(), nunca pelo próprio gate (que roda ANTES da chamada,
 * sem saber o resultado ainda). Arquivo separado do ledger de ordens --
 * outcomes cobrem TODA chamada privada (inclusive leituras), não só
 * tentativas de aumento de exposição.
 */
function recordPrivateCallOutcome(filePath = DEFAULT_OUTCOMES_PATH, { success, atMs = Date.now(), context = null }) {
  let current;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    current = Array.isArray(parsed.outcomes) ? parsed : emptyOutcomes();
  } catch {
    current = emptyOutcomes(); // ausente ou corrompido -- recomeça a série (contagem de erros consecutivos zera, nunca lança aqui: isto é telemetria, não autorização)
  }
  current.outcomes.push({ success: Boolean(success), atMs, context });
  if (current.outcomes.length > MAX_OUTCOMES_TRACKED) current.outcomes = current.outcomes.slice(-MAX_OUTCOMES_TRACKED);
  writeLedger(filePath, current);
}

/**
 * Conta falhas consecutivas a partir do outcome MAIS RECENTE, parando no
 * primeiro sucesso. Arquivo ausente/corrompido -> 0 (nunca lança -- é
 * telemetria; um outcome tracker corrompido não deveria, por si só,
 * travar leitura/decisão -- quem bloqueia de verdade em caso de dúvida é
 * o kill switch/demais limites, que SÃO fail-closed).
 */
function getConsecutiveErrorCount(filePath = DEFAULT_OUTCOMES_PATH) {
  let parsed;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.outcomes)) return 0;
  } catch {
    return 0;
  }
  let count = 0;
  for (let i = parsed.outcomes.length - 1; i >= 0; i--) {
    if (parsed.outcomes[i].success) break;
    count++;
  }
  return count;
}

/**
 * Versão FAIL-CLOSED de getConsecutiveErrorCount, pra uso em AUTORIZAÇÃO
 * de aumento de exposição (Bloqueador 6) -- nunca chamada pelo painel
 * (que usa a versão lenient acima, telemetria pura). Arquivo AUSENTE
 * continua sendo 0 (estado inicial legítimo: nenhuma chamada privada
 * aconteceu ainda, não é um sinal de corrupção). Arquivo PRESENTE mas
 * ilegível/malformado -> lança CorruptPrivateCallOutcomesError -- nunca
 * finge que a contagem é 0 nesse caso, porque isso poderia mascarar uma
 * sequência real de falhas e liberar uma ordem que deveria estar em
 * lockout.
 */
function getConsecutiveErrorCountForAuthorization(filePath = DEFAULT_OUTCOMES_PATH) {
  if (!fs.existsSync(filePath)) return 0;
  let parsed;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.outcomes)) throw new Error("formato inesperado");
  } catch {
    throw new CorruptPrivateCallOutcomesError();
  }
  let count = 0;
  for (let i = parsed.outcomes.length - 1; i >= 0; i--) {
    if (parsed.outcomes[i].success) break;
    count++;
  }
  return count;
}

/** Timestamp (ms) do último READ privado (getWalletBalance/getPositions/getClosedPnl) bem-sucedido, ou null se nunca houve um. */
function getLastSuccessfulReadAt(filePath = DEFAULT_OUTCOMES_PATH) {
  let parsed;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.outcomes)) return null;
  } catch {
    return null;
  }
  const reads = parsed.outcomes.filter((o) => o.success && READ_OP_NAMES.has(o.context));
  if (reads.length === 0) return null;
  return Math.max(...reads.map((o) => o.atMs));
}

/**
 * Registra a decisão mais recente do gate canônico (lib/demoOrderGate.js)
 * -- chamado tanto no caminho de sucesso quanto no de bloqueio. Só
 * telemetria pro painel (Bloqueador 7) -- nunca lida de volta pra decidir
 * autorização (isso seria circular).
 */
function recordLastDecision(filePath = DEFAULT_LAST_DECISION_PATH, { allowed, kind, opName, reason = null, atMs = Date.now() }) {
  try {
    writeLedger(filePath, { allowed, kind, opName, reason, atMs });
  } catch {
    // telemetria nunca derruba uma decisão real já tomada
  }
}

/** Última decisão registrada, ou null se nenhuma ainda (nunca inventa um valor). */
function getLastDecision(filePath = DEFAULT_LAST_DECISION_PATH) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_LEDGER_PATH,
  DEFAULT_OUTCOMES_PATH,
  DEFAULT_LAST_DECISION_PATH,
  CorruptOrderLedgerError,
  CorruptPrivateCallOutcomesError,
  readLedger,
  getRecentOrderTimestamps,
  getLastOrderAt,
  isOrderLinkIdUsed,
  recordOrderAttempt,
  recordPrivateCallOutcome,
  getConsecutiveErrorCount,
  getConsecutiveErrorCountForAuthorization,
  getLastSuccessfulReadAt,
  recordLastDecision,
  getLastDecision,
};

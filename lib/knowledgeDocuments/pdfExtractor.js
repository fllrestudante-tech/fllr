// Extração de texto de PDF offline, com o parser isolado em processo
// FILHO (lib/knowledgeDocuments/pdfExtractorWorker.mjs). Este arquivo
// (processo PAI) NUNCA importa pdfjs-dist -- só controla limites,
// integridade e o protocolo IPC. Nenhuma leitura de conteúdo do PDF
// acontece aqui além do necessário pra calcular o hash -- o parsing real
// é 100% responsabilidade do processo filho.
//
// TOCTOU: o processo filho NUNCA reabre o caminho do PDF -- ele recebe os
// bytes já lidos e já verificados (hash conferido) por ESTE processo, via
// mensagem IPC (Buffer, serialização "advanced" -- sem round-trip por
// arquivo temporário nem por JSON). Não existe janela entre "verificar" e
// "usar": os bytes verificados SÃO os bytes usados.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fork } = require("child_process");
const { sanitizePathForLog } = require("./pathSafety");
const { normalizeExtractedText } = require("./textNormalizer");

const WORKER_PATH = path.join(__dirname, "pdfExtractorWorker.mjs");

const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100MB -- folga generosa sobre o manual real (~54,5MB)
const DEFAULT_MAX_PAGES = 500;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS_PER_PAGE = 200_000;
const DEFAULT_MAX_TOTAL_OUTPUT_CHARS = 5_000_000;
const DEFAULT_MAX_OLD_SPACE_SIZE_MB = 512;

class PdfValidationError extends Error {
  constructor(detail) {
    super(`Invalid PDF extraction request: ${detail}`);
    this.name = this.constructor.name;
    this.code = "PDF_VALIDATION_ERROR";
  }
}

class PdfEncryptedError extends Error {
  constructor() {
    super("PDF is encrypted or password-protected -- not supported");
    this.name = this.constructor.name;
    this.code = "PDF_ENCRYPTED";
  }
}

class PdfMalformedError extends Error {
  constructor() {
    super("PDF is malformed or could not be parsed");
    this.name = this.constructor.name;
    this.code = "PDF_MALFORMED";
  }
}

class PdfTimeoutError extends Error {
  constructor() {
    super("PDF extraction timed out");
    this.name = this.constructor.name;
    this.code = "PDF_TIMEOUT";
  }
}

class PdfExtractionError extends Error {
  constructor(detail = "internal extraction failure") {
    super(`PDF extraction failed: ${detail}`);
    this.name = this.constructor.name;
    this.code = "PDF_EXTRACTION_ERROR";
  }
}

class PdfNetworkBlockedError extends Error {
  constructor() {
    super("PDF extraction aborted: a network API was invoked inside the isolated worker -- extraction never completes partially in this case"); // nunca inclui a API específica nem URL
    this.name = this.constructor.name;
    this.code = "PDF_NETWORK_BLOCKED";
  }
}

class PdfRenderingAttemptedError extends Error {
  constructor() {
    super("PDF extraction aborted: an unexpected rendering/drawing call was made inside the isolated worker -- this indicates the text-only extraction assumption was violated and needs investigation"); // nunca inclui detalhe do método/stack
    this.name = this.constructor.name;
    this.code = "PDF_RENDERING_ATTEMPTED";
  }
}

function errorForWorkerCode(code) {
  switch (code) {
    case "ENCRYPTED":
      return new PdfEncryptedError();
    case "MALFORMED":
    case "INVALID_MAGIC_BYTES":
    case "LOAD_FAILED":
      return new PdfMalformedError();
    case "INVALID_REQUEST":
      return new PdfValidationError("worker rejected the internal request protocol");
    case "NETWORK_ACCESS_BLOCKED":
      return new PdfNetworkBlockedError();
    case "SHIM_METHOD_CALLED":
      return new PdfRenderingAttemptedError();
    default:
      return new PdfExtractionError();
  }
}

function validatePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new PdfValidationError("filePath must be a non-empty string");
  }
  if (!path.isAbsolute(filePath)) {
    throw new PdfValidationError("filePath must be an absolute path");
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new PdfValidationError(`file not found: ${sanitizePathForLog(filePath)}`);
  }
  if (!stat.isFile()) {
    throw new PdfValidationError(`not a regular file: ${sanitizePathForLog(filePath)}`);
  }
  return stat;
}

function validateSha256(expectedSha256) {
  if (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new PdfValidationError("expectedSha256 must be provided as exactly 64 lowercase hex characters -- never optional, never a synthetic placeholder");
  }
}

function validatePagesOption(pages) {
  if (pages == null) return null;
  if (!Array.isArray(pages) || pages.length === 0 || !pages.every((p) => Number.isInteger(p) && p >= 1)) {
    throw new PdfValidationError("pages, when provided, must be a non-empty array of positive integers");
  }
  return pages;
}

/**
 * Extrai texto de um PDF local, offline, com o parser isolado em processo
 * filho com memória/timeout limitados. Exige `expectedSha256` sempre --
 * NUNCA um valor sintético/opcional; se o hash real do arquivo não bater
 * exatamente, a extração falha ANTES de qualquer parsing.
 *
 * Devolve `{ sha256, sizeBytes, numPages, pagesProcessed, pages,
 * documentWarnings, outOfRangeRequested }`. `pages[].rawText` é a
 * reconstrução bruta (heurística genérica, documentada em
 * pdfExtractorWorker.mjs); `pages[].normalizedText` passou por
 * textNormalizer.js. As duas nunca se sobrescrevem.
 */
async function extractPdf(filePath, options = {}) {
  const {
    expectedSha256,
    maxSizeBytes = DEFAULT_MAX_SIZE_BYTES,
    maxPages = DEFAULT_MAX_PAGES,
    pages = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputCharsPerPage = DEFAULT_MAX_OUTPUT_CHARS_PER_PAGE,
    maxTotalOutputChars = DEFAULT_MAX_TOTAL_OUTPUT_CHARS,
    maxOldSpaceSizeMb = DEFAULT_MAX_OLD_SPACE_SIZE_MB,
  } = options;

  validateSha256(expectedSha256);
  const requestedPages = validatePagesOption(pages);
  if (!Number.isInteger(maxPages) || maxPages <= 0) throw new PdfValidationError("maxPages must be a positive integer");
  if (!Number.isInteger(maxSizeBytes) || maxSizeBytes <= 0) throw new PdfValidationError("maxSizeBytes must be a positive integer");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new PdfValidationError("timeoutMs must be a positive integer");

  const stat = validatePath(filePath);
  if (stat.size > maxSizeBytes) {
    throw new PdfValidationError(`file exceeds the maximum allowed size of ${maxSizeBytes} bytes`);
  }

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    throw new PdfValidationError(`could not read file: ${sanitizePathForLog(filePath)}`);
  }
  if (buffer.length > maxSizeBytes) {
    throw new PdfValidationError(`file exceeds the maximum allowed size of ${maxSizeBytes} bytes`);
  }

  const actualSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new PdfValidationError("file hash does not match expectedSha256 -- refusing to parse"); // nunca inclui nenhum dos dois hashes na mensagem
  }

  const workerResult = await runWorker(buffer, {
    pages: requestedPages,
    maxPages,
    maxOutputCharsPerPage,
    timeoutMs,
    maxOldSpaceSizeMb,
  });

  const { pages: limitedPages, totalTruncated } = enforceMaxTotalOutput(workerResult.pages, maxTotalOutputChars);

  const normalizedPages = limitedPages.map((p) => ({
    page: p.page,
    rawText: p.rawText,
    normalizedText: normalizeExtractedTextSafe(p.rawText),
    charCount: p.charCount,
    itemCount: p.itemCount,
    isEmpty: p.isEmpty,
    warnings: [],
    truncated: p.truncated || false,
    // Campos de reconstrução geométrica -- acrescentados, nunca
    // sobrescrevem rawText/normalizedText (as representações convivem
    // lado a lado). sourceOrderedText é a única elegível pra uma futura
    // ingestão (nunca reordena); layoutCandidateText é só diagnóstico.
    sourceOrderedText: p.sourceOrderedText,
    sourceOrderedTruncated: p.sourceOrderedTruncated,
    layoutCandidateText: p.layoutCandidateText,
    layoutCandidateTruncated: p.layoutCandidateTruncated,
    reconstructionApplied: p.reconstructionApplied,
    reconstructionConfidence: p.reconstructionConfidence,
    reconstructionDiagnostics: p.reconstructionDiagnostics,
    ambiguousGapCount: p.ambiguousGapCount,
    lineCount: p.lineCount,
    orientationGroups: p.orientationGroups,
    layoutCandidateMultisetInvariant: p.layoutCandidateMultisetInvariant,
    layoutCandidateAmbiguousGapCount: p.layoutCandidateAmbiguousGapCount,
    layoutCandidateLineCount: p.layoutCandidateLineCount,
    layoutCandidateOrderDiverged: p.layoutCandidateOrderDiverged,
    characterMultisetInvariant: p.characterMultisetInvariant,
    sourceOrderInvariant: p.sourceOrderInvariant,
    qualityStatus: p.qualityStatus,
  }));

  return {
    sha256: actualSha256,
    sizeBytes: buffer.length,
    numPages: workerResult.numPages,
    pagesProcessed: normalizedPages.map((p) => p.page),
    pages: normalizedPages,
    documentWarnings: workerResult.documentWarnings,
    outOfRangeRequested: workerResult.outOfRangeRequested,
    totalOutputTruncated: totalTruncated,
    networkAccessAttempts: workerResult.networkAccessAttempts ?? 0, // métrica sanitizada -- só a contagem (sempre 0 em qualquer extração bem-sucedida, já que networkAccessAttempts > 0 faz o worker falhar antes de responder)
  };
}

function normalizeExtractedTextSafe(rawText) {
  try {
    return normalizeExtractedText(rawText);
  } catch {
    return ""; // nunca lança durante a montagem do resultado -- normalização é conveniência, não deve derrubar a extração já bem-sucedida
  }
}

function enforceMaxTotalOutput(pages, maxTotalOutputChars) {
  let total = 0;
  const kept = [];
  let totalTruncated = false;
  for (const p of pages) {
    if (total + p.charCount > maxTotalOutputChars) {
      totalTruncated = true;
      break;
    }
    total += p.charCount;
    kept.push(p);
  }
  return { pages: kept, totalTruncated };
}

function buildChildEnv() {
  // Nenhuma herança desnecessária -- NUNCA process.env inteiro (que
  // inclui tudo que dotenv carregou: tokens, chaves, etc.). Só as
  // variáveis mínimas que o próprio Node/Windows precisa pra inicializar
  // o processo corretamente.
  const env = {};
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.windir) env.windir = process.env.windir;
  if (process.env.TEMP) env.TEMP = process.env.TEMP;
  if (process.env.TMP) env.TMP = process.env.TMP;
  return env;
}

function runWorker(buffer, { pages, maxPages, maxOutputCharsPerPage, timeoutMs, maxOldSpaceSizeMb }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = fork(WORKER_PATH, [], {
        execArgv: [`--max-old-space-size=${maxOldSpaceSizeMb}`],
        serialization: "advanced", // preserva Buffer como Buffer no IPC, sem round-trip por JSON/array de números
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: buildChildEnv(),
        cwd: __dirname,
      });
    } catch {
      reject(new PdfExtractionError("failed to spawn worker process"));
      return;
    }

    const cleanup = () => {
      clearTimeout(timer);
      child.removeAllListeners();
      if (child.connected) child.disconnect();
      if (!child.killed) child.kill("SIGKILL"); // limpeza garantida -- sempre encerra o filho, sucesso ou erro
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new PdfTimeoutError());
    }, timeoutMs);

    child.once("message", (msg) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!msg || typeof msg !== "object") {
        reject(new PdfExtractionError("worker returned a malformed response"));
        return;
      }
      if (msg.type === "error") {
        reject(errorForWorkerCode(msg.code));
        return;
      }
      if (msg.type !== "result") {
        reject(new PdfExtractionError("worker returned an unrecognized response type"));
        return;
      }
      resolve(msg);
    });

    child.once("error", () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new PdfExtractionError("worker process error"));
    });

    child.once("exit", (codeExit) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new PdfExtractionError(`worker exited unexpectedly (code ${codeExit})`));
    });

    child.send({
      type: "extract",
      buffer,
      pages,
      maxPages,
      maxOutputCharsPerPage,
    });
  });
}

module.exports = {
  extractPdf,
  PdfValidationError,
  PdfEncryptedError,
  PdfMalformedError,
  PdfTimeoutError,
  PdfExtractionError,
  PdfNetworkBlockedError,
  PdfRenderingAttemptedError,
  DEFAULT_MAX_SIZE_BYTES,
  DEFAULT_MAX_PAGES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_CHARS_PER_PAGE,
  DEFAULT_MAX_TOTAL_OUTPUT_CHARS,
  DEFAULT_MAX_OLD_SPACE_SIZE_MB,
  WORKER_PATH,
};

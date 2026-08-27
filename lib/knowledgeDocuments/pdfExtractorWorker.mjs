// Processo FILHO isolado de extração de texto de PDF. Roda em processo
// separado (fork()), nunca no processo principal. ESM porque
// pdfjs-dist@6.x só distribui build ESM (.mjs) -- ver package.json de
// node_modules/pdfjs-dist (main: "build/pdf.mjs", sem build CJS).
//
// CONTRATO DE SEGURANÇA (lido junto com pdfExtractor.js, que é quem
// spawna este arquivo com memória/timeout/env controlados):
//   - NUNCA lê o PDF do disco -- recebe os bytes já verificados (hash
//     conferido pelo processo pai) via mensagem IPC. Não há TOCTOU
//     possível aqui porque este processo nunca abre o caminho do PDF.
//   - Só usa a API de EXTRAÇÃO DE TEXTO do pdf.js (getDocument ->
//     getPage -> getTextContent). NUNCA chama page.render() (não
//     renderiza, não cria canvas), NUNCA acessa anotações/ações,
//     NUNCA acessa anexos, NUNCA segue link algum.
//   - isEvalSupported:false, disableFontFace:true, useSystemFonts:false --
//     desliga os únicos caminhos do pdf.js que poderiam avaliar
//     código/carregar recurso de fonte externo.
//   - cMap/standard fonts são carregados só do PRÓPRIO pacote pdfjs-dist
//     já instalado (recurso local, confiável, parte do pacote validado
//     antes da instalação, sempre via file://) -- nunca de rede, nunca de
//     um valor `data:`/`http:`/`https:` ou de qualquer URL extraída do
//     PDF do usuário (este worker nunca lê /URI do PDF -- não chama
//     getAnnotations()).
//   - Nenhum import de "http"/"https"/"net"/"dns"/"tls"/"child_process"
//     neste arquivo (verificado por meta-teste). ALÉM disso, as APIs de
//     rede que são GLOBALS do runtime (fetch/WebSocket/EventSource/
//     XMLHttpRequest/navigator.sendBeacon -- não precisam de import) são
//     bloqueadas explicitamente abaixo, ANTES de qualquer outra coisa.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// --- Bloqueio de rede em runtime (defesa em profundidade) ---------------
// Ausência de require("http")/require("https") NÃO prova ausência de
// rede -- fetch/WebSocket/EventSource/XMLHttpRequest/navigator.sendBeacon
// são GLOBALS do próprio runtime Node (fetch/WebSocket nativos desde o
// Node 18, via undici), nunca precisam de import/require. Bloqueados
// aqui, ANTES do import do pdf.js, e permanecem bloqueados pelo resto da
// vida deste processo -- nenhum código depois deste ponto (nem o pdf.js,
// nem qualquer coisa que ele carregue) tem como restaurar o global
// original, porque este módulo nunca exporta uma referência a ele.
//
// Por que isto é seguro pro carregamento de CMap/fontes locais: conferido
// por leitura do código-fonte do pdf.js efetivamente instalado
// (node_modules/pdfjs-dist/legacy/build/pdf.mjs, função
// `node_utils_fetchData`) que a leitura de recurso local em ambiente Node
// usa EXCLUSIVAMENTE `require("fs/promises").readFile`, nunca `fetch` --
// bloquear `fetch` não cria nenhum incentivo a fallback de rede nesse
// caminho, porque esse caminho nunca usou `fetch` pra começo de conversa
// (confirmado empiricamente: os testes deste módulo, incluindo extração
// de fontes CID/ToUnicode do manual real, continuam passando com a rede
// bloqueada).
let networkAttemptCount = 0;

class NetworkAccessBlockedError extends Error {
  constructor(apiName) {
    super(`Network access blocked in PDF extraction worker (${apiName})`); // nunca URL, payload ou segredo -- só o nome da API
    this.name = this.constructor.name;
    this.code = "NETWORK_ACCESS_BLOCKED";
  }
}

// Lançada só na INSTALAÇÃO (nunca em uso normal) -- se este processo não
// conseguir garantir a imutabilidade do bloqueio de rede, ele PARA aqui,
// fail-closed: melhor o worker inteiro falhar ao iniciar do que rodar
// "só mais ou menos" protegido.
class NetworkGuardInstallationError extends Error {
  constructor(apiName, detail) {
    super(`Cannot install immutable network guard for "${apiName}": ${detail}`); // nunca inclui valor, URL ou stack -- só nome da API e motivo curto
    this.name = this.constructor.name;
    this.code = "NETWORK_GUARD_INSTALL_FAILED";
  }
}

function blockedFunction(apiName) {
  return function blocked() {
    networkAttemptCount += 1;
    throw new NetworkAccessBlockedError(apiName);
  };
}

function blockedConstructor(apiName) {
  return class Blocked {
    constructor() {
      networkAttemptCount += 1;
      throw new NetworkAccessBlockedError(apiName);
    }
  };
}

/**
 * Instala `globalThis[name] = value` como propriedade de dado IMUTÁVEL --
 * `writable:false, configurable:false`. Nunca contorna uma propriedade
 * global já existente e não-configurável: se `Object.getOwnPropertyDescriptor`
 * mostrar `configurable:false` (o único caso em que não temos como
 * garantir a substituição), lança `NetworkGuardInstallationError` -- fail
 * closed explícito, documentado, nunca uma tentativa silenciosa de
 * contornar via outro mecanismo. Depois de instalar, LÊ O DESCRIPTOR DE
 * VOLTA e confere que ficou exatamente como pedido -- nunca confia
 * cegamente que `defineProperty` fez o que foi pedido.
 */
function installImmutableGlobal(name, value) {
  const existing = Object.getOwnPropertyDescriptor(globalThis, name);
  if (existing && existing.configurable === false) {
    throw new NetworkGuardInstallationError(name, "existing global property is already non-configurable; refusing to proceed without a guaranteed lock");
  }
  Object.defineProperty(globalThis, name, {
    value,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  const installed = Object.getOwnPropertyDescriptor(globalThis, name);
  if (!installed || installed.writable !== false || installed.configurable !== false || installed.value !== value) {
    throw new NetworkGuardInstallationError(name, "post-install verification did not confirm the immutable descriptor");
  }
}

function installNetworkGuards() {
  installImmutableGlobal("fetch", blockedFunction("fetch"));
  installImmutableGlobal("WebSocket", blockedConstructor("WebSocket"));
  installImmutableGlobal("EventSource", blockedConstructor("EventSource"));
  installImmutableGlobal("XMLHttpRequest", blockedConstructor("XMLHttpRequest"));
  installNavigatorGuard();
}

/**
 * `navigator` recebe tratamento à parte porque, além de imutável em
 * `globalThis`, o OBJETO em si precisa estar congelado (`Object.freeze`)
 * -- senão bastaria reescrever `navigator.sendBeacon` (writable:false em
 * `globalThis.navigator` só impede trocar o OBJETO inteiro, não impede
 * mutar suas propriedades internas). Só as propriedades estritamente
 * necessárias pro carregamento do pdf.js (`language`, checado
 * explicitamente pelo bloco `isNodeJS` do pdf.js; `userAgent`, lido uma
 * vez em código de feature-detection, tolera string vazia) mais
 * `sendBeacon` (o próprio guard bloqueado) -- nenhuma outra propriedade,
 * nenhuma referência à API original de nada.
 */
function installNavigatorGuard() {
  const existing = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  if (existing && existing.configurable === false) {
    throw new NetworkGuardInstallationError("navigator", "existing global property is already non-configurable; refusing to proceed without a guaranteed lock");
  }
  const navigatorObject = Object.freeze({
    language: "en-US",
    userAgent: "",
    sendBeacon: blockedFunction("navigator.sendBeacon"),
  });
  installImmutableGlobal("navigator", navigatorObject);
  if (!Object.isFrozen(globalThis.navigator)) {
    throw new NetworkGuardInstallationError("navigator", "navigator object is not frozen after installation");
  }
}

function getNetworkAttemptCount() {
  return networkAttemptCount;
}

/** Lança se QUALQUER API de rede foi chamada até agora -- checkpoint explícito, não depende só da exceção original ter se propagado sem ser engolida em algum catch interno do pdf.js. */
function assertNoNetworkAttempts() {
  if (networkAttemptCount > 0) {
    throw new NetworkAccessBlockedError("post-hoc-check");
  }
}

installNetworkGuards();

// --- Shim de compatibilidade LOCAL para DOMMatrix/Path2D -----------------
// NÃO é um "ponto de extensão oficial" do pdf.js -- não há documentação
// pública do projeto garantindo estabilidade disso entre versões. É uma
// observação EMPÍRICA do código-fonte da versão instalada (6.2.108):
// node_modules/pdfjs-dist/legacy/build/pdf.mjs contém
// `if (isNodeJS) { if (!globalThis.DOMMatrix) { if (canvas?.DOMMatrix) {...}
// else { warn(...) } } }` -- se `globalThis.DOMMatrix`/`Path2D` já
// existirem quando o módulo carrega, o pdf.js não tenta obtê-los de
// `@napi-rs/canvas` e não lança `ReferenceError`. Preenchemos esses
// globals porque essa dependência opcional foi deliberadamente omitida
// na instalação (--omit=optional).
//
// POLÍTICA: só construção e leitura de propriedade (a,b,c,d,e,f,is2D)
// funcionam de verdade -- o suficiente pra `new DOMMatrix()` no
// carregamento do módulo (`SCALE_MATRIX`) não lançar. TODO método de
// transformação (multiply/inverse/translate/scale/rotate/etc.) e TODO
// método de desenho do Path2D FALHAM explicitamente se chamados -- nunca
// calculam nem desenham nada, nunca mascaram uso acidental de
// renderização com um resultado geométrico inventado. Confirmado por
// leitura do código-fonte instalado que os únicos usos REAIS desses
// métodos (grep por ".multiply(|.inverse()|domMatrix.(scale|translate)("
// no arquivo) ficam inteiramente dentro de código de RENDERIZAÇÃO EM
// CANVAS (padrão de preenchimento de gradiente, clipping de contorno de
// glifo, editor de anotação) -- nenhum alcançável a partir de
// getDocument -> getPage -> getTextContent, o único caminho que este
// worker usa. Se isso um dia deixar de ser verdade (nova versão do
// pdf.js, ou um caminho de código não mapeado), a falha é EXPLÍCITA e
// sanitizada (PdfCompatibilityShimError) -- nunca um resultado inventado
// silenciosamente, e quem chama recebe um código de erro específico
// (SHIM_METHOD_CALLED) pra investigar, em vez de um erro genérico.
class PdfCompatibilityShimError extends Error {
  constructor(detail) {
    super(`PDF rendering compatibility shim invoked outside its supported scope: ${detail}`); // nunca stack/caminho -- só o nome do método
    this.name = this.constructor.name;
    this.code = "SHIM_METHOD_CALLED";
  }
}

class MinimalDOMMatrix {
  constructor(init) {
    if (init === undefined) {
      this.a = 1;
      this.b = 0;
      this.c = 0;
      this.d = 1;
      this.e = 0;
      this.f = 0;
    } else if (Array.isArray(init) && init.length === 6 && init.every((n) => typeof n === "number" && Number.isFinite(n))) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    } else {
      throw new PdfCompatibilityShimError("DOMMatrix constructor requires no arguments or an array of exactly 6 finite numbers");
    }
  }
  get is2D() {
    return true;
  }
  get isIdentity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }
}
const DOM_MATRIX_UNSUPPORTED_METHODS = [
  "multiply", "multiplySelf", "preMultiplySelf", "inverse", "invertSelf",
  "translate", "translateSelf", "scale", "scaleSelf", "scale3d", "scale3dSelf",
  "rotate", "rotateSelf", "rotateAxisAngle", "rotateAxisAngleSelf",
  "rotateFromVector", "rotateFromVectorSelf", "skewX", "skewXSelf",
  "skewY", "skewYSelf", "flipX", "flipY", "transformPoint",
  "toFloat32Array", "toFloat64Array", "setMatrixValue",
];
for (const name of DOM_MATRIX_UNSUPPORTED_METHODS) {
  MinimalDOMMatrix.prototype[name] = function unsupportedDOMMatrixMethod() {
    throw new PdfCompatibilityShimError(`DOMMatrix.${name}() -- text extraction never needs matrix transforms; intentionally unimplemented`);
  };
}

class MinimalPath2D {
  constructor() {} // construir nunca é "desenhar" -- só os métodos de desenho abaixo falham
}
const PATH2D_UNSUPPORTED_METHODS = ["moveTo", "lineTo", "rect", "roundRect", "closePath", "bezierCurveTo", "arc", "arcTo", "ellipse", "quadraticCurveTo", "addPath"];
for (const name of PATH2D_UNSUPPORTED_METHODS) {
  MinimalPath2D.prototype[name] = function unsupportedPath2DMethod() {
    throw new PdfCompatibilityShimError(`Path2D.${name}() -- text extraction never draws; intentionally unimplemented`);
  };
}

if (!globalThis.DOMMatrix) globalThis.DOMMatrix = MinimalDOMMatrix;
if (!globalThis.Path2D) globalThis.Path2D = MinimalPath2D;

const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

const __dirname = dirname(fileURLToPath(import.meta.url));
const PDFJS_DIST_DIR = join(__dirname, "..", "..", "node_modules", "pdfjs-dist");
// Sempre file:// local, construído a partir do próprio caminho instalado
// -- nunca de um valor `data:`/`http:`/`https:`, nunca de qualquer coisa
// extraída do conteúdo do PDF do usuário.
const CMAP_URL = pathToFileURL(join(PDFJS_DIST_DIR, "cmaps") + "/").href;
const STANDARD_FONT_DATA_URL = pathToFileURL(join(PDFJS_DIST_DIR, "standard_fonts") + "/").href;

// --- Preflight estrutural (heurística por token, mesma técnica já usada
// na auditoria read-only -- roda ANTES do pdf.js abrir o documento) -----

const MAGIC_BYTES = "%PDF-";

// /Encrypt é REJEIÇÃO DURA -- este sistema nunca tenta senha nenhuma,
// nunca assume "sem senha de usuário == seguro o bastante". Os demais
// tokens (conteúdo ativo que este processo estruturalmente NUNCA executa,
// dado que só a API de texto é chamada) viram ALERTA, não rejeição --
// exatamente como instruído: "não rejeite necessariamente todo arquivo
// apenas pela presença passiva desses tokens se a arquitetura comprovar
// que nunca serão executados".
const WARNING_TOKENS = [
  ["OPEN_ACTION", /\/OpenAction\b/],
  ["LAUNCH_ACTION", /\/Launch\b/],
  ["EMBEDDED_FILE", /\/EmbeddedFile\b/],
  ["XFA_FORM", /\/XFA\b/],
  ["JAVASCRIPT", /\/JavaScript\b/],
  ["JS_ACTION", /\/JS\b/],
  ["ADDITIONAL_ACTIONS", /\/AA\b/],
  ["URI_LINK", /\/URI\b/],
];

function preflight(buffer) {
  const head = buffer.subarray(0, 1024).toString("latin1");
  if (!head.startsWith(MAGIC_BYTES)) {
    return { ok: false, code: "INVALID_MAGIC_BYTES" };
  }
  // Varredura de token roda sobre o buffer inteiro em latin1 (1 byte = 1
  // char, preserva offset binário) -- mesma técnica da auditoria
  // read-only anterior, aqui reaproveitada como parte real do produto.
  const text = buffer.toString("latin1");
  if (/\/Encrypt\b/.test(text)) {
    return { ok: false, code: "ENCRYPTED" };
  }
  const warnings = [];
  for (const [code, re] of WARNING_TOKENS) {
    if (re.test(text)) warnings.push(code);
  }
  return { ok: true, warnings };
}

// --- Reconstrução de texto por página a partir dos itens do pdf.js -----

// Limiar de espaçamento GENÉRICO (não ajustado a nenhuma frase/documento
// específico): um "gap" horizontal entre o fim do item anterior e o
// início do item atual maior que esta fração da altura do item anterior
// (proxy padrão pro tamanho da fonte) é tratado como espaço de palavra.
// Técnica padrão de reconstrução de texto de PDF (mesmo princípio usado
// por leitores de PDF pra decidir onde inserir espaço entre "runs" de
// glifos que o próprio pdf.js já agrupou).
const SPACE_GAP_RATIO = 0.25;
// Diferença vertical (mesma unidade de userspace do PDF) acima da qual
// dois itens são tratados como linhas DIFERENTES, não a mesma linha.
const LINE_Y_TOLERANCE = 2;

function itemsToRawText(items) {
  let out = "";
  let prevItem = null;
  let itemCount = 0;
  for (const item of items) {
    if (typeof item.str !== "string") continue; // itens sem string (ex.: marcadores) são ignorados, nunca viram lixo no texto
    itemCount += 1;
    if (item.str === "") {
      continue; // string vazia não produz caractere nem altera a linha/posição de referência
    }
    if (prevItem) {
      const prevY = prevItem.transform[5];
      const curY = item.transform[5];
      const sameLine = Math.abs(curY - prevY) <= LINE_Y_TOLERANCE;
      if (!sameLine) {
        out += "\n";
      } else {
        const prevEndX = prevItem.transform[4] + (prevItem.width || 0);
        const curStartX = item.transform[4];
        const gap = curStartX - prevEndX;
        const glyphSizeEstimate = Math.abs(prevItem.transform[3]) || Math.abs(prevItem.height) || 10;
        if (gap > glyphSizeEstimate * SPACE_GAP_RATIO && !/\s$/.test(out)) {
          out += " ";
        }
      }
    }
    out += item.str;
    prevItem = item;
  }
  return { text: out, itemCount };
}

async function extractPages(buffer, { pages, maxPages, maxOutputCharsPerPage }) {
  // pdf.js exige Uint8Array "puro" (constructor === Uint8Array) -- um
  // Buffer do Node, embora seja tecnicamente uma subclasse/view de
  // Uint8Array, é rejeitado pela checagem interna do pdf.js. Conversão
  // sem cópia (mesma memória, só uma view diferente sobre o mesmo buffer).
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
  const loadingTask = pdfjsLib.getDocument({
    data,
    // -- desligamentos de segurança explícitos --
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    // -- recursos só locais, do próprio pacote instalado, nunca `url` --
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    verbosity: 0,
  });

  let pdfDocument;
  try {
    pdfDocument = await loadingTask.promise;
    assertNoNetworkAttempts();
  } catch (err) {
    if (err instanceof NetworkAccessBlockedError) throw err;
    const name = err && err.name;
    if (name === "PasswordException") {
      return { ok: false, code: "ENCRYPTED" };
    }
    if (name === "InvalidPDFException") {
      return { ok: false, code: "MALFORMED" };
    }
    return { ok: false, code: "LOAD_FAILED" };
  }

  try {
    const numPages = pdfDocument.numPages;
    const requested = Array.isArray(pages) && pages.length > 0 ? pages : Array.from({ length: Math.min(numPages, maxPages) }, (_, i) => i + 1);
    const clampedMaxPages = Math.min(maxPages, requested.length);
    const validPages = [];
    const outOfRangeRequested = [];
    for (const p of requested) {
      if (validPages.length >= clampedMaxPages) break;
      if (Number.isInteger(p) && p >= 1 && p <= numPages) {
        validPages.push(p);
      } else {
        outOfRangeRequested.push(p);
      }
    }

    const pageResults = [];
    for (const pageNumber of validPages) {
      const page = await pdfDocument.getPage(pageNumber);
      try {
        const textContent = await page.getTextContent();
        assertNoNetworkAttempts();
        const { text, itemCount } = itemsToRawText(textContent.items);
        const truncated = text.length > maxOutputCharsPerPage;
        const rawText = truncated ? text.slice(0, maxOutputCharsPerPage) : text;
        pageResults.push({
          page: pageNumber,
          rawText,
          charCount: rawText.length,
          itemCount,
          isEmpty: rawText.trim().length === 0,
          truncated,
        });
      } finally {
        page.cleanup(); // libera recursos da página imediatamente, não espera o documento inteiro terminar
      }
    }

    assertNoNetworkAttempts(); // checkpoint final -- se QUALQUER chamada de rede aconteceu em qualquer ponto, a extração inteira falha aqui, nunca devolve resultado parcial
    return {
      ok: true,
      numPages,
      pages: pageResults,
      outOfRangeRequested,
    };
  } finally {
    await loadingTask.destroy(); // libera o documento (e o transporte interno do pdf.js) -- SEMPRE, mesmo se algo acima lançou (rede bloqueada, erro do shim, ou qualquer outro)
  }
}

// --- Protocolo IPC: mensagem única de entrada, mensagem única de saída --

function isValidRequest(msg) {
  return (
    msg &&
    typeof msg === "object" &&
    msg.type === "extract" &&
    Buffer.isBuffer(msg.buffer) &&
    (msg.pages === null || (Array.isArray(msg.pages) && msg.pages.every((p) => Number.isInteger(p)))) &&
    Number.isInteger(msg.maxPages) &&
    msg.maxPages > 0 &&
    Number.isInteger(msg.maxOutputCharsPerPage) &&
    msg.maxOutputCharsPerPage > 0
  );
}

/** Envia a resposta e SEMPRE encerra este processo em seguida -- nunca fica esperando por uma segunda mensagem, nunca conta só com o processo pai matá-lo. `process.send` é assíncrono; o `exit` só roda depois que a mensagem realmente saiu. */
function respondAndExit(msg, exitCode) {
  if (typeof process.send === "function") {
    process.send(msg, () => process.exit(exitCode));
  } else {
    process.exit(exitCode);
  }
}

process.on("message", async (msg) => {
  if (!isValidRequest(msg)) {
    respondAndExit({ type: "error", code: "INVALID_REQUEST" }, 1);
    return;
  }

  const pre = preflight(msg.buffer);
  if (!pre.ok) {
    respondAndExit({ type: "error", code: pre.code }, 1);
    return;
  }

  try {
    const result = await extractPages(msg.buffer, {
      pages: msg.pages,
      maxPages: msg.maxPages,
      maxOutputCharsPerPage: msg.maxOutputCharsPerPage,
    });
    if (!result.ok) {
      respondAndExit({ type: "error", code: result.code }, 1);
      return;
    }
    respondAndExit(
      {
        type: "result",
        numPages: result.numPages,
        pages: result.pages,
        outOfRangeRequested: result.outOfRangeRequested,
        documentWarnings: pre.warnings,
        networkAccessAttempts: getNetworkAttemptCount(), // métrica sanitizada -- só a contagem, nunca detalhe da tentativa
      },
      0
    );
  } catch (err) {
    // Nunca propaga stack/mensagem real do erro pro pai -- código
    // sanitizado só, mesma disciplina de documentStore.js. Erros de rede
    // bloqueada e do shim de compatibilidade já têm `.code` próprio e
    // específico (nunca incluem stack/caminho na própria mensagem, ver
    // classes acima); qualquer outro erro vira o código genérico.
    const code = err && (err.code === "NETWORK_ACCESS_BLOCKED" || err.code === "SHIM_METHOD_CALLED") ? err.code : "INTERNAL_ERROR";
    respondAndExit({ type: "error", code }, 1);
  }
});

// Exports só pra prova de bloqueio em runtime (ver
// test/knowledgeDocuments/pdfExtractor.test.js) -- NUNCA usados pelo
// protocolo IPC de produção acima, que só reage a `process.on("message")`.
// Importar este arquivo já instala os bloqueios de rede (efeito colateral
// no `globalThis` do processo que importar -- por isso o teste que usa
// isto sempre roda num processo Node totalmente separado e descartável,
// nunca no processo do test runner).
export { installNetworkGuards, getNetworkAttemptCount, NetworkAccessBlockedError, NetworkGuardInstallationError, PdfCompatibilityShimError, MinimalDOMMatrix, MinimalPath2D };

// Normalização de texto extraído de PDF -- PURO (nenhum I/O, nenhuma
// dependência, nenhuma referência a arquivo/rede/banco). Conservador e
// determinístico de propósito: nunca "inventa" palavras, nunca conserta
// frases específicas, nunca decide o que o texto "deveria" dizer -- só
// normaliza forma (Unicode, quebras de linha, controles), nunca conteúdo.
// O texto bruto (antes desta função) é sempre preservado separadamente por
// quem chama (ver pdfExtractor.js: `rawText` e `normalizedText` nunca se
// sobrescrevem) -- esta função nunca é a única cópia do texto.

const MAX_INPUT_LENGTH = 2_000_000; // teto defensivo por chamada -- nunca processa uma string arbitrariamente grande numa função síncrona pura

// Controles ASCII proibidos: todo C0 (0x00-0x1F) e DEL (0x7F) EXCETO '\n'
// (0x0A) e '\t' (0x09), que são preservados por serem estrutura de texto
// legítima. '\r' (0x0D) é removido aqui porque a normalização de quebra de
// linha (abaixo) já o consome antes desta etapa.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Normaliza quebras de linha para '\n' puro (CRLF/CR -> LF) -- passo
 * isolado e testável, sem nenhuma outra transformação.
 */
function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Remove NUL e caracteres de controle proibidos (ver FORBIDDEN_CONTROL_RE).
 * Nunca remove '\n' ou '\t'. Passo isolado e testável.
 */
function stripForbiddenControls(text) {
  return text.replace(FORBIDDEN_CONTROL_RE, "");
}

/**
 * Colapsa espaços/tabs horizontais redundantes (2+ em sequência -> 1),
 * SEM tocar em quebras de linha -- preserva parágrafos (linhas em branco
 * intencionais, ex.: '\n\n\n' nunca viram '\n\n' aqui; só espaço
 * HORIZONTAL redundante é colapsado). Passo isolado, conservador: nunca
 * insere espaço onde não havia nenhum (isso seria "inventar" estrutura),
 * só reduz repetição já presente.
 */
function collapseHorizontalWhitespace(text) {
  return text.replace(/[ \t]{2,}/g, " ");
}

/**
 * Remove espaços/tabs no fim de cada linha (trailing whitespace) --
 * cosmético, nunca afeta conteúdo nem estrutura de parágrafo.
 */
function trimTrailingLineWhitespace(text) {
  return text.replace(/[ \t]+\n/g, "\n").replace(/[ \t]+$/g, "");
}

/**
 * Colapsa 3+ quebras de linha consecutivas em exatamente 2 (um separador
 * de parágrafo canônico) -- preserva a DISTINÇÃO entre "mesma linha"
 * (nenhuma quebra), "quebra de linha simples" (1 '\n') e "parágrafo novo"
 * (2+ '\n') sem jamais destruir a distinção em si, só normaliza o excesso.
 */
function collapseParagraphBreaks(text) {
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Normalização Unicode NFKC -- "quando seguro": aplica só a forma de
 * compatibilidade canônica padrão do próprio JS (`String.prototype.normalize`),
 * nunca uma tabela de substituição arbitrária escrita por nós. Resolve de
 * forma padrão e documentada casos como ligaduras tipográficas (ex.: "ﬁ"
 * U+FB01 -> "fi") sem jamais trocar o SIGNIFICADO de nenhuma palavra --
 * é uma normalização de FORMA de caractere, não de conteúdo.
 */
function normalizeUnicode(text) {
  try {
    return text.normalize("NFKC");
  } catch {
    return text; // entrada que o motor não consegue normalizar -- devolve como veio, nunca lança
  }
}

/**
 * Pipeline completo, na ordem documentada abaixo. Pura, síncrona,
 * determinística: mesma entrada sempre produz a mesma saída. Nunca lança
 * para entrada string válida (mesmo vazia); entrada não-string ou maior
 * que MAX_INPUT_LENGTH lança TextNormalizationError explicitamente (fail
 * closed, nunca processa parcialmente algo fora do contrato).
 *
 * Ordem: (1) quebras de linha -> '\n' puro; (2) remove controles
 * proibidos; (3) NFKC; (4) colapsa espaço horizontal redundante;
 * (5) remove espaço no fim de linha; (6) colapsa excesso de linhas em
 * branco preservando a distinção linha/parágrafo.
 */
function normalizeExtractedText(rawText) {
  if (typeof rawText !== "string") {
    throw new TextNormalizationError("rawText must be a string");
  }
  if (rawText.length > MAX_INPUT_LENGTH) {
    throw new TextNormalizationError(`rawText exceeds the maximum length of ${MAX_INPUT_LENGTH} characters`);
  }
  let text = rawText;
  text = normalizeLineEndings(text);
  text = stripForbiddenControls(text);
  text = normalizeUnicode(text);
  text = collapseHorizontalWhitespace(text);
  text = trimTrailingLineWhitespace(text);
  text = collapseParagraphBreaks(text);
  return text;
}

class TextNormalizationError extends Error {
  constructor(detail) {
    super(`Invalid input for text normalization: ${detail}`);
    this.name = this.constructor.name;
    this.code = "TEXT_NORMALIZATION_ERROR";
  }
}

module.exports = {
  normalizeExtractedText,
  normalizeLineEndings,
  stripForbiddenControls,
  collapseHorizontalWhitespace,
  trimTrailingLineWhitespace,
  collapseParagraphBreaks,
  normalizeUnicode,
  TextNormalizationError,
  MAX_INPUT_LENGTH,
};

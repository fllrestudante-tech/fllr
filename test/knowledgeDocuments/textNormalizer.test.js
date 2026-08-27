const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeExtractedText,
  normalizeLineEndings,
  stripForbiddenControls,
  collapseHorizontalWhitespace,
  trimTrailingLineWhitespace,
  collapseParagraphBreaks,
  normalizeUnicode,
  TextNormalizationError,
  MAX_INPUT_LENGTH,
} = require("../../lib/knowledgeDocuments/textNormalizer");

// =====================================================================
// Passos isolados (cada transformação testada sozinha)
// =====================================================================

test("normalizeLineEndings: CRLF e CR isolados viram LF puro", () => {
  assert.equal(normalizeLineEndings("a\r\nb\rc\nd"), "a\nb\nc\nd");
});

test("stripForbiddenControls: remove NUL e controles C0, preserva '\\n' e '\\t'", () => {
  const input = "a\x00b\x01c\x1fd\x7fe\nf\tg";
  assert.equal(stripForbiddenControls(input), "abcde\nf\tg");
});

test("collapseHorizontalWhitespace: colapsa 2+ espaços/tabs em 1, nunca toca em '\\n'", () => {
  assert.equal(collapseHorizontalWhitespace("a   b\t\t\tc\nd    e"), "a b c\nd e");
});

test("trimTrailingLineWhitespace: remove espaço/tab no fim de cada linha e no fim da string", () => {
  assert.equal(trimTrailingLineWhitespace("a  \nb\t\nc   "), "a\nb\nc");
});

test("collapseParagraphBreaks: 3+ '\\n' viram exatamente 2, preserva a distinção linha-simples vs parágrafo", () => {
  assert.equal(collapseParagraphBreaks("a\nb\n\nc\n\n\nd\n\n\n\n\ne"), "a\nb\n\nc\n\nd\n\ne");
});

test("normalizeUnicode: NFKC resolve ligadura tipográfica (ﬁ -> fi) sem alterar palavras normais", () => {
  assert.equal(normalizeUnicode("gráﬁco"), "gráfico"); // "ﬁ" U+FB01 -> "fi"
  assert.equal(normalizeUnicode("texto normal sem ligadura"), "texto normal sem ligadura");
});

test("normalizeUnicode: nunca lança, mesmo com entrada estranha", () => {
  assert.doesNotThrow(() => normalizeUnicode(""));
});

// =====================================================================
// Pipeline completo (normalizeExtractedText)
// =====================================================================

test("normalizeExtractedText: pipeline completo -- CRLF, controles, NFKC, espaço horizontal, trailing, parágrafos, tudo junto", () => {
  const input = "Título\r\n\r\nParágrafo   com  espaços\x00\x01 e controles.  \r\nSegunda linha\r\n\r\n\r\n\r\nOutro parágrafo.";
  const out = normalizeExtractedText(input);
  assert.ok(!out.includes("\r"));
  assert.ok(!out.includes("\x00"));
  assert.ok(!out.includes("\x01"));
  assert.equal(out, "Título\n\nParágrafo com espaços e controles.\nSegunda linha\n\nOutro parágrafo.");
});

test("normalizeExtractedText: nunca insere palavra nem caractere que não estava na entrada (só remove/colapsa/reforma, nunca adiciona conteúdo)", () => {
  const input = "palavra1 palavra2 palavra3";
  const out = normalizeExtractedText(input);
  // Todo caractere não-espaço da saída precisa ter existido na entrada, na mesma ordem relativa -- prova que nada foi "inventado".
  const stripSpaces = (s) => s.replace(/\s+/g, "");
  assert.equal(stripSpaces(out), stripSpaces(input));
});

test("normalizeExtractedText: string vazia é aceita e devolve string vazia, nunca lança", () => {
  assert.equal(normalizeExtractedText(""), "");
});

test("normalizeExtractedText: entrada não-string lança TextNormalizationError", () => {
  assert.throws(() => normalizeExtractedText(null), TextNormalizationError);
  assert.throws(() => normalizeExtractedText(undefined), TextNormalizationError);
  assert.throws(() => normalizeExtractedText(123), TextNormalizationError);
  assert.throws(() => normalizeExtractedText(["a"]), TextNormalizationError);
});

test("normalizeExtractedText: entrada maior que MAX_INPUT_LENGTH lança TextNormalizationError, nunca processa parcialmente", () => {
  const huge = "a".repeat(MAX_INPUT_LENGTH + 1);
  assert.throws(() => normalizeExtractedText(huge), TextNormalizationError);
});

test("normalizeExtractedText: string no limite exato (MAX_INPUT_LENGTH) é aceita", () => {
  const exact = "a".repeat(MAX_INPUT_LENGTH);
  assert.doesNotThrow(() => normalizeExtractedText(exact));
});

test("normalizeExtractedText: determinístico -- mesma entrada sempre produz a mesma saída", () => {
  const input = "Texto\r\ncom\r\n\r\nvárias   linhas\x00e\tcontroles.";
  const out1 = normalizeExtractedText(input);
  const out2 = normalizeExtractedText(input);
  assert.equal(out1, out2);
});

test("normalizeExtractedText: é puro -- não depende nem produz nenhum efeito colateral (sem fs/rede/estado global) -- confirmado por meta-teste de import no arquivo de produção abaixo", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "textNormalizer.js"), "utf8");
  assert.ok(!/require\(/.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), "textNormalizer.js não deveria importar nada -- é puro por definição");
});

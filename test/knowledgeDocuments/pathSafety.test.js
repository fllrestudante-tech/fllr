const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { toSafeSourceReference, isSafeLocalRelativePath, isSafeManualReference, sanitizePathForLog } = require("../../lib/knowledgeDocuments/pathSafety");

test("toSafeSourceReference: converte caminho absoluto dentro da raiz do projeto em referência relativa", () => {
  const root = path.join("C:", "Users", "Universo", "Desktop", "bot-cripto10");
  const abs = path.join(root, "ManualdoCriptotrader2.0.pdf");
  const result = toSafeSourceReference(abs, root);
  assert.equal(result, "ManualdoCriptotrader2.0.pdf");
});

test("toSafeSourceReference: subpasta dentro da raiz também funciona", () => {
  const root = path.join("C:", "Users", "Universo", "Desktop", "bot-cripto10");
  const abs = path.join(root, "materials", "curso", "aula1.mp4");
  const result = toSafeSourceReference(abs, root);
  assert.equal(result, "materials/curso/aula1.mp4");
});

test("toSafeSourceReference: arquivo FORA da raiz do projeto -- lança, e a mensagem de erro NUNCA contém o caminho pessoal completo", () => {
  const root = path.join("C:", "Users", "Universo", "Desktop", "bot-cripto10");
  const outside = path.join("C:", "Users", "Universo", "Documents", "segredo-pessoal.pdf");
  assert.throws(() => toSafeSourceReference(outside, root));
  try {
    toSafeSourceReference(outside, root);
    assert.fail("deveria ter lançado");
  } catch (err) {
    assert.ok(!err.message.includes("Universo"));
    assert.ok(!err.message.includes("Documents"));
    assert.ok(!err.message.includes("C:"));
    assert.ok(err.message.includes("segredo-pessoal.pdf")); // só o nome-base, isso é aceitável e útil
  }
});

test("isSafeLocalRelativePath: aceita referência relativa simples", () => {
  assert.equal(isSafeLocalRelativePath("ManualdoCriptotrader2.0.pdf"), true);
  assert.equal(isSafeLocalRelativePath("materials/curso/aula1.mp4"), true);
  assert.equal(isSafeLocalRelativePath("knowledge-input/velatrader/manual.pdf"), true);
});

test("isSafeLocalRelativePath: rejeita caminho absoluto (Windows e Unix) e travessia de diretório", () => {
  assert.equal(isSafeLocalRelativePath("C:\\Users\\Universo\\manual.pdf"), false);
  assert.equal(isSafeLocalRelativePath("/etc/passwd"), false);
  assert.equal(isSafeLocalRelativePath("../../../etc/passwd"), false);
  assert.equal(isSafeLocalRelativePath("materials/../../../escape.pdf"), false);
});

test("isSafeLocalRelativePath: lista completa de padrões proibidos pedida na revisão focalizada -- UNC, device path, file:, mistura de separador", () => {
  const forbidden = [
    "C:\\Users\\Nome\\arquivo.pdf",
    "\\\\servidor\\pasta\\arquivo.pdf", // UNC
    "\\\\?\\C:\\arquivo.pdf", // device path
    "..\\arquivo.pdf",
    "pasta\\..\\arquivo.pdf",
    "/pasta/arquivo.pdf",
    "file:///C:/arquivo.pdf", // esquema de URL -- não pegava na regex antiga, corrigido nesta rodada
  ];
  for (const reference of forbidden) {
    assert.equal(isSafeLocalRelativePath(reference), false, `"${reference}" deveria ser rejeitado`);
  }
  const allowed = ["ManualdoCriptotrader2.0.pdf", "knowledge-input/velatrader/manual.pdf"];
  for (const reference of allowed) {
    assert.equal(isSafeLocalRelativePath(reference), true, `"${reference}" deveria ser aceito`);
  }
});

test("isSafeLocalRelativePath: entrada não-string ou vazia é rejeitada, nunca lança", () => {
  assert.equal(isSafeLocalRelativePath(""), false);
  assert.equal(isSafeLocalRelativePath(null), false);
  assert.equal(isSafeLocalRelativePath(undefined), false);
  assert.equal(isSafeLocalRelativePath(123), false);
});

test("isSafeManualReference: aceita texto livre curto, rejeita se parecer caminho local ou URL", () => {
  assert.equal(isSafeManualReference("Transcrição será fornecida manualmente pelo usuário"), true);
  assert.equal(isSafeManualReference("Aguardando arquivo local do usuário"), true);
  assert.equal(isSafeManualReference("C:\\Users\\Nome\\arquivo.pdf"), false);
  assert.equal(isSafeManualReference("https://example.com/video"), false);
  assert.equal(isSafeManualReference("../../../etc/passwd"), false);
  assert.equal(isSafeManualReference(""), false);
  assert.equal(isSafeManualReference(null), false);
});

test("isSafeManualReference: endurecimento desta rodada -- nunca aceita '/' em qualquer posição, nem referência evidente de arquivo (nome.ext isolado, sem espaço)", () => {
  const forbidden = [
    "manual.pdf", // nome de arquivo isolado, sem separador nenhum -- ainda assim rejeitado
    "pasta/manual.pdf",
    "C:\\manual.pdf",
    "https://example.com/manual",
  ];
  for (const reference of forbidden) {
    assert.equal(isSafeManualReference(reference), false, `"${reference}" deveria ser rejeitado`);
  }
  // A frase de exemplo dada na instrução continua aceita -- é descrição, não referência de arquivo.
  assert.equal(isSafeManualReference("Transcrição será fornecida manualmente pelo usuário"), true);
});

test("sanitizePathForLog: devolve só o nome-base, nunca o caminho completo com usuário/máquina", () => {
  const full = path.join("C:", "Users", "Universo", "Desktop", "bot-cripto10", "ManualdoCriptotrader2.0.pdf");
  assert.equal(sanitizePathForLog(full), "ManualdoCriptotrader2.0.pdf");
  assert.ok(!sanitizePathForLog(full).includes("Universo"));
});

test("sanitizePathForLog: entrada inesperada nunca lança, sempre devolve string segura", () => {
  assert.equal(sanitizePathForLog(null), "unknown-file");
  assert.equal(sanitizePathForLog(undefined), "unknown-file");
  assert.equal(sanitizePathForLog(""), "unknown-file");
  assert.equal(sanitizePathForLog(123), "unknown-file");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const {
  extractPdf,
  PdfValidationError,
  PdfEncryptedError,
  PdfMalformedError,
  PdfTimeoutError,
  PdfExtractionError,
  PdfNetworkBlockedError,
  PdfRenderingAttemptedError,
} = require("../../lib/knowledgeDocuments/pdfExtractor");

// =====================================================================
// Fixture sintética mínima -- construída à mão, byte a byte, NUNCA copia
// nenhum conteúdo do manual real. Só um helper de teste, não faz parte da
// arquitetura de produção (por isso vive aqui, não em lib/).
// =====================================================================

function escapePdfString(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildMinimalPdf({ pageTexts = ["Hello World"], extraComment = "" } = {}) {
  const n = pageTexts.length;
  const fontObjNum = 2 + n * 2 + 1;
  const objects = [];

  objects.push({ num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" });

  const kids = [];
  for (let i = 0; i < n; i++) kids.push(`${3 + i * 2} 0 R`);
  objects.push({ num: 2, body: `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>` });

  for (let i = 0; i < n; i++) {
    const pageObjNum = 3 + i * 2;
    const contentObjNum = 4 + i * 2;
    objects.push({
      num: pageObjNum,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${contentObjNum} 0 R >>`,
    });
    const streamContent = `BT /F1 12 Tf 72 700 Td (${escapePdfString(pageTexts[i])}) Tj ET`;
    objects.push({
      num: contentObjNum,
      body: `<< /Length ${Buffer.byteLength(streamContent, "latin1")} >>\nstream\n${streamContent}\nendstream`,
    });
  }

  objects.push({ num: fontObjNum, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" });
  objects.sort((a, b) => a.num - b.num);

  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = new Map();
  for (const obj of objects) {
    offsets.set(obj.num, Buffer.byteLength(out, "latin1"));
    out += `${obj.num} 0 obj\n${obj.body}\nendobj\n`;
  }
  if (extraComment) out += `% ${extraComment}\n`;

  const xrefOffset = Buffer.byteLength(out, "latin1");
  const maxObjNum = Math.max(...objects.map((o) => o.num));
  let xref = `xref\n0 ${maxObjNum + 1}\n0000000000 65535 f \n`;
  for (let num = 1; num <= maxObjNum; num++) {
    const off = offsets.get(num);
    xref += off == null ? "0000000000 00000 f \n" : `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  out += xref;
  out += `trailer\n<< /Size ${maxObjNum + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(out, "latin1");
}

async function withTempPdf(buffer, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-pdf-extractor-"));
  const filePath = path.join(dir, "fixture.pdf");
  fs.writeFileSync(filePath, buffer);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  try {
    return await fn(filePath, sha256); // await é essencial -- sem ele o `finally` abaixo apaga o diretório antes de `fn` (que pode fazer múltiplas chamadas assíncronas) terminar
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// =====================================================================
// Extração válida
// =====================================================================

test("extractPdf: PDF textual válido -- extrai texto correto por página, determinístico", async () => {
  const buf = buildMinimalPdf({ pageTexts: ["Hello World Page One", "Second page content here"] });
  await withTempPdf(buf, async (filePath, sha256) => {
    const result1 = await extractPdf(filePath, { expectedSha256: sha256 });
    assert.equal(result1.numPages, 2);
    assert.equal(result1.pages.length, 2);
    assert.equal(result1.pages[0].rawText, "Hello World Page One");
    assert.equal(result1.pages[1].rawText, "Second page content here");
    assert.equal(result1.pages[0].isEmpty, false);
    assert.equal(result1.sha256, sha256);
    assert.equal(result1.sizeBytes, buf.length);

    const result2 = await extractPdf(filePath, { expectedSha256: sha256 });
    assert.deepEqual(result1, result2); // determinístico
  });
});

test("extractPdf: campos de reconstrução geométrica presentes por página, sem sobrescrever rawText/normalizedText -- sourceOrderedText/layoutCandidateText e as duas invariantes separadas", async () => {
  const buf = buildMinimalPdf({ pageTexts: ["Hello World Page One"] });
  await withTempPdf(buf, async (filePath, sha256) => {
    const result = await extractPdf(filePath, { expectedSha256: sha256 });
    const p = result.pages[0];
    assert.equal(p.rawText, "Hello World Page One"); // inalterado
    assert.equal(p.normalizedText, "Hello World Page One"); // inalterado
    assert.equal(typeof p.sourceOrderedText, "string");
    assert.equal(p.sourceOrderedText, "Hello World Page One");
    assert.equal(typeof p.layoutCandidateText, "string");
    assert.equal(p.reconstructionApplied, true);
    assert.equal(typeof p.reconstructionConfidence, "number");
    assert.equal(typeof p.reconstructionDiagnostics, "object");
    assert.equal(typeof p.ambiguousGapCount, "number");
    assert.equal(typeof p.lineCount, "number");
    assert.equal(typeof p.orientationGroups, "number");
    assert.equal(typeof p.layoutCandidateMultisetInvariant, "boolean");
    assert.equal(typeof p.layoutCandidateAmbiguousGapCount, "number");
    assert.equal(typeof p.layoutCandidateLineCount, "number");
    assert.equal(typeof p.layoutCandidateOrderDiverged, "boolean");
    // As duas invariantes, separadas -- característica central desta rodada:
    // multiconjunto NUNCA prova ordem, então são campos distintos.
    assert.equal(p.characterMultisetInvariant, true);
    assert.equal(p.sourceOrderInvariant, true);
    assert.equal("nonWhitespaceInvariant" in p, false); // nome ambíguo removido -- não fica nem como alias
    assert.equal("reconstructedText" in p, false); // campo antigo removido -- substituído pelas duas representações
    assert.ok(["good", "review_required", "poor", "image_only"].includes(p.qualityStatus));
  });
});

test("extractPdf: acentuação e ligadura sobrevivem à extração e à normalização (WinAnsiEncoding)", async () => {
  const buf = buildMinimalPdf({ pageTexts: ["Codificação e acentuação ok"] });
  await withTempPdf(buf, async (filePath, sha256) => {
    const result = await extractPdf(filePath, { expectedSha256: sha256 });
    assert.equal(result.pages[0].rawText, "Codificação e acentuação ok");
    assert.equal(result.pages[0].normalizedText, "Codificação e acentuação ok");
  });
});

test("extractPdf: página fora do intervalo -- não derruba a extração, é reportada em outOfRangeRequested", async () => {
  const buf = buildMinimalPdf({ pageTexts: ["Page A", "Page B"] });
  await withTempPdf(buf, async (filePath, sha256) => {
    const result = await extractPdf(filePath, { expectedSha256: sha256, pages: [1, 999] });
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].page, 1);
    assert.deepEqual(result.outOfRangeRequested, [999]);
  });
});

test("extractPdf: máximo de páginas é respeitado mesmo pedindo mais", async () => {
  const buf = buildMinimalPdf({ pageTexts: ["P1", "P2", "P3", "P4"] });
  await withTempPdf(buf, async (filePath, sha256) => {
    const result = await extractPdf(filePath, { expectedSha256: sha256, maxPages: 2 });
    assert.equal(result.pages.length, 2);
    assert.deepEqual(result.pagesProcessed, [1, 2]);
  });
});

test("extractPdf: limite de saída por página trunca e sinaliza truncated:true", async () => {
  const longText = "A".repeat(500);
  const buf = buildMinimalPdf({ pageTexts: [longText] });
  await withTempPdf(buf, async (filePath, sha256) => {
    const result = await extractPdf(filePath, { expectedSha256: sha256, maxOutputCharsPerPage: 50 });
    assert.equal(result.pages[0].truncated, true);
    assert.equal(result.pages[0].charCount, 50);
  });
});

test("extractPdf: truncamento de sourceOrderedText invalida as duas garantias (nunca finge sucesso parcial) e a página nunca fica 'good'", async () => {
  const longText = Array.from({ length: 30 }, (_, i) => `palavra${i}`).join(" "); // texto real, com espaços de verdade -- não é o caso degenerado de glifo único
  const buf = buildMinimalPdf({ pageTexts: [longText] });
  await withTempPdf(buf, async (filePath, sha256) => {
    const resultFull = await extractPdf(filePath, { expectedSha256: sha256 });
    assert.equal(resultFull.pages[0].sourceOrderedTruncated, false);

    const resultTruncated = await extractPdf(filePath, { expectedSha256: sha256, maxOutputCharsPerPage: 20 });
    const p = resultTruncated.pages[0];
    assert.equal(p.sourceOrderedTruncated, true);
    assert.equal(p.sourceOrderedText.length, 20);
    // Corte no meio da sequência original -- as duas invariantes têm que
    // cair, nunca permanecer true contra um texto que não é mais o texto
    // inteiro que elas descreviam.
    assert.equal(p.characterMultisetInvariant, false);
    assert.equal(p.sourceOrderInvariant, false);
    assert.equal(p.reconstructionConfidence, 0);
    assert.notEqual(p.qualityStatus, "good");
    assert.equal(p.qualityStatus, "poor"); // invariância quebrada é sempre "poor", regra dura, mesmo sendo truncamento e não corrupção
  });
});

// =====================================================================
// Integridade / TOCTOU
// =====================================================================

test("extractPdf: hash divergente é rejeitado ANTES de qualquer parsing, erro nunca inclui o hash", async () => {
  const buf = buildMinimalPdf({ pageTexts: ["texto qualquer"] });
  await withTempPdf(buf, async (filePath) => {
    const wrongHash = "0".repeat(64);
    await assert.rejects(
      () => extractPdf(filePath, { expectedSha256: wrongHash }),
      (err) => {
        assert.ok(err instanceof PdfValidationError);
        assert.ok(!err.message.includes(wrongHash));
        return true;
      }
    );
  });
});

test("extractPdf: hash sintético/vazio nunca é aceito -- expectedSha256 é sempre obrigatório e validado como 64 hex", async () => {
  const buf = buildMinimalPdf({ pageTexts: ["x"] });
  await withTempPdf(buf, async (filePath) => {
    await assert.rejects(() => extractPdf(filePath, {}), PdfValidationError);
    await assert.rejects(() => extractPdf(filePath, { expectedSha256: "" }), PdfValidationError);
    await assert.rejects(() => extractPdf(filePath, { expectedSha256: "nao-e-hex" }), PdfValidationError);
    await assert.rejects(() => extractPdf(filePath, { expectedSha256: "a".repeat(63) }), PdfValidationError);
  });
});

test("extractPdf: tamanho acima do limite é rejeitado antes de ler o conteúdo pra extração", async () => {
  const buf = buildMinimalPdf({ pageTexts: ["conteudo".repeat(1000)] });
  await withTempPdf(buf, async (filePath, sha256) => {
    await assert.rejects(() => extractPdf(filePath, { expectedSha256: sha256, maxSizeBytes: 10 }), PdfValidationError);
  });
});

test("extractPdf: devolve hash, tamanho e páginas processadas -- sempre os valores REAIS, nunca fictícios", async () => {
  const buf = buildMinimalPdf({ pageTexts: ["A", "B", "C"] });
  await withTempPdf(buf, async (filePath, sha256) => {
    const result = await extractPdf(filePath, { expectedSha256: sha256, pages: [1, 3] });
    assert.equal(result.sha256, sha256);
    assert.equal(result.sizeBytes, buf.length);
    assert.equal(result.numPages, 3);
    assert.deepEqual(result.pagesProcessed, [1, 3]);
  });
});

test("extractPdf: caminho pessoal nunca aparece na mensagem de erro pública", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-pdf-extractor-"));
  const filePath = path.join(dir, "arquivo-pessoal-secreto.pdf");
  try {
    await assert.rejects(
      () => extractPdf(filePath, { expectedSha256: "a".repeat(64) }),
      (err) => {
        assert.ok(err instanceof PdfValidationError);
        assert.ok(!err.message.includes(dir));
        assert.ok(!err.message.includes("Universo"));
        return true;
      }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractPdf: filePath relativo ou não-string é rejeitado", async () => {
  await assert.rejects(() => extractPdf("relative/path.pdf", { expectedSha256: "a".repeat(64) }), PdfValidationError);
  await assert.rejects(() => extractPdf(null, { expectedSha256: "a".repeat(64) }), PdfValidationError);
});

// =====================================================================
// Arquivo inválido / malformado / criptografado
// =====================================================================

test("extractPdf: magic bytes inválidos são rejeitados", async () => {
  const buf = Buffer.from("isto nao e um pdf de jeito nenhum, so texto qualquer", "utf8");
  await withTempPdf(buf, async (filePath, sha256) => {
    await assert.rejects(() => extractPdf(filePath, { expectedSha256: sha256 }), PdfMalformedError);
  });
});

test("extractPdf: arquivo corrompido (cabeçalho válido, corpo truncado) falha de forma controlada, nunca derruba o processo", async () => {
  const buf = buildMinimalPdf({ pageTexts: ["texto que nunca sera lido"] });
  const truncated = buf.subarray(0, Math.floor(buf.length / 2));
  await withTempPdf(truncated, async (filePath, sha256) => {
    await assert.rejects(() => extractPdf(filePath, { expectedSha256: sha256 }), (err) => {
      assert.ok(err instanceof PdfMalformedError || err instanceof PdfExtractionError);
      return true;
    });
  });
});

test("extractPdf: /Encrypt é rejeitado com PdfEncryptedError -- este sistema nunca tenta senha", async () => {
  const buf = buildMinimalPdf({ pageTexts: ["conteudo irrelevante"], extraComment: "/Encrypt 99 0 R" });
  await withTempPdf(buf, async (filePath, sha256) => {
    await assert.rejects(() => extractPdf(filePath, { expectedSha256: sha256 }), PdfEncryptedError);
  });
});

// =====================================================================
// Conteúdo ativo -- alerta, nunca execução (o manual real contém /AA,
// /JS, /URI -- não pode ser rejeitado só pela presença passiva)
// =====================================================================

test("extractPdf: tokens de conteúdo ativo (/JavaScript, /AA, /URI, /OpenAction) viram alerta e a extração continua em modo texto seguro", async () => {
  const buf = buildMinimalPdf({
    pageTexts: ["conteudo normal do documento"],
    extraComment: "/JavaScript /AA /URI /OpenAction /Launch /EmbeddedFile /XFA (tokens de teste, nunca executados)",
  });
  await withTempPdf(buf, async (filePath, sha256) => {
    const result = await extractPdf(filePath, { expectedSha256: sha256 });
    assert.equal(result.pages[0].rawText, "conteudo normal do documento"); // extração aconteceu normalmente
    assert.ok(result.documentWarnings.includes("JAVASCRIPT"));
    assert.ok(result.documentWarnings.includes("ADDITIONAL_ACTIONS"));
    assert.ok(result.documentWarnings.includes("URI_LINK"));
    assert.ok(result.documentWarnings.includes("OPEN_ACTION"));
    assert.ok(result.documentWarnings.includes("LAUNCH_ACTION"));
    assert.ok(result.documentWarnings.includes("EMBEDDED_FILE"));
    assert.ok(result.documentWarnings.includes("XFA_FORM"));
  });
});

test("extractPdf: PDF limpo (sem nenhum token ativo) não gera nenhum alerta", async () => {
  const buf = buildMinimalPdf({ pageTexts: ["documento comum, sem nada especial"] });
  await withTempPdf(buf, async (filePath, sha256) => {
    const result = await extractPdf(filePath, { expectedSha256: sha256 });
    assert.deepEqual(result.documentWarnings, []);
  });
});

// =====================================================================
// Isolamento -- timeout, processo filho, ausência de rede
// =====================================================================

test("extractPdf: timeout muito curto lança PdfTimeoutError, e uma chamada seguinte continua funcionando normalmente (sem processo travado)", async () => {
  const buf = buildMinimalPdf({ pageTexts: ["conteudo"] });
  await withTempPdf(buf, async (filePath, sha256) => {
    await assert.rejects(() => extractPdf(filePath, { expectedSha256: sha256, timeoutMs: 1 }), PdfTimeoutError);
    // Prova indireta de limpeza garantida: uma extração normal logo depois funciona sem nenhum resíduo do timeout anterior.
    const result = await extractPdf(filePath, { expectedSha256: sha256 });
    assert.equal(result.pages[0].rawText, "conteudo");
  });
}, { timeout: 30_000 });

test("extractPdf: nenhuma dependência de rede -- import/require de http/https/net/dns/tls ausente no pai e no filho", () => {
  const files = [
    path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "pdfExtractor.js"),
    path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "pdfExtractorWorker.mjs"),
  ];
  for (const file of files) {
    const src = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.ok(!/require\(\s*["']https?["']\s*\)/.test(src), `${path.basename(file)} não deveria importar http/https`);
    assert.ok(!/from\s+["']node:https?["']/.test(src), `${path.basename(file)} não deveria importar http/https (ESM)`);
    assert.ok(!/require\(\s*["'](net|dns|tls)["']\s*\)/.test(src), `${path.basename(file)} não deveria importar net/dns/tls`);
    assert.ok(!/from\s+["']node:(net|dns|tls)["']/.test(src), `${path.basename(file)} não deveria importar net/dns/tls (ESM)`);
    assert.ok(!src.includes("fetch("), `${path.basename(file)} não deveria chamar fetch()`);
  }
});

test("extractPdf: recursos de fonte/cmap do pdf.js são carregados só localmente (file://), nunca de rede", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "pdfExtractorWorker.mjs"), "utf8");
  assert.ok(src.includes("pathToFileURL"), "cMapUrl/standardFontDataUrl deveriam ser construídos via pathToFileURL (local), não string http literal");
  assert.ok(!/cMapUrl\s*:\s*["']https?:/.test(src));
  assert.ok(!/standardFontDataUrl\s*:\s*["']https?:/.test(src));
});

test("extractPdf: nenhum eval/Function/exec/spawn/shell no worker -- só a API de texto do pdf.js é usada", () => {
  const src = fs
    .readFileSync(path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "pdfExtractorWorker.mjs"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.ok(!/\beval\s*\(/.test(src));
  assert.ok(!/new\s+Function\s*\(/.test(src));
  assert.ok(!/child_process/.test(src));
  assert.ok(!/\.render\s*\(/.test(src), "worker nunca deveria chamar page.render()");
  assert.ok(!/getAnnotations|getAttachments|getJSActions|getOutline/.test(src), "worker nunca deveria chamar APIs de anotação/anexo/JS/outline do pdf.js");
  assert.ok(src.includes("isEvalSupported: false"));
  assert.ok(src.includes("disableFontFace: true"));
  assert.ok(src.includes("useSystemFonts: false"));
});

test("extractPdf: pdfExtractor.js (pai) nunca importa pdfjs-dist diretamente -- só o worker faz parsing", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "pdfExtractor.js"), "utf8");
  assert.ok(!/require\(\s*["']pdfjs-dist/.test(src), "pdfExtractor.js não deveria ter nenhum require() de pdfjs-dist -- só menção em comentário é permitida");
});

test("extractPdf: pdfExtractorWorker.mjs importa textReconstruction.js (geometria real dos itens); textReconstruction.js continua puro, sem nenhum require", () => {
  const workerSrc = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "pdfExtractorWorker.mjs"), "utf8");
  assert.ok(/from\s+["']\.\/textReconstruction\.js["']/.test(workerSrc));
  const reconstructionSrc = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "textReconstruction.js"), "utf8");
  assert.ok(!/require\(/.test(reconstructionSrc.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));
});

test("extractPdf: pdfExtractor.js spawna o worker via fork() com execArgv de memória, serialização advanced e stdio sem herança, nunca via shell/exec/concatenação de comando", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "pdfExtractor.js"), "utf8");
  assert.ok(src.includes('require("child_process")') || src.includes("require('child_process')"));
  assert.ok(!/\bexec\s*\(/.test(src.replace(/\/\/.*$/gm, "")), "nunca usa exec() (shell)");
  assert.ok(!/shell\s*:\s*true/.test(src), "nunca habilita shell: true");
  assert.ok(src.includes('--max-old-space-size='));
  assert.ok(src.includes('serialization: "advanced"'));
  assert.ok(src.includes('stdio: ["ignore", "ignore", "ignore", "ipc"]'));
});

// =====================================================================
// Ausência de banco, IA, estratégia, risco e ordens
// =====================================================================

test("extractPdf: nenhuma dependência de banco/IA/AgentRouter/estratégia/risco/ordens nos 4 arquivos de produção", () => {
  const files = [
    path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "pdfExtractor.js"),
    path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "pdfExtractorWorker.mjs"),
    path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "textNormalizer.js"),
    path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "textReconstruction.js"),
  ];
  const forbidden = ["better-sqlite3", "agentrouter", "aigateway", "bybit", "risk", "tradelifecycle", "openposition", "closeposition", "knowledge_units", "market.db"];
  for (const file of files) {
    const srcNoComments = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .toLowerCase();
    for (const term of forbidden) {
      assert.ok(!srcNoComments.includes(term), `${path.basename(file)} não deveria usar "${term}"`);
    }
  }
});

test("extractPdf: SQLite exclusivamente ausente nos testes deste arquivo -- nenhum better-sqlite3/db real é tocado", () => {
  // Checa o require() real, não uma busca de substring solta -- este
  // próprio arquivo CITA "better-sqlite3" como string dentro da lista de
  // termos proibidos do teste anterior, o que faria uma busca ingênua se
  // autoacusar (mesma categoria de bug já vista e corrigida em
  // documentStore.test.js).
  const src = fs.readFileSync(__filename, "utf8");
  assert.ok(!/require\(\s*["']better-sqlite3["']\s*\)/.test(src));
  assert.ok(src.includes("mkdtempSync")); // confirma padrão de temp dir isolado, mesmo de outros testes da Base de Conhecimento
});

// =====================================================================
// Hardening: bloqueio de rede em runtime + shims de DOMMatrix/Path2D
// (rodada final de hardening do processo filho)
//
// Estes testes IMPORTAM o próprio pdfExtractorWorker.mjs de produção --
// importar esse arquivo já instala os bloqueios de rede e os shims em
// `globalThis` como efeito colateral do módulo. Por isso NUNCA é
// importado diretamente no processo do test runner (isso vazaria
// `globalThis.fetch`/`navigator`/etc. bloqueados pro resto da suíte) --
// sempre um processo Node novo e descartável, via `spawnSync` com argv
// discreto (nunca shell, nunca concatenação de comando). Nenhuma porta ou
// comando IPC novo foi criado só pra teste -- a única superfície nova é a
// exportação ESM já presente no próprio worker
// (installNetworkGuards/getNetworkAttemptCount/NetworkAccessBlockedError/
// PdfCompatibilityShimError/MinimalDOMMatrix/MinimalPath2D), que o
// protocolo IPC de produção (`process.on("message", ...)`) nunca usa.
// =====================================================================

const HARDENING_CHECK_SCRIPT = `
import { pathToFileURL } from "node:url";
const worker = await import(pathToFileURL(process.argv[2]).href);
const results = {};
function check(name, fn) {
  try {
    fn();
    results[name] = { ok: true };
  } catch (err) {
    results[name] = { ok: false, errorName: err && err.name, errorCode: err && err.code, errorMessage: err && err.message };
  }
}

check("fetch_blocked_before_reaching_network", () => {
  let threw = false;
  try {
    globalThis.fetch("http://example.invalid/should-never-be-reached-nor-resolved");
  } catch (e) {
    threw = e instanceof worker.NetworkAccessBlockedError && e.code === "NETWORK_ACCESS_BLOCKED";
  }
  if (!threw) throw new Error("fetch did not throw NetworkAccessBlockedError");
});
check("websocket_blocked", () => {
  let threw = false;
  try { new globalThis.WebSocket("ws://example.invalid"); } catch (e) { threw = e instanceof worker.NetworkAccessBlockedError; }
  if (!threw) throw new Error("WebSocket did not throw");
});
check("eventsource_blocked", () => {
  let threw = false;
  try { new globalThis.EventSource("http://example.invalid"); } catch (e) { threw = e instanceof worker.NetworkAccessBlockedError; }
  if (!threw) throw new Error("EventSource did not throw");
});
check("xmlhttprequest_blocked", () => {
  let threw = false;
  try { new globalThis.XMLHttpRequest(); } catch (e) { threw = e instanceof worker.NetworkAccessBlockedError; }
  if (!threw) throw new Error("XMLHttpRequest did not throw");
});
check("sendbeacon_blocked", () => {
  let threw = false;
  try { globalThis.navigator.sendBeacon("http://example.invalid", "x"); } catch (e) { threw = e instanceof worker.NetworkAccessBlockedError; }
  if (!threw) throw new Error("navigator.sendBeacon did not throw");
});
check("network_attempts_are_counted", () => {
  const before = worker.getNetworkAttemptCount();
  try { globalThis.fetch("http://x"); } catch {}
  try { globalThis.fetch("http://y"); } catch {}
  const after = worker.getNetworkAttemptCount();
  if (after !== before + 2) throw new Error("attempt counter did not increment by 2 (before=" + before + " after=" + after + ")");
});
check("network_error_message_never_includes_url", () => {
  try {
    globalThis.fetch("http://secret-internal-host.invalid/leak?token=abc");
  } catch (e) {
    if (e.message.includes("secret-internal-host") || e.message.includes("token=abc")) throw new Error("error message leaked the URL");
  }
});

const DM = worker.MinimalDOMMatrix;
check("dommatrix_identity", () => {
  const m = new DM();
  if (!(m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0)) throw new Error("constructor without args is not identity");
});
check("dommatrix_construction_preserves_rotation_and_skew", () => {
  const m = new DM([0.5, 0.3, -0.3, 0.5, 10, 20]); // b,c != 0 -- exatamente o formato de rotação/skew presente em transforms reais de itens de texto do pdf.js
  if (!(m.a === 0.5 && m.b === 0.3 && m.c === -0.3 && m.d === 0.5 && m.e === 10 && m.f === 20)) throw new Error("rotation/skew components were not preserved faithfully");
});
check("dommatrix_multiply_fails_explicitly", () => {
  let threw = false;
  try { new DM().multiply(new DM()); } catch (e) { threw = e instanceof worker.PdfCompatibilityShimError && e.code === "SHIM_METHOD_CALLED"; }
  if (!threw) throw new Error("multiply() did not fail explicitly");
});
check("dommatrix_inverse_fails_explicitly", () => {
  let threw = false;
  try { new DM().inverse(); } catch (e) { threw = e instanceof worker.PdfCompatibilityShimError; }
  if (!threw) throw new Error("inverse() did not fail explicitly");
});
check("dommatrix_translate_fails_explicitly", () => {
  let threw = false;
  try { new DM().translate(1, 2); } catch (e) { threw = e instanceof worker.PdfCompatibilityShimError; }
  if (!threw) throw new Error("translate() did not fail explicitly");
});
check("dommatrix_rotate_fails_explicitly", () => {
  let threw = false;
  try { new DM().rotate(45); } catch (e) { threw = e instanceof worker.PdfCompatibilityShimError; }
  if (!threw) throw new Error("rotate() did not fail explicitly");
});
check("dommatrix_singular_matrix_construction_is_faithful_and_inverse_still_fails_explicitly", () => {
  const m = new DM([0, 0, 0, 0, 5, 5]); // a*d - b*c = 0 -- singular
  if (m.a !== 0 || m.d !== 0) throw new Error("singular matrix components were not stored faithfully");
  let threw = false;
  try { m.inverse(); } catch (e) { threw = e instanceof worker.PdfCompatibilityShimError; }
  if (!threw) throw new Error("inverse() of a singular matrix did not fail explicitly (must never silently invent a result)");
});
check("dommatrix_invalid_entries_are_rejected_at_construction", () => {
  const attempts = [() => new DM([1, 2, 3]), () => new DM([1, 2, 3, 4, 5, NaN]), () => new DM("not-an-array"), () => new DM([1, 2, 3, 4, 5, "6"])];
  for (const attempt of attempts) {
    let threw = false;
    try { attempt(); } catch (e) { threw = e instanceof worker.PdfCompatibilityShimError; }
    if (!threw) throw new Error("invalid constructor input was silently accepted");
  }
});

const P2D = worker.MinimalPath2D;
check("path2d_construction_does_not_throw", () => {
  new P2D(); // só a existência da classe é exigida pelo carregamento do pdf.js -- construir nunca é "desenhar"
});
check("path2d_moveto_fails_explicitly", () => {
  let threw = false;
  try { new P2D().moveTo(1, 2); } catch (e) { threw = e instanceof worker.PdfCompatibilityShimError && e.code === "SHIM_METHOD_CALLED"; }
  if (!threw) throw new Error("moveTo() did not fail explicitly");
});
check("path2d_rect_fails_explicitly", () => {
  let threw = false;
  try { new P2D().rect(0, 0, 1, 1); } catch (e) { threw = e instanceof worker.PdfCompatibilityShimError; }
  if (!threw) throw new Error("rect() did not fail explicitly");
});
check("path2d_arc_fails_explicitly", () => {
  let threw = false;
  try { new P2D().arc(0, 0, 1, 0, 1); } catch (e) { threw = e instanceof worker.PdfCompatibilityShimError; }
  if (!threw) throw new Error("arc() did not fail explicitly");
});
check("shim_error_message_never_includes_stack_or_cwd", () => {
  try {
    new DM().multiply(new DM());
  } catch (e) {
    if (e.message.includes(process.cwd())) throw new Error("shim error message leaked a path");
    if (/at .*:\\d+:\\d+/.test(e.message)) throw new Error("shim error message looks like it embedded a stack frame");
  }
});

// --- Descriptors finais (confirma writable:false/configurable:false de verdade, não só "parece bloqueado") ---
check("descriptors_are_locked", () => {
  for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest", "navigator"]) {
    const d = Object.getOwnPropertyDescriptor(globalThis, name);
    if (!d) throw new Error(name + " has no own descriptor on globalThis");
    if (d.writable !== false) throw new Error(name + " is writable");
    if (d.configurable !== false) throw new Error(name + " is configurable");
  }
  if (!Object.isFrozen(globalThis.navigator)) throw new Error("navigator object itself is not frozen");
});

// --- Tentativas de adulteração (ESM roda em modo estrito -- toda tentativa
// abaixo DEVE lançar TypeError; mesmo que alguma não lançasse, a proteção
// real está em CONFIRMAR que o guard continua bloqueando depois) ---
function attemptThrows(fn) {
  try { fn(); return false; } catch { return true; }
}
function stillBlocked(callFn, expectedCtor) {
  try { callFn(); return false; } catch (e) { return e instanceof expectedCtor; }
}

check("tamper_reassign_fetch", () => {
  const threw = attemptThrows(() => { globalThis.fetch = () => "not blocked"; });
  if (!threw) throw new Error("reassigning globalThis.fetch did not throw in strict mode");
  if (!stillBlocked(() => globalThis.fetch("http://x"), worker.NetworkAccessBlockedError)) throw new Error("fetch guard was altered by the reassignment attempt");
});
check("tamper_delete_fetch", () => {
  const threw = attemptThrows(() => { delete globalThis.fetch; });
  if (!threw) throw new Error("deleting globalThis.fetch did not throw in strict mode");
  if (!stillBlocked(() => globalThis.fetch("http://x"), worker.NetworkAccessBlockedError)) throw new Error("fetch guard was removed by the delete attempt");
});
check("tamper_defineproperty_fetch", () => {
  const threw = attemptThrows(() => { Object.defineProperty(globalThis, "fetch", { value: () => "not blocked", writable: true, configurable: true }); });
  if (!threw) throw new Error("Object.defineProperty redefinition of fetch did not throw");
  if (!stillBlocked(() => globalThis.fetch("http://x"), worker.NetworkAccessBlockedError)) throw new Error("fetch guard was altered by the defineProperty attempt");
});
check("tamper_reassign_websocket", () => {
  attemptThrows(() => { globalThis.WebSocket = class {}; });
  if (!stillBlocked(() => new globalThis.WebSocket("ws://x"), worker.NetworkAccessBlockedError)) throw new Error("WebSocket guard was altered");
});
check("tamper_reassign_eventsource", () => {
  attemptThrows(() => { globalThis.EventSource = class {}; });
  if (!stillBlocked(() => new globalThis.EventSource("http://x"), worker.NetworkAccessBlockedError)) throw new Error("EventSource guard was altered");
});
check("tamper_reassign_xmlhttprequest", () => {
  attemptThrows(() => { globalThis.XMLHttpRequest = class {}; });
  if (!stillBlocked(() => new globalThis.XMLHttpRequest(), worker.NetworkAccessBlockedError)) throw new Error("XMLHttpRequest guard was altered");
});
check("tamper_replace_navigator", () => {
  const threw = attemptThrows(() => { globalThis.navigator = { sendBeacon: () => "not blocked" }; });
  if (!threw) throw new Error("replacing globalThis.navigator did not throw in strict mode");
  if (!stillBlocked(() => globalThis.navigator.sendBeacon("http://x"), worker.NetworkAccessBlockedError)) throw new Error("navigator was replaced by the tampering attempt");
});
check("tamper_reassign_sendbeacon", () => {
  const threw = attemptThrows(() => { globalThis.navigator.sendBeacon = () => "not blocked"; });
  if (!threw) throw new Error("reassigning navigator.sendBeacon did not throw in strict mode (frozen object)");
  if (!stillBlocked(() => globalThis.navigator.sendBeacon("http://x"), worker.NetworkAccessBlockedError)) throw new Error("sendBeacon guard was altered by the reassignment attempt");
});
check("tamper_delete_sendbeacon", () => {
  const threw = attemptThrows(() => { delete globalThis.navigator.sendBeacon; });
  if (!threw) throw new Error("deleting navigator.sendBeacon did not throw in strict mode (frozen object)");
  if (typeof globalThis.navigator.sendBeacon !== "function") throw new Error("sendBeacon was removed by the delete attempt");
  if (!stillBlocked(() => globalThis.navigator.sendBeacon("http://x"), worker.NetworkAccessBlockedError)) throw new Error("sendBeacon guard was removed by the delete attempt");
});
check("after_all_tampering_apis_still_blocked_and_counter_still_works", () => {
  const before = worker.getNetworkAttemptCount();
  const results2 = [
    stillBlocked(() => globalThis.fetch("http://x"), worker.NetworkAccessBlockedError),
    stillBlocked(() => new globalThis.WebSocket("ws://x"), worker.NetworkAccessBlockedError),
    stillBlocked(() => new globalThis.EventSource("http://x"), worker.NetworkAccessBlockedError),
    stillBlocked(() => new globalThis.XMLHttpRequest(), worker.NetworkAccessBlockedError),
    stillBlocked(() => globalThis.navigator.sendBeacon("http://x"), worker.NetworkAccessBlockedError),
  ];
  if (!results2.every(Boolean)) throw new Error("at least one API is no longer blocked after tampering attempts");
  const after = worker.getNetworkAttemptCount();
  if (after !== before + 5) throw new Error("attempt counter did not keep incrementing after tampering attempts (before=" + before + " after=" + after + ")");
});
check("no_url_leaked_across_any_tampering_or_blocked_call", () => {
  try { globalThis.fetch("http://leak-check.invalid/should-not-appear?x=1"); } catch (e) {
    if (e.message.includes("leak-check.invalid") || e.message.includes("x=1")) throw new Error("URL leaked in error message");
  }
});
check("import_and_text_extraction_still_work_after_guards_and_tampering", () => {
  // Confirma que os bloqueios (e as tentativas de adulteração) não
  // quebraram nada que o próprio pdf.js precisa pra carregar -- o import
  // no topo deste script já teria lançado se algo tivesse quebrado, e
  // MinimalDOMMatrix/MinimalPath2D continuam construíveis normalmente.
  new worker.MinimalDOMMatrix();
  new worker.MinimalPath2D();
});

console.log("RESULT_JSON:" + JSON.stringify(results));
process.exit(0);
`;

function runHardeningCheckScript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-pdf-hardening-"));
  const scriptPath = path.join(dir, "check.mjs");
  fs.writeFileSync(scriptPath, HARDENING_CHECK_SCRIPT);
  const workerPath = path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "pdfExtractorWorker.mjs");
  try {
    // spawnSync com argv discreto (nunca shell:true, nunca string concatenada) -- mesmo padrão de segurança de child_process usado em produção.
    const result = spawnSync(process.execPath, [scriptPath, workerPath], { encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, `processo de verificação falhou (status=${result.status}): stderr=${result.stderr}`);
    const line = result.stdout.split("\n").find((l) => l.startsWith("RESULT_JSON:"));
    assert.ok(line, `saída não continha RESULT_JSON: ${result.stdout}`);
    return JSON.parse(line.slice("RESULT_JSON:".length));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("hardening: fetch/WebSocket/EventSource/XMLHttpRequest/navigator.sendBeacon são bloqueados EM RUNTIME dentro do worker -- prova em processo Node separado e descartável, sem tocar a rede de verdade", () => {
  const results = runHardeningCheckScript();
  for (const [name, r] of Object.entries(results)) {
    assert.ok(r.ok, `${name} falhou: ${JSON.stringify(r)}`);
  }
  // Confirma explicitamente as checagens mais centrais desta rodada (redundante com o loop acima, mas deixa a intenção legível no relatório de teste).
  assert.ok(results.fetch_blocked_before_reaching_network.ok);
  assert.ok(results.websocket_blocked.ok);
  assert.ok(results.eventsource_blocked.ok);
  assert.ok(results.xmlhttprequest_blocked.ok);
  assert.ok(results.sendbeacon_blocked.ok);
  assert.ok(results.network_attempts_are_counted.ok);
  assert.ok(results.network_error_message_never_includes_url.ok);
  assert.ok(results.dommatrix_multiply_fails_explicitly.ok);
  assert.ok(results.dommatrix_inverse_fails_explicitly.ok);
  assert.ok(results.dommatrix_singular_matrix_construction_is_faithful_and_inverse_still_fails_explicitly.ok);
  assert.ok(results.path2d_construction_does_not_throw.ok);
  assert.ok(results.path2d_moveto_fails_explicitly.ok);
  // Imutabilidade dos guards (rodada de endurecimento final).
  assert.ok(results.descriptors_are_locked.ok);
  assert.ok(results.tamper_reassign_fetch.ok);
  assert.ok(results.tamper_delete_fetch.ok);
  assert.ok(results.tamper_defineproperty_fetch.ok);
  assert.ok(results.tamper_reassign_websocket.ok);
  assert.ok(results.tamper_reassign_eventsource.ok);
  assert.ok(results.tamper_reassign_xmlhttprequest.ok);
  assert.ok(results.tamper_replace_navigator.ok);
  assert.ok(results.tamper_reassign_sendbeacon.ok);
  assert.ok(results.tamper_delete_sendbeacon.ok);
  assert.ok(results.after_all_tampering_apis_still_blocked_and_counter_still_works.ok);
  assert.ok(results.no_url_leaked_across_any_tampering_or_blocked_call.ok);
  assert.ok(results.import_and_text_extraction_still_work_after_guards_and_tampering.ok);
});

test("extractPdf: extração real (fixture sintética) nunca aciona os shims de renderização (Path2D/DOMMatrix transform) -- prova de que getTextContent() não os usa", async () => {
  const buf = buildMinimalPdf({ pageTexts: ["Texto qualquer para confirmar que a extração não renderiza"] });
  await withTempPdf(buf, async (filePath, sha256) => {
    // Se getTextContent() chamasse algum método de desenho/transform, o
    // worker devolveria SHIM_METHOD_CALLED e isto lançaria
    // PdfRenderingAttemptedError -- a extração bem-sucedida abaixo já é a
    // prova negativa.
    const result = await extractPdf(filePath, { expectedSha256: sha256 });
    assert.equal(result.pages[0].isEmpty, false);
    assert.equal(result.networkAccessAttempts, 0);
  });
});

test("extractPdf: erros de rede bloqueada e de shim têm classes e códigos próprios, nunca genéricos (para quando/se algum dia ocorrerem de verdade)", () => {
  assert.equal(new PdfNetworkBlockedError().code, "PDF_NETWORK_BLOCKED");
  assert.equal(new PdfRenderingAttemptedError().code, "PDF_RENDERING_ATTEMPTED");
  assert.ok(PdfNetworkBlockedError.prototype instanceof Error);
  assert.ok(PdfRenderingAttemptedError.prototype instanceof Error);
});

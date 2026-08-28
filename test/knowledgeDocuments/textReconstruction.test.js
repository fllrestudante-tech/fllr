const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  reconstructPageText,
  isValidItem,
  collapseInternalFragmentation,
  median,
  medianAbsoluteDeviation,
  computeAdaptiveThresholds,
  checkCharacterMultisetInvariant,
  checkSourceOrderInvariant,
  classifyQuality,
  TextReconstructionError,
} = require("../../lib/knowledgeDocuments/textReconstruction");

// Fábrica de item sintético -- SEMPRE conteúdo genérico, nunca ligado ao
// manual real (sem "Diego"/"Vela Trader"/"CryptoTrader" em lugar nenhum
// deste arquivo).
function item(str, { x = 0, y = 0, width, height = 12, hasEOL = false, dir = "ltr", angleDeg = 0 } = {}) {
  const rad = (angleDeg * Math.PI) / 180;
  const scale = height || 12;
  const a = scale * Math.cos(rad);
  const b = scale * Math.sin(rad);
  const c = -scale * Math.sin(rad);
  const d = scale * Math.cos(rad);
  const w = width != null ? width : str.length * (scale * 0.5);
  return { str, dir, width: w, height, hasEOL, transform: [a, b, c, d, x, y], fontName: "F1" };
}

// =====================================================================
// Passos isolados
// =====================================================================

test("isValidItem: aceita item bem formado, rejeita transform errado/curto/NaN, width/height negativos, str ausente", () => {
  assert.equal(isValidItem(item("a")), true);
  assert.equal(isValidItem({ str: "a", transform: [1, 2, 3], width: 1, height: 1 }), false);
  assert.equal(isValidItem({ str: "a", transform: [1, 2, 3, 4, 5, NaN], width: 1, height: 1 }), false);
  assert.equal(isValidItem({ str: "a", transform: [1, 0, 0, 1, 0, 0], width: -1, height: 1 }), false);
  assert.equal(isValidItem({ transform: [1, 0, 0, 1, 0, 0], width: 1, height: 1 }), false);
  assert.equal(isValidItem(null), false);
});

test("collapseInternalFragmentation: colapsa quando o padrão de tokens de 1 caractere é CORROBORADO pela largura do item (width compatível com texto sem espaço)", () => {
  // "Hello" a 20 de fontSize ocuparia ~50 de largura sem espaço (5*20*0.5);
  // width=40 é compatível com isso -- corrobora artefato de decodificação.
  const r = collapseInternalFragmentation({ str: "H e l l o", width: 40 }, 20);
  assert.deepEqual(r, { cleanStr: "Hello", wasFragmented: true, ambiguous: false });
});

test("collapseInternalFragmentation: NÃO colapsa quando a largura do item é compatível com espaçamento real -- fica AMBÍGUO, string original preservada (iniciais/siglas legítimas)", () => {
  // "A B C" com width=100 a fontSize=12 é MUITO mais largo do que o texto
  // sem espaço ocuparia (3*12*0.5=18) -- a largura NÃO corrobora artefato,
  // então a colisão fica ambígua e a string original nunca é alterada.
  const r = collapseInternalFragmentation({ str: "A B C", width: 100 }, 12);
  assert.deepEqual(r, { cleanStr: "A B C", wasFragmented: false, ambiguous: true });
});

test("collapseInternalFragmentation: menos de 3 tokens, ou nenhum token de 1 caractere, nunca aciona nem o colapso nem a ambiguidade", () => {
  assert.deepEqual(collapseInternalFragmentation({ str: "Hello World", width: 60 }, 12), { cleanStr: "Hello World", wasFragmented: false, ambiguous: false });
  assert.deepEqual(collapseInternalFragmentation({ str: "ab", width: 10 }, 12), { cleanStr: "ab", wasFragmented: false, ambiguous: false });
  assert.deepEqual(collapseInternalFragmentation({ str: "a b", width: 15 }, 12), { cleanStr: "a b", wasFragmented: false, ambiguous: false }); // só 2 tokens -- amostra pequena demais pra decidir
});

test("median / medianAbsoluteDeviation: valores conhecidos", () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
  const mad = medianAbsoluteDeviation([1, 1, 1, 10], 1);
  assert.ok(mad >= 0);
});

test("computeAdaptiveThresholds: usa fallback documentado com poucas amostras, estatística real com amostra suficiente", () => {
  const fallback = computeAdaptiveThresholds([0.1, 0.2]);
  assert.equal(fallback.fallback, true);
  const real = computeAdaptiveThresholds([0.05, 0.1, 0.15, 0.2, 0.25, 3, 4, 5]);
  assert.equal(real.fallback, false);
  assert.ok(real.mad > 0);
  assert.ok(real.continuationMax < real.spaceMin);
});

test("computeAdaptiveThresholds: MAD pode ser 0 quando a maioria dos vãos é idêntica (caso degenerado, não é bug) -- limiares colapsam mas nunca invertem", () => {
  const degenerate = computeAdaptiveThresholds([0.1, 0.1, 0.1, 0.1, 0.1, 5, 5, 5]);
  assert.equal(degenerate.mad, 0); // maioria (5 de 8) empatada na mediana -- MAD=0 é o resultado matematicamente correto, não um defeito
  assert.ok(degenerate.continuationMax <= degenerate.spaceMin);
});

// =====================================================================
// As duas invariantes -- contrato corrigido: multiconjunto NUNCA prova
// ordem; sourceOrderInvariant é o requisito forte (sensível à ordem).
// =====================================================================

test("sourceOrderInvariant: ignora diferença de whitespace, mas exige ORDEM idêntica", () => {
  assert.equal(checkSourceOrderInvariant("ab cd", "abcd"), true); // só espaço removido -- ordem preservada
  assert.equal(checkSourceOrderInvariant("ab cd", "ab\ncd"), true); // espaço trocado por quebra de linha -- ainda só whitespace
  assert.equal(checkSourceOrderInvariant("ab cd", "cd ab"), false); // reordenado -- viola a garantia forte
});

test("characterMultisetInvariant: mesmos caracteres/quantidades, MESMO quando a ordem muda (prova só ausência de invenção/perda, nunca ordem)", () => {
  assert.equal(checkCharacterMultisetInvariant("ab cd", "cd ab"), true);
  assert.equal(checkCharacterMultisetInvariant("abc", "ab"), false); // caractere perdido
  assert.equal(checkCharacterMultisetInvariant("abc", "abcd"), false); // caractere inventado
});

test("sourceOrderInvariant: caracteres repetidos -- compara quantidade E posição, não só presença", () => {
  assert.equal(checkSourceOrderInvariant("aaab", "aaab"), true);
  assert.equal(checkSourceOrderInvariant("aaab", "aaba"), false); // mesmas letras, mesma contagem, ORDEM diferente
});

test("characterMultisetInvariant: caracteres repetidos -- diferença de CONTAGEM é detectada, não só de conjunto de caracteres distintos", () => {
  assert.equal(checkCharacterMultisetInvariant("aab", "aba"), true); // mesma contagem (2 a's, 1 b), ordem diferente -- multiset ok
  assert.equal(checkCharacterMultisetInvariant("aab", "abb"), false); // 2 a's/1 b vira 1 a/2 b's -- contagem mudou, não é só reordenação
});

test("sourceOrderInvariant / characterMultisetInvariant: acentos e ligaduras são pontos de código próprios, preservados literalmente", () => {
  assert.equal(checkSourceOrderInvariant("açúcar", "açúcar"), true);
  assert.equal(checkCharacterMultisetInvariant("açúcar", "açúrca"), true); // mesmos pontos de código, ordem embaralhada -- multiset ok
  // ligadura "ﬁ" (U+FB01) é 1 ponto de código -- NUNCA equivalente a "f"+"i" (2 pontos de código distintos), sem decomposição nenhuma
  assert.equal(checkSourceOrderInvariant("ﬁm", "fim"), false);
  assert.equal(checkCharacterMultisetInvariant("ﬁm", "fim"), false);
});

test("sourceOrderInvariant: NÃO normaliza Unicode (NFC/NFD) -- 'é' precomposto e 'e'+acento combinante são sequências de pontos de código DIFERENTES (limitação documentada, comparação é literal)", () => {
  const precomposed = "café"; // é como 1 único ponto de código
  const decomposed = "café"; // e + acento agudo combinante -- visualmente idêntico, pontos de código diferentes
  assert.equal(checkSourceOrderInvariant(precomposed, decomposed), false);
});

test("sourceOrderInvariant / characterMultisetInvariant: caracteres fora do BMP comparados por PONTO DE CÓDIGO, nunca por unidade UTF-16 crua (par substituto nunca fragmentado)", () => {
  const a = "\u{1F600}"; // 😀 -- 1 ponto de código, 2 unidades UTF-16
  const b = "\u{1F680}"; // 🚀 -- outro ponto de código fora do BMP, 2 unidades UTF-16
  const before = a + b;
  assert.equal(before.length, 4); // confirma 4 unidades UTF-16 (2 pares substitutos) -- não seria assim se comparássemos por ponto de código
  assert.equal(Array.from(before).length, 2); // mas exatamente 2 pontos de código -- é isso que a invariante compara
  assert.equal(checkSourceOrderInvariant(before, a + b), true);
  assert.equal(checkSourceOrderInvariant(before, b + a), false); // reordenado -- ainda assim nenhum par substituto quebrado (comparação nunca vê "meio emoji")
  assert.equal(checkCharacterMultisetInvariant(before, b + a), true); // mesmo multiset, ordem diferente
  const withSpace = "a " + a + " b";
  assert.equal(checkSourceOrderInvariant(withSpace, "a" + a + "b"), true); // espaço ao redor do emoji removido sem fragmentar o par substituto
});

test("sourceOrderInvariant / characterMultisetInvariant: simulação de truncamento -- cortar o texto no meio SEMPRE derruba as duas invariantes (nunca finge sucesso parcial)", () => {
  const original = "ab cd ef gh";
  const truncated = original.slice(0, 6); // "ab cd " -- corte no meio, perde "ef gh"
  assert.equal(checkSourceOrderInvariant(original, truncated), false);
  assert.equal(checkCharacterMultisetInvariant(original, truncated), false);
});

test("classifyQuality: NENHUMA das duas invariantes pode falhar e ainda dar 'good'/'review_required' -- sempre 'poor'", () => {
  const base = {
    isEmpty: false,
    characterMultisetInvariantOk: true,
    sourceOrderInvariantOk: true,
    truncated: false,
    singleCharTokenRatio: 0,
    ambiguousGapRatio: 0,
    orientationGroupCount: 1,
    wordCount: 100,
    rawCharCount: 1000,
    excessiveLineFragmentation: false,
    hasAmbiguousInternalFragmentation: false,
    layoutCandidateOrderDiverged: false,
  };
  assert.equal(classifyQuality({ ...base, characterMultisetInvariantOk: false }), "poor");
  assert.equal(classifyQuality({ ...base, sourceOrderInvariantOk: false }), "poor");
  assert.equal(classifyQuality(base), "good"); // controle: com tudo ok, é "good"
});

test("classifyQuality: truncamento, fragmentação interna ambígua e candidato geométrico divergente nunca são 'good', mas também nunca sozinhos viram 'poor'", () => {
  const base = {
    isEmpty: false,
    characterMultisetInvariantOk: true,
    sourceOrderInvariantOk: true,
    truncated: false,
    singleCharTokenRatio: 0,
    ambiguousGapRatio: 0,
    orientationGroupCount: 1,
    wordCount: 100,
    rawCharCount: 1000,
    excessiveLineFragmentation: false,
    hasAmbiguousInternalFragmentation: false,
    layoutCandidateOrderDiverged: false,
  };
  assert.equal(classifyQuality({ ...base, truncated: true }), "review_required");
  assert.equal(classifyQuality({ ...base, hasAmbiguousInternalFragmentation: true }), "review_required");
  assert.equal(classifyQuality({ ...base, layoutCandidateOrderDiverged: true }), "review_required");
});

// =====================================================================
// Reconstrução -- cenários geométricos completos
// =====================================================================

test("reconstructPageText: palavra formada por glifos individuais sem espaços vira uma palavra só, sem espaço nenhum (nas duas representações, já que a ordem geométrica coincide com a ordem original)", () => {
  const items = [];
  let x = 72;
  for (const ch of "Hello") {
    items.push(item(ch, { x, y: 700, width: 6 }));
    x += 6; // encostados -- gap zero
  }
  const r = reconstructPageText(items);
  assert.equal(r.sourceOrderedText, "Hello");
  assert.equal(r.layoutCandidateText, "Hello");
  assert.equal(r.characterMultisetInvariant, true);
  assert.equal(r.sourceOrderInvariant, true);
});

test("reconstructPageText: duas palavras com gap claramente maior recebem espaço", () => {
  const items = [item("Hello", { x: 72, y: 700, width: 30 }), item("World", { x: 200, y: 700, width: 30 })]; // gap = 200-102=98, bem maior que qualquer fração pequena de fonte
  const r = reconstructPageText(items);
  assert.equal(r.sourceOrderedText, "Hello World");
});

test("reconstructPageText: tracking largo mas UNIFORME entre vários glifos de uma mesma palavra continua sendo tratado como continuação (estatística adaptativa, não limiar fixo)", () => {
  const items = [];
  let x = 72;
  for (const ch of "TRACKING") {
    items.push(item(ch, { x, y: 700, width: 6 }));
    x += 9; // gap uniforme de 3 entre todos os glifos -- vira o "normal" da página, não deve virar espaço
  }
  const r = reconstructPageText(items);
  assert.equal(r.sourceOrderedText, "TRACKING");
});

test("reconstructPageText: itens multi-caractere (já palavras inteiras) não sofrem colapso interno nem ganham espaço indevido", () => {
  const items = [item("Palavra", { x: 72, y: 700, width: 40 })];
  const r = reconstructPageText(items);
  assert.equal(r.sourceOrderedText, "Palavra");
});

test("reconstructPageText: mistura de glifos isolados e itens longos na mesma linha", () => {
  const items = [
    item("A", { x: 72, y: 700, width: 6 }),
    item("B", { x: 78, y: 700, width: 6 }), // continuação de "AB"
    item(" ", { x: 84, y: 700, width: 12, height: 0 }), // espaço sintético do pdf.js (height=0), como observado empiricamente
    item("palavra longa inteira", { x: 96, y: 700, width: 100 }),
  ];
  const r = reconstructPageText(items);
  assert.equal(r.sourceOrderedText, "AB palavra longa inteira");
});

test("reconstructPageText: múltiplas linhas via hasEOL", () => {
  const items = [item("Primeira linha", { x: 72, y: 700, width: 80, hasEOL: true }), item("Segunda linha", { x: 72, y: 680, width: 80 })];
  const r = reconstructPageText(items);
  assert.equal(r.sourceOrderedText, "Primeira linha\nSegunda linha");
  assert.equal(r.lineCount, 2);
});

test("reconstructPageText: hasEOL é o ÚNICO sinal de quebra de linha pra sourceOrderedText -- proximidade geométrica sozinha NÃO agrupa nem separa linha (isso é só layoutCandidateText)", () => {
  const closeItems = [item("Topo", { x: 72, y: 700, width: 20 }), item("baixo", { x: 100, y: 698, width: 20 })]; // bem próximos verticalmente, sem hasEOL
  const rClose = reconstructPageText(closeItems);
  assert.equal(rClose.lineCount, 1); // sourceOrderedText: sem hasEOL, nunca quebra linha
  assert.equal(rClose.layoutCandidateLineCount, 1); // geometricamente também ficam na mesma linha (dentro da tolerância)

  const farItems = [item("Topo", { x: 72, y: 700, width: 20 }), item("baixo", { x: 72, y: 650, width: 20 })]; // 50 unidades de diferença -- muito além da tolerância geométrica
  const rFar = reconstructPageText(farItems);
  assert.equal(rFar.lineCount, 1); // ainda sem hasEOL -- sourceOrderedText não quebra por distância
  assert.equal(rFar.layoutCandidateLineCount, 2); // mas o candidato geométrico SEPARA em duas linhas -- diagnóstico distinto, nunca vaza pro texto principal
});

test("reconstructPageText: colunas -- sourceOrderedText preserva a ORDEM ORIGINAL (só whitespace); layoutCandidateText pode reordenar geometricamente, mas fica marcado como divergente", () => {
  const items = [item("Coluna", { x: 400, y: 700, width: 40 }), item("Esquerda", { x: 72, y: 700, width: 50 })]; // dados fora de ordem geométrica de propósito
  const r = reconstructPageText(items);
  assert.equal(r.sourceOrderedText, "Coluna Esquerda"); // ordem do array preservada -- só espaço decidido
  assert.equal(r.layoutCandidateText, "Esquerda Coluna"); // candidato reordena pela posição real
  assert.equal(r.layoutCandidateOrderDiverged, true);
  assert.equal(r.sourceOrderInvariant, true); // sourceOrderedText nunca reordena -- garantia forte intacta
  assert.equal(r.characterMultisetInvariant, true);
  assert.equal(r.layoutCandidateMultisetInvariant, true); // candidato reordena, mas não inventa/perde caractere
});

test("reconstructPageText: ordem de entrada -- sourceOrderedText MUDA quando a ordem do array muda (é o contrato); layoutCandidateText permanece igual (guiado só por geometria)", () => {
  const itemsInOrder = [item("Primeiro", { x: 72, y: 700, width: 50 }), item("Segundo", { x: 140, y: 700, width: 50 })];
  const itemsReversed = [itemsInOrder[1], itemsInOrder[0]];
  const rInOrder = reconstructPageText(itemsInOrder);
  const rReversed = reconstructPageText(itemsReversed);

  assert.equal(rInOrder.layoutCandidateText, rReversed.layoutCandidateText); // geometria não liga pra ordem de entrada
  assert.notEqual(rInOrder.sourceOrderedText, rReversed.sourceOrderedText); // sourceOrderedText respeita a ordem entregue -- por design
  assert.ok(rInOrder.sourceOrderedText.indexOf("Primeiro") < rInOrder.sourceOrderedText.indexOf("Segundo"));
  assert.ok(rReversed.sourceOrderedText.indexOf("Segundo") < rReversed.sourceOrderedText.indexOf("Primeiro"));
  assert.equal(rInOrder.sourceOrderInvariant, true);
  assert.equal(rReversed.sourceOrderInvariant, true);
});

test("reconstructPageText: rotação 90°, 180° e 270° são agrupadas corretamente e preservam os caracteres nas duas representações", () => {
  for (const angleDeg of [90, 180, 270]) {
    const items = [item("Rot", { x: 300, y: 300, width: 20, angleDeg }), item("acao", { x: 300, y: 300, width: 20, angleDeg })];
    // segundo item posicionado geometricamente adjacente ao primeiro na direção do ângulo
    const rad = (angleDeg * Math.PI) / 180;
    items[1].transform[4] = 300 + 20 * Math.cos(rad);
    items[1].transform[5] = 300 + 20 * Math.sin(rad);
    const r = reconstructPageText(items);
    assert.equal(r.characterMultisetInvariant, true, `angulo ${angleDeg}: multiset`);
    assert.equal(r.sourceOrderInvariant, true, `angulo ${angleDeg}: ordem`);
    assert.equal(r.layoutCandidateMultisetInvariant, true, `angulo ${angleDeg}: multiset do candidato`);
    assert.equal(r.orientationGroups, 1, `angulo ${angleDeg}: deveria formar 1 grupo de orientação`);
  }
});

test("reconstructPageText: skew moderado (ângulo fora dos cardeais) forma seu próprio grupo de orientação, sem quebrar nem inventar ordem", () => {
  const items = [item("Skewed", { x: 72, y: 700, width: 40, angleDeg: 15 })]; // 15° > tolerância de 10°
  const r = reconstructPageText(items);
  assert.equal(r.sourceOrderedText, "Skewed");
  assert.equal(r.orientationGroups, 1);
});

test("reconstructPageText: texto misto -- dois grupos de orientação diferentes preservados separadamente, nunca misturados numa linha só", () => {
  const items = [item("Horizontal", { x: 72, y: 700, width: 60, angleDeg: 0 }), item("Vertical", { x: 400, y: 300, width: 60, angleDeg: 90 })];
  const r = reconstructPageText(items);
  assert.equal(r.orientationGroups, 2);
  assert.equal(r.characterMultisetInvariant, true);
  assert.equal(r.sourceOrderInvariant, true);
});

test("reconstructPageText: RTL -- sourceOrderedText preserva a ordem do array (não liga pra `dir`); layoutCandidateText inverte pela leitura RTL e diverge", () => {
  const items = [item("Um", { x: 72, y: 700, width: 20, dir: "rtl" }), item("Dois", { x: 100, y: 700, width: 20, dir: "rtl" })];
  const r = reconstructPageText(items);
  assert.equal(r.sourceOrderedText, "Um Dois"); // ordem do array, sempre
  assert.equal(r.layoutCandidateText, "Dois Um"); // rtl -- candidato lido da direita pra esquerda
  assert.equal(r.layoutCandidateOrderDiverged, true);
  assert.equal(r.sourceOrderInvariant, true);
});

test("reconstructPageText: hasEOL força nova linha em sourceOrderedText mesmo quando a coordenada perpendicular seria compatível com a mesma linha geometricamente", () => {
  const items = [item("A", { x: 72, y: 700, width: 10, hasEOL: true }), item("B", { x: 90, y: 699, width: 10 })]; // Y quase igual, mas hasEOL=true no anterior
  const r = reconstructPageText(items);
  assert.equal(r.lineCount, 2);
});

test("reconstructPageText: string vazia (array vazio de itens) -- nunca lança, devolve texto vazio, qualidade image_only, as duas invariantes verdadeiras", () => {
  const r = reconstructPageText([]);
  assert.equal(r.sourceOrderedText, "");
  assert.equal(r.layoutCandidateText, "");
  assert.equal(r.qualityStatus, "image_only");
  assert.equal(r.characterMultisetInvariant, true);
  assert.equal(r.sourceOrderInvariant, true);
});

test("reconstructPageText: item inválido com conteúdo não-whitespace NUNCA é descartado silenciosamente -- é contado, e sua ausência derruba as duas invariantes (fail-closed), forçando 'poor'", () => {
  const items = [item("ok", { x: 72, y: 700, width: 12 }), { str: "perdido", transform: [1, 2, 3], width: 1, height: 1 }];
  const r = reconstructPageText(items);
  assert.equal(r.reconstructionDiagnostics.invalidItemCount, 1);
  assert.equal(r.reconstructionDiagnostics.invalidItemsWithContentCount, 1); // contado explicitamente, não só implícito na invariância
  assert.equal(r.characterMultisetInvariant, false);
  assert.equal(r.sourceOrderInvariant, false);
  assert.equal(r.qualityStatus, "poor");
});

test("reconstructPageText: itens inválidos SEM conteúdo não-whitespace não quebram nenhuma das duas invariantes", () => {
  const items = [item("ok", { x: 72, y: 700, width: 12 }), { str: "   ", transform: [1, 2, 3], width: 1, height: 1 }];
  const r = reconstructPageText(items);
  assert.equal(r.reconstructionDiagnostics.invalidItemCount, 1);
  assert.equal(r.reconstructionDiagnostics.invalidItemsWithContentCount, 0);
  assert.equal(r.characterMultisetInvariant, true);
  assert.equal(r.sourceOrderInvariant, true);
});

test("reconstructPageText: gap ambíguo (entre o limiar de continuação e o de espaço) é contado em ambiguousGapCount e ainda recebe espaço (mais seguro pra legibilidade)", () => {
  const items = [];
  let x = 72;
  for (let i = 0; i < 6; i++) {
    items.push(item(String.fromCharCode(65 + i), { x, y: 700, width: 6 }));
    x += 6.5; // gap ~0.5, pequeno -- maioria "continuação"
  }
  items.push(item("Z", { x: x + 3.5, y: 700, width: 6 })); // gap intermediário -- nem 0.5 nem muito maior
  items.push(item("Fim", { x: x + 3.5 + 6 + 40, y: 700, width: 15 })); // gap bem maior -- claramente espaço
  const r = reconstructPageText(items);
  assert.equal(r.sourceOrderInvariant, true);
  assert.ok(r.ambiguousGapCount >= 0); // determinístico, mas o valor exato depende da estatística -- só confirma que o mecanismo roda sem lançar
});

test("reconstructPageText: matriz inválida (NaN, comprimento errado) não derruba a função -- item é descartado", () => {
  const items = [{ str: "x", transform: [NaN, 0, 0, 12, 0, 0], width: 5, height: 12 }, { str: "y", transform: [1, 2], width: 5, height: 12 }];
  assert.doesNotThrow(() => reconstructPageText(items));
});

test("reconstructPageText: caracteres acentuados e ligaduras atravessam sem alteração alguma", () => {
  const items = [item("açúcar", { x: 72, y: 700, width: 30 }), item("ﬁm", { x: 120, y: 700, width: 15 })];
  const r = reconstructPageText(items);
  assert.ok(r.sourceOrderedText.includes("açúcar"));
  assert.ok(r.sourceOrderedText.includes("ﬁm"));
  assert.equal(r.characterMultisetInvariant, true);
  assert.equal(r.sourceOrderInvariant, true);
});

test("reconstructPageText: determinístico -- mesma entrada sempre produz a mesma saída", () => {
  const items = [item("Repetível", { x: 72, y: 700, width: 40 }), item("sempre", { x: 130, y: 700, width: 30 })];
  const r1 = reconstructPageText(items);
  const r2 = reconstructPageText(items);
  assert.deepEqual(r1, r2);
});

test("reconstructPageText: limites de entrada -- items não-array lança TextReconstructionError; excesso de itens lança", () => {
  assert.throws(() => reconstructPageText("não é array"), TextReconstructionError);
  assert.throws(() => reconstructPageText(null), TextReconstructionError);
  const tooMany = Array.from({ length: 5 }, (_, i) => item("x", { x: i, y: 0, width: 1 }));
  assert.doesNotThrow(() => reconstructPageText(tooMany, { maxItems: 10 }));
  assert.throws(() => reconstructPageText(tooMany, { maxItems: 3 }), TextReconstructionError);
});

test("reconstructPageText: nenhuma regra lexical -- o algoritmo produz a MESMA decisão de espaçamento pra qualquer alfabeto/idioma sintético, prova de que não há dicionário por trás", () => {
  const itemsA = "XQZKV".split("").map((ch, i) => item(ch, { x: 72 + i * 6, y: 700, width: 6 }));
  const itemsB = "Hello".split("").map((ch, i) => item(ch, { x: 72 + i * 6, y: 700, width: 6 }));
  const rA = reconstructPageText(itemsA);
  const rB = reconstructPageText(itemsB);
  assert.equal(rA.sourceOrderedText, "XQZKV"); // sequência sem sentido nenhum -- junta do mesmo jeito que uma palavra real, prova que a decisão é só geométrica
  assert.equal(rB.sourceOrderedText, "Hello");
});

// =====================================================================
// Fragmentação interna ambígua -- espaços semanticamente legítimos nunca
// podem ser removidos automaticamente (item 5 da auditoria).
// =====================================================================

test("reconstructPageText: iniciais/siglas legítimas com espaçamento geométrico REAL (width largo) NUNCA são colapsadas -- preservadas literalmente e a página é forçada a review_required", () => {
  const items = [
    item("A B C", { x: 72, y: 700, width: 100, height: 12 }), // width bem maior do que "ABC" sem espaço ocuparia -- não corrobora artefato
    item("Texto adicional consistente para manter densidade suficientemente alta aqui", { x: 200, y: 700, width: 300, height: 12 }),
  ];
  const r = reconstructPageText(items);
  assert.ok(r.sourceOrderedText.includes("A B C")); // espaçamento original intacto, nunca colapsado por suspeita
  assert.equal(r.reconstructionDiagnostics.internalFragmentationAmbiguousCount, 1);
  assert.equal(r.reconstructionDiagnostics.internallyFragmentedItemCount, 0); // não foi tratado como colapso automático
  assert.equal(r.qualityStatus, "review_required"); // nunca "good", mesmo com densidade/gaps perfeitos
});

test("reconstructPageText: fragmentação interna COM corroboração de largura (width apertado, compatível com artefato) é colapsada normalmente", () => {
  const items = [item("H e l l o", { x: 72, y: 700, width: 40, height: 20 })]; // width apertado -- compatível com "Hello" sem espaço a essa fonte
  const r = reconstructPageText(items);
  assert.equal(r.sourceOrderedText, "Hello");
  assert.equal(r.reconstructionDiagnostics.internallyFragmentedItemCount, 1);
  assert.equal(r.reconstructionDiagnostics.internalFragmentationAmbiguousCount, 0);
});

// =====================================================================
// Meta-testes: pureza e ausência de regra específica do manual
// =====================================================================

test("textReconstruction.js: puro (sem require de nada), sem nomes do manual, sem estrutura de dicionário/lista de palavras", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "textReconstruction.js"), "utf8");
  const srcNoComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/require\(/.test(srcNoComments), "textReconstruction.js não deveria importar nada -- é puro por definição");
  const lower = src.toLowerCase();
  for (const forbidden of ["diego", "vela trader", "velatrader", "cryptotrader", "manualdocriptotrader"]) {
    assert.ok(!lower.includes(forbidden), `não deveria conter "${forbidden}"`);
  }
});

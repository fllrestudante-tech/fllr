// Reconstrução geométrica e determinística de texto extraído de PDF --
// PURO (nenhum I/O, nenhuma dependência externa, nenhum acesso a
// DOMMatrix/Path2D -- toda a geometria é calculada com aritmética direta
// sobre os arrays `transform` que o próprio pdf.js já devolve em
// getTextContent()). Nunca inventa ou apaga caracteres não-whitespace.
// Nenhuma regra específica do manual, nenhuma lista de palavras, nenhum
// dicionário, nenhuma IA.
//
// DUAS REPRESENTAÇÕES, DUAS GARANTIAS DIFERENTES (correção de contrato --
// a versão anterior comparava as duas apenas por multiconjunto, o que
// aceitava reordenação; isso não prova preservação de sentido em material
// educacional):
//
//   sourceOrderedText  -- percorre os itens NA ORDEM ORIGINAL entregue por
//                         getTextContent(), decidindo apenas onde inserir
//                         espaço/quebra de linha entre eles. NUNCA reordena
//                         nada. É a representação elegível para uma futura
//                         ingestão.
//   layoutCandidateText -- agrupa por geometria (orientação, linha,
//                         posição), podendo reordenar itens (colunas,
//                         RTL, texto fora de ordem no content stream).
//                         É só um CANDIDATO diagnóstico -- nunca substitui
//                         o texto principal, nunca é elegível pra
//                         ingestão sozinho.
//
// DUAS INVARIANTES, propositalmente distintas:
//   characterMultisetInvariant -- mesmos caracteres não-whitespace, mesma
//                                  quantidade (não prova ordem).
//   sourceOrderInvariant       -- sequência de pontos de código
//                                  não-whitespace EXATAMENTE igual à
//                                  concatenação dos itens na ordem
//                                  original (prova ordem; comparado por
//                                  ponto de código Unicode, nunca por
//                                  unidade UTF-16, pra não fragmentar
//                                  pares substitutos).
// Nenhuma versão com sourceOrderInvariant=false é elegível pra ingestão.
//
// ACHADO EMPÍRICO QUE FUNDAMENTA O DESENHO (confirmado lendo os itens
// reais de getTextContent() sobre o manual): o pdf.js já tem DOIS
// mecanismos DISTINTOS pra representar espaço:
//   (1) um item próprio, com `height === 0` e `str` só espaço -- é como o
//       pdf.js representa um espaço de palavra genuíno quando o gap entre
//       operações de posicionamento no content stream é grande o
//       suficiente pro PRÓPRIO pdf.js decidir separar;
//   (2) espaços "embutidos" dentro do `str` de um item com `height > 0`
//       (glifo real) -- nesta fonte/documento especificamente, isso pode
//       ser artefato de tracking largo por caractere. Mas o padrão de
//       tokens de 1 caractere SOZINHO não prova artefato -- iniciais ou
//       siglas legítimas têm a mesma forma. Por isso a corroboração
//       adicional pela largura do item (ver `collapseInternalFragmentation`).

// --- Constantes documentadas (nenhum limiar fixo único e global pra
// TODAS as decisões -- só usados como base pra estatística adaptativa ou
// como fallback explícito quando não há amostra suficiente) -----------

const ORIENTATION_TOLERANCE_DEG = 10; // até 10° de desvio de 0/90/180/270 ainda conta como "cardeal" (cobre skew moderado sem virar grupo próprio)
const LINE_PERP_TOLERANCE_RATIO = 0.5; // tolerância de "mesma linha" (layoutCandidateText) = 0.5x o tamanho de fonte do item -- proporcional, nunca um valor absoluto fixo
const INTERNAL_FRAGMENTATION_SINGLE_CHAR_RATIO = 0.5; // se mais da metade dos "tokens" internos de um item (splitando por espaço) tem 1 caractere, o item é CANDIDATO a fragmentação interna (ainda precisa da corroboração de largura abaixo)
const NARROW_GLYPH_ADVANCE_RATIO = 0.5; // fração genérica do tamanho de fonte usada como estimativa de avanço médio por glifo -- só corrobora estruturalmente, nunca decide sozinha, nunca é regra lexical
const WIDTH_TIGHTNESS_THRESHOLD = 1.15; // se o width real do item for <= estimativa*1.15, a largura corrobora que os espaços internos não abrem espaço geométrico real (artefato de decodificação); senão, permanece ambíguo e a string original é preservada
const MIN_GAP_SAMPLES_FOR_ADAPTIVE = 5; // amostra mínima pra estatística de mediana/MAD fazer sentido
const FALLBACK_GAP_RATIO = 0.3; // usado só quando não há amostra suficiente (< MIN_GAP_SAMPLES_FOR_ADAPTIVE) -- fração do tamanho de fonte
const CONTINUATION_MAD_MULTIPLIER = 0.5;
const SPACE_MAD_MULTIPLIER = 1.5;
const MAD_TO_SIGMA = 1.4826; // fator padrão de conversão de MAD pra desvio-padrão equivalente (distribuição normal)

// --- Validação de itens -------------------------------------------------

/**
 * Um item é válido se tiver `str` string, `transform` com 6 números
 * finitos, e `width`/`height` números finitos não-negativos. Itens
 * inválidos são contados em diagnóstico e IGNORADOS na geometria (nunca
 * inventa posição pra eles) -- mas se tiverem conteúdo não-whitespace,
 * isso é contado à parte (`invalidItemsWithContentCount`) e derruba
 * `sourceOrderInvariant`/`characterMultisetInvariant` de forma visível
 * (nunca some silenciosamente -- ver `reconstructPageText`).
 */
function isValidItem(item) {
  if (!item || typeof item.str !== "string") return false;
  if (!Array.isArray(item.transform) || item.transform.length !== 6) return false;
  if (!item.transform.every((n) => typeof n === "number" && Number.isFinite(n))) return false;
  if (typeof item.width !== "number" || !Number.isFinite(item.width) || item.width < 0) return false;
  if (typeof item.height !== "number" || !Number.isFinite(item.height) || item.height < 0) return false;
  return true;
}

// --- Geometria pura (sem DOMMatrix/Path2D -- só aritmética 2D direta) --

/**
 * `transform = [a,b,c,d,e,f]` mapeia espaço do glifo pro espaço do
 * usuário: (a,b) é o vetor de AVANÇO horizontal do item (direção em que
 * `width` se estende), (e,f) é o ponto de origem (início da baseline).
 * Ângulo da direção de leitura = atan2(b,a) -- confirmado empiricamente
 * (rotação de 90° via `cm` produz exatamente transform=[0,s,-s,0,x,y],
 * atan2(s,0)=90°).
 */
function computeItemGeometry(item) {
  const [a, b, , , e, f] = item.transform;
  const angleRad = Math.atan2(b, a);
  const angleDeg = ((angleRad * 180) / Math.PI + 360) % 360;
  const dirX = Math.cos(angleRad);
  const dirY = Math.sin(angleRad);
  // Perpendicular escolhida como (dirY, -dirX) (rotação de -90°, não
  // +90°) especificamente pra que, no caso horizontal comum (dirX=1,
  // dirY=0 -> perp=(0,-1)), `perpCoord` cresça de CIMA pra BAIXO na
  // convenção de coordenadas do PDF (Y cresce pra cima) -- ordenar
  // linhas por `perpCoord` ascendente já corresponde à ordem de leitura
  // natural sem precisar inverter depois. Pra outras orientações, é uma
  // convenção consistente e documentada, não validada perceptualmente
  // (este documento não tem conteúdo realmente rotacionado pra
  // comparar). Só usada por `layoutCandidateText` -- `sourceOrderedText`
  // nunca depende de agrupamento por linha geométrica.
  const perpX = dirY;
  const perpY = -dirX;
  const startX = e;
  const startY = f;
  const endX = e + item.width * dirX;
  const endY = f + item.width * dirY;
  const fontSizeProxy = item.height > 0 ? item.height : Math.hypot(a, b) || 1; // itens com height=0 (espaço sintético do pdf.js) usam a escala do próprio transform como proxy, nunca zero
  return {
    angleDeg,
    dirX,
    dirY,
    perpX,
    perpY,
    startX,
    startY,
    endX,
    endY,
    fontSizeProxy,
    alongStart: startX * dirX + startY * dirY,
    alongEnd: endX * dirX + endY * dirY,
    perpCoord: startX * perpX + startY * perpY,
  };
}

/**
 * Arredonda pro cardeal mais próximo (0/90/180/270) se estiver dentro de
 * ORIENTATION_TOLERANCE_DEG; senão, devolve um rótulo "skew_<grau
 * arredondado>" -- nunca finge que um ângulo oblíquo é cardeal, mas
 * também nunca cria um grupo por fração de grau (agrupa por grau inteiro
 * já arredondado, suficiente pra distinguir orientações de verdade).
 */
function classifyOrientation(angleDeg) {
  const cardinals = [0, 90, 180, 270, 360];
  for (const c of cardinals) {
    if (Math.abs(angleDeg - c) <= ORIENTATION_TOLERANCE_DEG) {
      return c === 360 ? "0" : String(c);
    }
  }
  return `skew_${Math.round(angleDeg)}`;
}

// --- Colapso de fragmentação INTERNA a um item ---------------------------

/**
 * Só colapsa espaço já presente dentro de `item.str` -- nunca junta com
 * OUTRO item, nunca remove caractere não-whitespace. O padrão "muitos
 * tokens de 1 caractere" é só um CANDIDATO -- por si só não prova que os
 * espaços são artefato de decodificação (iniciais/siglas legítimas têm a
 * mesma forma estrutural). A prova adicional, também estrutural e
 * não-lexical: compara o `width` real do item contra uma estimativa
 * genérica de quanto um texto SEM espaço ocuparia
 * (`cleanStr.length * fontSizeProxy * NARROW_GLYPH_ADVANCE_RATIO`). Se o
 * width real for compatível com essa estimativa apertada, os espaços não
 * abriram espaço geométrico de verdade -- corrobora artefato, colapsa.
 * Se o width for nitidamente maior (compatível com espaçamento real
 * entre tokens), a colisão fica AMBÍGUA: a string original é preservada
 * intacta (nunca colapsa por suspeita), e o chamador deve tratar isso
 * como sinal de revisão humana, nunca uso automático em pesquisa.
 */
function collapseInternalFragmentation(item, fontSizeProxy) {
  const str = item.str;
  if (str.indexOf(" ") === -1) return { cleanStr: str, wasFragmented: false, ambiguous: false };
  const tokens = str.split(" ").filter((t) => t.length > 0);
  if (tokens.length < 3) return { cleanStr: str, wasFragmented: false, ambiguous: false }; // amostra pequena demais pra decidir com confiança
  const singleCharCount = tokens.filter((t) => t.length === 1).length;
  const ratio = singleCharCount / tokens.length;
  if (ratio <= INTERNAL_FRAGMENTATION_SINGLE_CHAR_RATIO) {
    return { cleanStr: str, wasFragmented: false, ambiguous: false };
  }

  const collapsed = tokens.join("");
  const expectedTightWidth = collapsed.length * fontSizeProxy * NARROW_GLYPH_ADVANCE_RATIO;
  const widthCorroboratesArtifact = fontSizeProxy > 0 && expectedTightWidth > 0 && item.width <= expectedTightWidth * WIDTH_TIGHTNESS_THRESHOLD;

  if (widthCorroboratesArtifact) {
    return { cleanStr: collapsed, wasFragmented: true, ambiguous: false };
  }
  // Padrão de tokens de 1 caractere presente, mas o width do item é
  // compatível com espaçamento geométrico real -- não há prova
  // estrutural suficiente. Preserva a string original (só whitespace já
  // presente, nada é alterado) e marca como ambíguo.
  return { cleanStr: str, wasFragmented: false, ambiguous: true };
}

// --- Estatística robusta (mediana + MAD) --------------------------------

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * MAD (desvio absoluto mediano) escalado por MAD_TO_SIGMA -- estimador
 * robusto de dispersão, resistente a outliers (ao contrário de
 * desvio-padrão clássico), documentado explicitamente porque a
 * instrução pede a fórmula por escrito:
 *   mediana = mediana(valores)
 *   MAD = mediana(|valor - mediana|) * 1.4826
 * Limiares derivados: continuação <= mediana + 0.5*MAD;
 * espaço >= mediana + 1.5*MAD; entre os dois = ambíguo.
 */
function medianAbsoluteDeviation(values, med) {
  if (values.length === 0) return 0;
  const deviations = values.map((v) => Math.abs(v - med));
  return median(deviations) * MAD_TO_SIGMA;
}

function computeAdaptiveThresholds(allNormalizedGaps) {
  if (allNormalizedGaps.length < MIN_GAP_SAMPLES_FOR_ADAPTIVE) {
    // Amostra insuficiente pra estatística robusta -- fallback documentado,
    // ainda genérico (fração fixa do tamanho de fonte), nunca específico
    // de palavra/documento.
    return { continuationMax: FALLBACK_GAP_RATIO, spaceMin: FALLBACK_GAP_RATIO, medianGap: null, mad: null, fallback: true };
  }
  const med = median(allNormalizedGaps);
  const mad = medianAbsoluteDeviation(allNormalizedGaps, med);
  return {
    continuationMax: med + CONTINUATION_MAD_MULTIPLIER * mad,
    spaceMin: med + SPACE_MAD_MULTIPLIER * mad,
    medianGap: med,
    mad,
    fallback: false,
  };
}

// === CAMINHO PRINCIPAL: sourceOrderedText ================================
// Percorre os itens NA ORDEM ORIGINAL (a ordem do array `items`, que é a
// ordem em que getTextContent() os entregou). Nunca reordena. A única
// decisão é ONDE inserir espaço/quebra de linha entre itens consecutivos
// NESSA ordem -- por isso a distância usada é a distância euclidiana pura
// entre o fim do item anterior e o início do próximo (funciona pra
// qualquer combinação de orientação, já que não depende de projeção num
// eixo comum -- itens consecutivos na ordem original podem, em tese, ter
// orientações diferentes).

function sourceOrderGapMagnitude(prev, cur) {
  const dx = cur.geometry.startX - prev.geometry.endX;
  const dy = cur.geometry.startY - prev.geometry.endY;
  return Math.hypot(dx, dy);
}

function computeSourceOrderRawGaps(geomItems) {
  const gaps = [];
  for (let i = 1; i < geomItems.length; i++) {
    if (geomItems[i - 1].item.hasEOL) continue; // quebra de linha explícita do pdf.js -- não é uma amostra de "vão dentro da linha"
    const gap = sourceOrderGapMagnitude(geomItems[i - 1], geomItems[i]);
    const refSize = (geomItems[i - 1].geometry.fontSizeProxy + geomItems[i].geometry.fontSizeProxy) / 2 || 1;
    gaps.push(gap / refSize);
  }
  return gaps;
}

function buildSourceOrderedText(geomItems, thresholds) {
  if (geomItems.length === 0) {
    return { text: "", ambiguousGapCount: 0, continuationCount: 0, spaceCount: 0, lineCount: 0 };
  }
  let text = geomItems[0].cleanStr;
  let ambiguousGapCount = 0;
  let continuationCount = 0;
  let spaceCount = 0;
  let lineCount = 1;
  for (let i = 1; i < geomItems.length; i++) {
    const prev = geomItems[i - 1];
    const cur = geomItems[i];
    if (prev.item.hasEOL) {
      // Sinal autoritativo do próprio pdf.js -- força quebra de linha
      // independentemente de qualquer distância geométrica.
      text += "\n" + cur.cleanStr;
      lineCount++;
      continue;
    }
    const gap = sourceOrderGapMagnitude(prev, cur);
    const refSize = (prev.geometry.fontSizeProxy + cur.geometry.fontSizeProxy) / 2 || 1;
    const normalizedGap = gap / refSize;
    let sep;
    if (normalizedGap <= thresholds.continuationMax) {
      sep = "";
      continuationCount++;
    } else if (normalizedGap >= thresholds.spaceMin) {
      sep = " ";
      spaceCount++;
    } else {
      // Ambíguo ainda recebe espaço (mais seguro pra legibilidade), mas
      // é contado separadamente -- nunca finge certeza que não existe.
      sep = " ";
      ambiguousGapCount++;
    }
    text += sep + cur.cleanStr;
  }
  return { text, ambiguousGapCount, continuationCount, spaceCount, lineCount };
}

// === CAMINHO CANDIDATO: layoutCandidateText ===============================
// Agrupa por orientação + projeção geométrica; PODE reordenar itens
// (colunas, RTL, texto fora de ordem no content stream). Só um candidato
// diagnóstico -- nunca substitui sourceOrderedText, nunca é elegível pra
// ingestão sozinho quando diverge da ordem original.

function groupItemsByOrientationAndLine(geomItems) {
  const orientationMap = new Map();
  for (const gi of geomItems) {
    const key = classifyOrientation(gi.geometry.angleDeg);
    if (!orientationMap.has(key)) orientationMap.set(key, []);
    orientationMap.get(key).push(gi);
  }

  const orientationGroups = [];
  for (const [orientation, items] of orientationMap) {
    const sorted = [...items].sort((x, y) => x.geometry.perpCoord - y.geometry.perpCoord);
    const lines = [];
    let currentLine = [];
    let prevPerp = null;
    let prevHadEOL = false;
    for (const gi of sorted) {
      const tol = gi.geometry.fontSizeProxy * LINE_PERP_TOLERANCE_RATIO;
      const sameLine = currentLine.length > 0 && !prevHadEOL && Math.abs(gi.geometry.perpCoord - prevPerp) <= tol;
      if (!sameLine) {
        if (currentLine.length > 0) lines.push(currentLine);
        currentLine = [];
      }
      currentLine.push(gi);
      prevPerp = gi.geometry.perpCoord;
      prevHadEOL = !!gi.item.hasEOL;
    }
    if (currentLine.length > 0) lines.push(currentLine);

    // `line.rtl` fica marcado na própria linha (propriedade extra no
    // array) porque a classificação de vão também precisa saber o
    // sentido -- em RTL, a "borda de saída" do item anterior na ordem de
    // leitura é seu INÍCIO geométrico, não seu fim.
    for (const line of lines) {
      const rtl = line.filter((gi) => gi.item.dir === "rtl").length > line.length / 2;
      line.sort((x, y) => (rtl ? y.geometry.alongStart - x.geometry.alongStart : x.geometry.alongStart - y.geometry.alongStart));
      line.rtl = rtl;
    }
    orientationGroups.push({ orientation, lines });
  }

  orientationGroups.sort((x, y) => y.lines.flat().length - x.lines.flat().length);
  return orientationGroups;
}

function gapBetween(prev, cur, rtl) {
  return rtl ? prev.geometry.alongStart - cur.geometry.alongEnd : cur.geometry.alongStart - prev.geometry.alongEnd;
}

function classifyGaps(line, thresholds) {
  const decisions = [];
  for (let i = 1; i < line.length; i++) {
    const prev = line[i - 1];
    const cur = line[i];
    const gap = gapBetween(prev, cur, line.rtl);
    const refSize = (prev.geometry.fontSizeProxy + cur.geometry.fontSizeProxy) / 2 || 1;
    const normalizedGap = gap / refSize;
    let decision;
    if (normalizedGap <= thresholds.continuationMax) decision = "continuation";
    else if (normalizedGap >= thresholds.spaceMin) decision = "space";
    else decision = "ambiguous";
    decisions.push({ normalizedGap, decision });
  }
  return decisions;
}

// --- Invariâncias (duas, propositalmente distintas) ----------------------

/**
 * `characterMultisetInvariant`: mesmos caracteres não-whitespace, mesma
 * quantidade -- comparação por MULTICONJUNTO (ordenado antes de
 * comparar), NÃO prova ordem. Prova apenas que nenhum caractere foi
 * inventado, apagado ou duplicado.
 */
function checkCharacterMultisetInvariant(beforeText, afterText) {
  const stripBefore = Array.from(beforeText.replace(/\s/g, ""));
  const stripAfter = Array.from(afterText.replace(/\s/g, ""));
  if (stripBefore.length !== stripAfter.length) return false;
  const a = [...stripBefore].sort();
  const b = [...stripAfter].sort();
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * `sourceOrderInvariant`: sequência de pontos de código não-whitespace
 * EXATAMENTE igual à concatenação dos itens na ordem original (sensível
 * à ordem -- é o requisito mais forte, o único que prova preservação de
 * sentido). Comparado por PONTO DE CÓDIGO Unicode (`Array.from`, que
 * itera pelo iterador de string nativo, ciente de pares substitutos),
 * nunca por unidade UTF-16 crua -- um caractere fora do BMP nunca é
 * fragmentado em metade de par substituto durante a comparação.
 */
function checkSourceOrderInvariant(beforeText, afterText) {
  const stripBefore = Array.from(beforeText.replace(/\s/g, ""));
  const stripAfter = Array.from(afterText.replace(/\s/g, ""));
  if (stripBefore.length !== stripAfter.length) return false;
  for (let i = 0; i < stripBefore.length; i++) {
    if (stripBefore[i] !== stripAfter[i]) return false;
  }
  return true;
}

// --- Qualidade determinística --------------------------------------------

function classifyQuality({
  isEmpty,
  characterMultisetInvariantOk,
  sourceOrderInvariantOk,
  truncated,
  singleCharTokenRatio,
  ambiguousGapRatio,
  orientationGroupCount,
  wordCount,
  rawCharCount,
  excessiveLineFragmentation,
  hasAmbiguousInternalFragmentation,
  layoutCandidateOrderDiverged,
}) {
  if (isEmpty) return "image_only";
  // Nenhuma das duas invariantes pode falhar silenciosamente -- qualquer
  // uma delas falsa é sempre "poor", nunca "good"/"review_required".
  if (!characterMultisetInvariantOk) return "poor";
  if (!sourceOrderInvariantOk) return "poor";
  if (singleCharTokenRatio > 0.3) return "poor";
  if (excessiveLineFragmentation) return "poor";
  // A partir daqui a página nunca é "poor" -- só falta decidir entre
  // "review_required" e "good". Nenhuma das condições abaixo, sozinha,
  // derruba pra "poor"; todas impedem "good".
  if (truncated) return "review_required"; // texto truncado nunca é "good"
  if (hasAmbiguousInternalFragmentation) return "review_required"; // colapso interno sem prova estrutural suficiente -- nunca uso automático
  if (layoutCandidateOrderDiverged) return "review_required"; // candidato geométrico discordou da ordem original -- página estruturalmente complexa, exige revisão
  if (ambiguousGapRatio > 0.3) return "review_required";
  if (orientationGroupCount > 1) return "review_required";
  if (rawCharCount < 60 || wordCount < 5) return "review_required";
  if (singleCharTokenRatio > 0.1) return "review_required";
  return "good";
}

// --- Função principal -----------------------------------------------------

/**
 * Reconstrói o texto de UMA página a partir dos itens reais de
 * `page.getTextContent()`. Devolve `sourceOrderedText` (ordem original,
 * elegível pra ingestão futura) e `layoutCandidateText` (geometria, pode
 * reordenar, só diagnóstico), mais `characterMultisetInvariant` e
 * `sourceOrderInvariant` calculadas separadamente contra a concatenação
 * bruta original. NUNCA lança para entrada válida (array, mesmo vazio);
 * entrada não-array lança `TextReconstructionError` explicitamente.
 */
function reconstructPageText(items, options = {}) {
  if (!Array.isArray(items)) {
    throw new TextReconstructionError("items must be an array");
  }
  const maxItems = options.maxItems ?? 20000;
  if (items.length > maxItems) {
    throw new TextReconstructionError(`items exceeds the maximum allowed count of ${maxItems}`);
  }

  const beforeConcat = items.map((it) => (it && typeof it.str === "string" ? it.str : "")).join("");

  const validItems = items.filter(isValidItem);
  const invalidItemCount = items.length - validItems.length;
  // Item inválido com conteúdo não-whitespace NUNCA é descartado
  // silenciosamente: é contado aqui, e sua ausência da geometria derruba
  // sourceOrderInvariant/characterMultisetInvariant de forma visível
  // (comprimento não bate), forçando "poor" em classifyQuality.
  const invalidItemsWithContentCount = items.filter(
    (it) => !isValidItem(it) && it && typeof it.str === "string" && it.str.replace(/\s/g, "").length > 0
  ).length;

  if (validItems.length === 0) {
    const sourceOrderedText = "";
    const layoutCandidateText = "";
    const characterMultisetInvariant = checkCharacterMultisetInvariant(beforeConcat, sourceOrderedText);
    const sourceOrderInvariant = checkSourceOrderInvariant(beforeConcat, sourceOrderedText);
    const layoutCandidateOrderDiverged = !checkSourceOrderInvariant(beforeConcat, layoutCandidateText);
    const qualityStatus = classifyQuality({
      isEmpty: beforeConcat.replace(/\s/g, "").length === 0,
      characterMultisetInvariantOk: characterMultisetInvariant,
      sourceOrderInvariantOk: sourceOrderInvariant,
      truncated: false,
      singleCharTokenRatio: 0,
      ambiguousGapRatio: 0,
      orientationGroupCount: 0,
      wordCount: 0,
      rawCharCount: 0,
      excessiveLineFragmentation: false,
      hasAmbiguousInternalFragmentation: false,
      layoutCandidateOrderDiverged,
    });
    return {
      sourceOrderedText,
      layoutCandidateText,
      reconstructionApplied: true,
      reconstructionConfidence: characterMultisetInvariant && sourceOrderInvariant ? 1 : 0,
      reconstructionDiagnostics: {
        invalidItemCount,
        invalidItemsWithContentCount,
        itemCount: items.length,
        continuationCount: 0,
        spaceCount: 0,
        ambiguousGapCount: 0,
        internallyFragmentedItemCount: 0,
        internalFragmentationAmbiguousCount: 0,
        fallbackThresholds: false,
        medianGap: null,
        mad: null,
      },
      ambiguousGapCount: 0,
      lineCount: 0,
      orientationGroups: 0,
      layoutCandidateMultisetInvariant: characterMultisetInvariant,
      layoutCandidateAmbiguousGapCount: 0,
      layoutCandidateLineCount: 0,
      layoutCandidateOrderDiverged,
      characterMultisetInvariant,
      sourceOrderInvariant,
      qualityStatus,
    };
  }

  let internallyFragmentedItemCount = 0;
  let internalFragmentationAmbiguousCount = 0;
  const geomItems = validItems.map((item) => {
    const geometry = computeItemGeometry(item);
    const { cleanStr, wasFragmented, ambiguous } = collapseInternalFragmentation(item, geometry.fontSizeProxy);
    if (wasFragmented) internallyFragmentedItemCount++;
    if (ambiguous) internalFragmentationAmbiguousCount++;
    return { item, cleanStr, geometry };
  });

  // --- sourceOrderedText: ordem original, só whitespace -----------------
  const sourceRawGaps = computeSourceOrderRawGaps(geomItems);
  const sourceThresholds = computeAdaptiveThresholds(sourceRawGaps);
  const sourceBuild = buildSourceOrderedText(geomItems, sourceThresholds);
  const sourceOrderedText = sourceBuild.text;

  // --- layoutCandidateText: geometria, pode reordenar (diagnóstico) -----
  const orientationGroups = groupItemsByOrientationAndLine(geomItems);
  const allLines = orientationGroups.flatMap((g) => g.lines);
  const layoutRawGaps = [];
  for (const line of allLines) {
    for (let i = 1; i < line.length; i++) {
      const gap = gapBetween(line[i - 1], line[i], line.rtl);
      const refSize = (line[i - 1].geometry.fontSizeProxy + line[i].geometry.fontSizeProxy) / 2 || 1;
      layoutRawGaps.push(gap / refSize);
    }
  }
  const layoutThresholds = computeAdaptiveThresholds(layoutRawGaps);
  let layoutAmbiguousGapCount = 0;
  const layoutLineTexts = [];
  for (const group of orientationGroups) {
    for (const line of group.lines) {
      const decisions = classifyGaps(line, layoutThresholds);
      let lineText = line[0].cleanStr;
      for (let i = 0; i < decisions.length; i++) {
        const { decision } = decisions[i];
        if (decision === "ambiguous") layoutAmbiguousGapCount++;
        const sep = decision === "continuation" ? "" : " ";
        lineText += sep + line[i + 1].cleanStr;
      }
      layoutLineTexts.push(lineText.trim());
    }
  }
  const layoutCandidateText = layoutLineTexts.filter((l) => l.length > 0).join("\n");
  const layoutCandidateLineCount = layoutLineTexts.filter((l) => l.length > 0).length;

  // --- Invariâncias -- SEMPRE contra a concatenação bruta original, na
  // ordem em que getTextContent() entregou os itens ----------------------
  const characterMultisetInvariant = checkCharacterMultisetInvariant(beforeConcat, sourceOrderedText);
  const sourceOrderInvariant = checkSourceOrderInvariant(beforeConcat, sourceOrderedText);
  const layoutCandidateMultisetInvariant = checkCharacterMultisetInvariant(beforeConcat, layoutCandidateText);
  const layoutCandidateOrderDiverged = !checkSourceOrderInvariant(beforeConcat, layoutCandidateText);

  const totalGapDecisions = sourceBuild.continuationCount + sourceBuild.spaceCount + sourceBuild.ambiguousGapCount;
  const ambiguousGapRatio = totalGapDecisions > 0 ? sourceBuild.ambiguousGapCount / totalGapDecisions : 0;

  const tokens = sourceOrderedText.split(/\s+/).filter(Boolean);
  const singleCharTokenRatio = tokens.length > 0 ? tokens.filter((t) => t.length === 1).length / tokens.length : 0;
  const linesForFragmentationCheck = sourceOrderedText.split("\n").filter((l) => l.trim().length > 0);
  const linesWithManySingleChar = linesForFragmentationCheck.filter((l) => {
    const lt = l.split(/\s+/).filter(Boolean);
    return lt.length >= 4 && lt.filter((t) => t.length === 1).length / lt.length > 0.6;
  }).length;
  const excessiveLineFragmentation = linesForFragmentationCheck.length > 0 && linesWithManySingleChar / linesForFragmentationCheck.length > 0.5;

  const qualityStatus = classifyQuality({
    isEmpty: sourceOrderedText.trim().length === 0,
    characterMultisetInvariantOk: characterMultisetInvariant,
    sourceOrderInvariantOk: sourceOrderInvariant,
    truncated: false, // truncamento é decidido pelo chamador (limite de saída), nunca por este módulo
    singleCharTokenRatio,
    ambiguousGapRatio,
    orientationGroupCount: orientationGroups.length,
    wordCount: tokens.length,
    rawCharCount: sourceOrderedText.replace(/\s/g, "").length,
    excessiveLineFragmentation,
    hasAmbiguousInternalFragmentation: internalFragmentationAmbiguousCount > 0,
    layoutCandidateOrderDiverged,
  });

  const confidence =
    characterMultisetInvariant && sourceOrderInvariant
      ? Math.max(
          0,
          1 -
            ambiguousGapRatio -
            (orientationGroups.length > 1 ? 0.2 : 0) -
            (excessiveLineFragmentation ? 0.3 : 0) -
            (internalFragmentationAmbiguousCount > 0 ? 0.2 : 0)
        )
      : 0;

  return {
    sourceOrderedText,
    layoutCandidateText,
    reconstructionApplied: true,
    reconstructionConfidence: Number(confidence.toFixed(3)),
    reconstructionDiagnostics: {
      invalidItemCount,
      invalidItemsWithContentCount,
      itemCount: items.length,
      continuationCount: sourceBuild.continuationCount,
      spaceCount: sourceBuild.spaceCount,
      ambiguousGapCount: sourceBuild.ambiguousGapCount,
      internallyFragmentedItemCount,
      internalFragmentationAmbiguousCount,
      fallbackThresholds: sourceThresholds.fallback,
      medianGap: sourceThresholds.medianGap,
      mad: sourceThresholds.mad,
    },
    ambiguousGapCount: sourceBuild.ambiguousGapCount,
    lineCount: sourceBuild.lineCount,
    orientationGroups: orientationGroups.length,
    layoutCandidateMultisetInvariant,
    layoutCandidateAmbiguousGapCount: layoutAmbiguousGapCount,
    layoutCandidateLineCount,
    layoutCandidateOrderDiverged,
    characterMultisetInvariant,
    sourceOrderInvariant,
    qualityStatus,
  };
}

class TextReconstructionError extends Error {
  constructor(detail) {
    super(`Invalid input for text reconstruction: ${detail}`);
    this.name = this.constructor.name;
    this.code = "TEXT_RECONSTRUCTION_ERROR";
  }
}

module.exports = {
  reconstructPageText,
  isValidItem,
  computeItemGeometry,
  classifyOrientation,
  collapseInternalFragmentation,
  median,
  medianAbsoluteDeviation,
  computeAdaptiveThresholds,
  checkCharacterMultisetInvariant,
  checkSourceOrderInvariant,
  classifyQuality,
  TextReconstructionError,
  ORIENTATION_TOLERANCE_DEG,
  LINE_PERP_TOLERANCE_RATIO,
  INTERNAL_FRAGMENTATION_SINGLE_CHAR_RATIO,
  NARROW_GLYPH_ADVANCE_RATIO,
  WIDTH_TIGHTNESS_THRESHOLD,
  MIN_GAP_SAMPLES_FOR_ADAPTIVE,
  FALLBACK_GAP_RATIO,
  CONTINUATION_MAD_MULTIPLIER,
  SPACE_MAD_MULTIPLIER,
  MAD_TO_SIGMA,
};

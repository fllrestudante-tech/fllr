// Institutional Context — não é um Brain novo (confirmado pelo usuário),
// é a síntese de Liquidity + FVG + Order Block Brain, do mesmo jeito que
// Context Fusion (lib/brains/contextFusion.js) sintetiza Market+Structure+
// Liquidity. A diferença: Context Fusion responde "qual é a direção
// dominante e o quanto os Brains concordam" (bias direcional); esta
// camada responde uma pergunta espacial -- "existe uma ZONA DE PREÇO onde
// os 3 sinais de smart money se sobrepõem?" (confluência clássica de
// SMC/ICT: liquidity sweep + FVG + Order Block no mesmo lugar = zona de
// alta probabilidade).
//
// Pura, sem I/O próprio -- recebe os 3 BrainResult já computados. Devolve
// também um BrainResult (mesma disciplina de sempre, mantém a interface
// uniforme com dashboard/health.js).
//
// Puramente observacional -- index.js::cycle() não depende disto.
//
// Próxima evolução prevista: Replay Engine, depois Decision Brain e
// Learning Engine.
const { createBrainResult } = require("./brainResult");

const MISSING_EVIDENCE = ["Replay Engine (validação estatística de confluência)"];

function rangesOverlap(a, b) {
  return a.low <= b.high && b.low <= a.high;
}

/**
 * Cruza só o que está "vivo agora" (fvg.activeGaps x orderBlock.activeBlocks)
 * -- cruzar o histórico completo geraria ruído (dezenas de gaps/blocos já
 * mortos), os próprios Brains de origem já peneiraram isso. Zona de
 * confluência = interseção exata (onde os dois sinais concordam ao mesmo
 * tempo), não a união. Liquidez entra como REFORÇO (não tem direção
 * própria confiável, é só um nível/ímã) -- se um nível de liquidez cai
 * dentro da interseção FVG+OB, a zona sobe de 2 pra 3 fontes.
 */
function findConfluenceZones({ liquidity, fvg, orderBlock }) {
  const gaps = fvg.activeGaps || [];
  const blocks = orderBlock.activeBlocks || [];
  const liquidityLevels = [...(liquidity.zones?.above || []), ...(liquidity.zones?.below || [])];

  const zones = [];
  for (const gap of gaps) {
    for (const block of blocks) {
      if (gap.direction !== block.direction) continue;
      if (!rangesOverlap(gap, block)) continue;

      const low = Math.max(gap.low, block.low);
      const high = Math.min(gap.high, block.high);
      const sources = ["fvg", "order_block"];
      if (liquidityLevels.some((l) => l.level >= low && l.level <= high)) sources.push("liquidity");

      zones.push({ low, high, direction: gap.direction, blockStage: block.stage, sources });
    }
  }

  return zones.sort((a, b) => b.sources.length - a.sources.length || (b.blockStage === "ACTIVE") - (a.blockStage === "ACTIVE"));
}

const SOURCE_LABEL = { fvg: "FVG", order_block: "Order Block", liquidity: "Liquidity" };

function synthesizeInstitutionalContext({ liquidity, fvg, orderBlock }) {
  const startedAt = Date.now();

  const zones = findConfluenceZones({ liquidity, fvg, orderBlock });
  const dominantZone = zones.length > 0 ? zones[0] : null;

  const state = !dominantZone ? "NO_CONFLUENCE" : dominantZone.sources.length === 3 ? "STRONG_CONFLUENCE" : "MODERATE_CONFLUENCE";
  const score = !dominantZone ? 0 : dominantZone.sources.length === 3 ? 100 : 60;
  const confidence = Math.round((liquidity.confidence + fvg.confidence + orderBlock.confidence) / 3);

  const reasons = [];
  if (dominantZone) {
    const dirLabel = dominantZone.direction === "bullish" ? "bullish" : "bearish";
    const sourcesLabel = dominantZone.sources.map((s) => SOURCE_LABEL[s]).join("+");
    reasons.push(`Confluência ${dirLabel} (${sourcesLabel}) entre ${dominantZone.low.toFixed(2)}-${dominantZone.high.toFixed(2)}`);
  } else {
    reasons.push("Nenhuma confluência institucional (Liquidity+FVG+Order Block) encontrada no momento");
  }
  if (zones.length > 1) reasons.push(`${zones.length} zonas de confluência ativas no total`);

  const evidence = zones.map((z) => ({
    type: "CONFLUENCE_ZONE",
    confidence: Math.round((z.sources.length / 3) * 100),
    weight: z.sources.length,
    timestamp: fvg.metadata.sourceDataTime,
    payload: { low: z.low, high: z.high, direction: z.direction, sources: z.sources },
  }));

  return createBrainResult({
    state,
    confidence,
    score,
    reasons,
    evidence,
    missingEvidence: MISSING_EVIDENCE,
    sourceDataTime: fvg.metadata.sourceDataTime,
    startedAt,
    dependsOn: ["liquidity_brain", "fvg_brain", "order_block_brain"],
    extra: { zones, dominantZone },
  });
}

module.exports = { synthesizeInstitutionalContext, findConfluenceZones, rangesOverlap };

// Replay Engine — não é um gerador de dataset, é o JUIZ dos próprios
// Brains. Anda pelo histórico de candles em passos, roda a cadeia inteira
// de Brains (mesma ordem de dependência de sempre: Market -> Structure ->
// Liquidity -> Context Fusion -> FVG -> Order Block -> Institutional
// Context), grava um snapshot enxuto, espera `outcomeHorizonCandles` pra
// medir o que o preço fez de verdade e atribui um veredito contra a
// direção que o Context Fusion já tinha fundido. `computeStats` responde
// "essa combinação de estados acerta quanto?" e `computeTransitions`
// devolve a sequência de mudanças de estado de um Brain (Bull -> Weak ->
// Broken -> Recovery), sem duplicar a mesma leitura repetida snapshot a
// snapshot.
//
// Restrição documentada (não é hack): os eixos sentimento/risco do
// Market Brain sempre leem "o dado mais recente agora"
// (lib/brains/marketBrainData.js -- sem filtro de tempo). Replayar isso
// vazaria dado do FUTURO pra dentro de um snapshot antigo (look-ahead
// bias). Por isso aqui `analyzeMarket` recebe só `closes` -- os outros
// campos vão null/[]/vazio, que é literalmente o caminho de "dado
// indisponível" que lib/brains/marketBrain.js já trata sozinho. Corrigir
// isso de verdade exigiria consultas "asOf(cutoffTime)" nas 5 tabelas
// (Fear&Greed/funding/OI/long-short/dominância), documentado como
// próximo passo, não construído agora.
//
// Puro sobre um array de candles já carregado -- não abre banco, não
// escreve arquivo (isso é papel de scripts/replayEngine.js).
// Puramente observacional -- index.js::cycle() não depende disto.
const { analyzeMarket } = require("./brains/marketBrain");
const { analyzeStructure } = require("./brains/structureBrain");
const { analyzeLiquidity } = require("./brains/liquidityBrain");
const { fuseContext } = require("./brains/contextFusion");
const { analyzeFVG } = require("./brains/fvgBrain");
const { analyzeOrderBlocks } = require("./brains/orderBlockBrain");
const { synthesizeInstitutionalContext } = require("./brains/institutionalContext");

const EVIDENCE_SOURCES = [
  { brain: "structure", key: "structure" },
  { brain: "liquidity", key: "liquidity" },
  { brain: "fvg", key: "fvg" },
  { brain: "orderBlock", key: "orderBlock" },
];

function pickSummary(brain) {
  return { state: brain.state, confidence: brain.confidence, score: brain.score };
}

/**
 * Evidência nova desde o último snapshot -- janelas de replay se
 * sobrepõem quase inteiras entre passos consecutivos, sem esse filtro o
 * mesmo BOS/sweep/gap/bloco antigo apareceria repetido em dezenas de
 * snapshots seguidos.
 */
function extractNewEvents(brains, lastSnapshotTime) {
  const events = [];
  for (const { brain, key } of EVIDENCE_SOURCES) {
    for (const e of brains[key].evidence || []) {
      const eventTime = new Date(e.timestamp).getTime();
      if (eventTime > lastSnapshotTime) events.push({ brain, type: e.type, timestamp: e.timestamp });
    }
  }
  return events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

const DIRECTION_FROM_CONTEXT_STATE = { FUSED_BULLISH: "bull", FUSED_BEARISH: "bear", FUSED_NEUTRAL: null };

/**
 * Veredito contra a direção que o Context Fusion já fundiu -- não
 * recalcula direção aqui, reaproveita. PENDING quando não há candles
 * futuros suficientes ainda (replay não fabrica o que ainda não
 * aconteceu); NOT_GRADED quando o contexto era neutro (nenhuma direção
 * foi de fato "apostada"); INCONCLUSIVE dentro do threshold (hipótese,
 * calibrável, é exatamente o tipo de número que este motor existe pra
 * validar no futuro).
 */
function gradeOutcome(candles, i, outcomeHorizonCandles, outcomeThresholdPct, contextState) {
  const forwardIndex = i + outcomeHorizonCandles;
  if (forwardIndex >= candles.length) return { outcome: "PENDING", forwardReturnPct: null };

  const currentClose = parseFloat(candles[i][4]);
  const futureClose = parseFloat(candles[forwardIndex][4]);
  const forwardReturnPct = ((futureClose - currentClose) / currentClose) * 100;

  const direction = DIRECTION_FROM_CONTEXT_STATE[contextState];
  if (!direction) return { outcome: "NOT_GRADED", forwardReturnPct };

  const favorable = direction === "bull" ? forwardReturnPct : -forwardReturnPct;
  if (favorable > outcomeThresholdPct) return { outcome: "SUCCESS", forwardReturnPct };
  if (favorable < -outcomeThresholdPct) return { outcome: "FAIL", forwardReturnPct };
  return { outcome: "INCONCLUSIVE", forwardReturnPct };
}

function runReplay(candles, options) {
  const {
    stepCandles,
    windowCandles,
    outcomeHorizonCandles,
    outcomeThresholdPct,
    structureLookback,
    equalTolerancePct,
    sweepReversalLookahead,
    exhaustionLookback,
    confirmAge,
    mitigationThreshold,
  } = options;

  const snapshots = [];
  let lastSnapshotTime = -Infinity;

  for (let i = windowCandles - 1; i < candles.length; i += stepCandles) {
    const windowSlice = candles.slice(i - windowCandles + 1, i + 1);

    const market = analyzeMarket({
      closes: windowSlice.map((c) => c[4]),
      fearGreedHistory: [],
      fundingRate: null,
      oiTrendPct: null,
      longShortSkew: null,
      dominanceTrendPct: null,
    });
    const structure = analyzeStructure({ candles: windowSlice, lookback: structureLookback });
    const liquidity = analyzeLiquidity({ candles: windowSlice, lookback: structureLookback, equalTolerancePct, sweepReversalLookahead });
    const context = fuseContext({ market, structure, liquidity });
    const fvg = analyzeFVG({ candles: windowSlice, structure, liquidity, context, exhaustionLookback });
    const orderBlock = analyzeOrderBlocks({ candles: windowSlice, structure, liquidity, context, confirmAge, mitigationThreshold, exhaustionLookback });
    const institutional = synthesizeInstitutionalContext({ liquidity, fvg, orderBlock });

    const timestamp = windowSlice[windowSlice.length - 1][0];
    const price = parseFloat(windowSlice[windowSlice.length - 1][4]);

    const newEvents = extractNewEvents({ structure, liquidity, fvg, orderBlock }, lastSnapshotTime);
    lastSnapshotTime = timestamp;

    const { outcome, forwardReturnPct } = gradeOutcome(candles, i, outcomeHorizonCandles, outcomeThresholdPct, context.state);

    snapshots.push({
      timestamp,
      price,
      brains: {
        market: pickSummary(market),
        structure: pickSummary(structure),
        liquidity: pickSummary(liquidity),
        context: pickSummary(context),
        fvg: pickSummary(fvg),
        orderBlock: pickSummary(orderBlock),
        institutional: pickSummary(institutional),
      },
      newEvents,
      outcome,
      forwardReturnPct,
    });
  }

  return snapshots;
}

const GRADED_OUTCOMES = ["SUCCESS", "FAIL", "INCONCLUSIVE"];

/**
 * "Essa combinação de estados acerta quanto?" -- agrupa só os snapshots já
 * julgados (exclui PENDING/NOT_GRADED, não dá pra tirar taxa de acerto de
 * quem não tinha direção nenhuma) pela combinação real dos states dos
 * Brains pedidos. successRate conta INCONCLUSIVE contra (denominador é o
 * grupo inteiro) -- escolha documentada, não a única possível.
 */
function computeStats(snapshots, brainKeys) {
  const graded = snapshots.filter((s) => GRADED_OUTCOMES.includes(s.outcome));

  const groups = new Map();
  for (const s of graded) {
    const comboKey = brainKeys.map((k) => `${k}:${s.brains[k].state}`).join("|");
    if (!groups.has(comboKey)) groups.set(comboKey, []);
    groups.get(comboKey).push(s);
  }

  const rows = [];
  for (const [comboKey, group] of groups) {
    const successCount = group.filter((s) => s.outcome === "SUCCESS").length;
    const avgForwardReturnPct = group.reduce((sum, s) => sum + s.forwardReturnPct, 0) / group.length;
    rows.push({
      comboKey,
      count: group.length,
      successRate: Math.round((successCount / group.length) * 100),
      avgForwardReturnPct: Number(avgForwardReturnPct.toFixed(3)),
    });
  }

  return rows.sort((a, b) => b.count - a.count);
}

/**
 * Só as MUDANÇAS de estado de um Brain, em ordem cronológica -- colapsa
 * repetições consecutivas (produz "Bull -> Weak -> Broken -> Recovery",
 * não a mesma leitura duplicada em toda linha).
 */
function computeTransitions(snapshots, brainKey) {
  const transitions = [];
  let lastState = null;
  for (const s of snapshots) {
    const state = s.brains[brainKey].state;
    if (state !== lastState) {
      transitions.push({ state, timestamp: s.timestamp });
      lastState = state;
    }
  }
  return transitions;
}

module.exports = { runReplay, gradeOutcome, extractNewEvents, computeStats, computeTransitions };

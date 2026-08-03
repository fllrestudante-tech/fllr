// Brain Analytics — a camada estatística entre Replay Engine e Decision
// Brain. Não é um Brain novo: opera sobre snapshots já gerados por
// lib/replayEngine.js (precisa do campo `direction` por Brain, adicionado
// especificamente pra isto). Responde 4 perguntas pedidas pelo usuário:
//
// 1. computeBrainAccuracy -- "esse Brain sozinho acerta quanto?"
//    (accuracy/precision/recall).
// 2. computeMarginalContribution -- "cada Brain adicional melhora o
//    acerto, ou só aumenta a complexidade?" (escada de unanimidade
//    crescente: Market sozinho -> +Structure -> +Liquidity -> ...).
// 3. computeRedundancy -- "um Brain já explica o comportamento de
//    outro?" (taxa de concordância entre a direção de um Brain-alvo e o
//    consenso de outros).
// 4. evaluateDecisionBrainReadiness -- os 3 critérios objetivos do
//    usuário pra saber quando o Decision Brain pode nascer (amostra
//    mínima, diversidade de regime, estabilidade ao longo do tempo).
//
// `computeStats`/`computeTransitions` (ranking de combinações e
// transições de estado) já existiam em lib/replayEngine.js -- não
// duplicados aqui.
//
// Puro, sem I/O -- opera sobre o array de snapshots, seja vindo direto
// de runReplay() ou lido de data/replay/snapshots.jsonl.

/**
 * Direção real do mercado no horizonte, pelo mesmo threshold que
 * lib/replayEngine.js::gradeOutcome já usa (dentro dele = "flat", sem
 * direção real o suficiente pra contar a favor ou contra ninguém).
 */
function actualDirectionFromReturn(forwardReturnPct, thresholdPct) {
  if (forwardReturnPct > thresholdPct) return "bull";
  if (forwardReturnPct < -thresholdPct) return "bear";
  return "flat";
}

/**
 * Direção só conta como consenso se TODOS os Brains do grupo tiverem uma
 * direção não-nula E concordarem entre si -- um único Brain sem opinião
 * (ou discordando) já invalida o consenso do grupo inteiro (unanimidade
 * de verdade, não maioria).
 */
function unanimousDirection(directions) {
  const nonNull = directions.filter(Boolean);
  if (nonNull.length !== directions.length) return null;
  return nonNull.every((d) => d === nonNull[0]) ? nonNull[0] : null;
}

/**
 * accuracy = % de acerto direcional (bull/bear previsto bate com o
 * retorno real, "flat" sempre conta como erro se o Brain apostou uma
 * direção). precision/recall são calculados por classe (bull, bear) e
 * devolvidos como média macro das duas -- uma classe sem nenhuma
 * ocorrência é excluída da média (não vira 0 artificial, que puniria um
 * Brain só por nunca ter apostado num lado).
 */
function computeBrainAccuracy(snapshots, brainKey, outcomeThresholdPct) {
  const graded = snapshots.filter((s) => s.brains[brainKey].direction && s.forwardReturnPct !== null && s.forwardReturnPct !== undefined);
  const totalCalls = graded.length;
  if (totalCalls === 0) return { brainKey, totalCalls: 0, accuracy: 0, precision: 0, recall: 0 };

  let correct = 0;
  const perClass = { bull: { tp: 0, predicted: 0, actual: 0 }, bear: { tp: 0, predicted: 0, actual: 0 } };

  for (const s of graded) {
    const predicted = s.brains[brainKey].direction;
    const actual = actualDirectionFromReturn(s.forwardReturnPct, outcomeThresholdPct);
    if (predicted === actual) correct++;
    perClass[predicted].predicted++;
    if (actual === "bull") perClass.bull.actual++;
    if (actual === "bear") perClass.bear.actual++;
    if (predicted === actual) perClass[predicted].tp++;
  }

  const accuracy = Math.round((correct / totalCalls) * 100);

  const precisions = [];
  const recalls = [];
  for (const cls of ["bull", "bear"]) {
    if (perClass[cls].predicted > 0) precisions.push(perClass[cls].tp / perClass[cls].predicted);
    if (perClass[cls].actual > 0) recalls.push(perClass[cls].tp / perClass[cls].actual);
  }
  const precision = precisions.length > 0 ? Math.round((precisions.reduce((a, b) => a + b, 0) / precisions.length) * 100) : 0;
  const recall = recalls.length > 0 ? Math.round((recalls.reduce((a, b) => a + b, 0) / recalls.length) * 100) : 0;

  return { brainKey, totalCalls, accuracy, precision, recall };
}

/**
 * Escada de contribuição marginal: pra cada tamanho de grupo k=1..N,
 * exige unanimidade entre os primeiros k Brains de `brainKeys` (a ordem
 * importa -- é a escada) e mede a acurácia dessa direção unânime contra o
 * retorno real. A amostra ENCOLHE conforme k cresce (mais Brains
 * concordando é mais raro) -- isso é o dado, não um bug; responde
 * exatamente "esse Brain a mais melhora o acerto ou só reduz a amostra
 * sem ganho real?".
 */
function computeMarginalContribution(snapshots, brainKeys, outcomeThresholdPct) {
  const graded = snapshots.filter((s) => s.forwardReturnPct !== null && s.forwardReturnPct !== undefined);

  const rows = [];
  for (let k = 1; k <= brainKeys.length; k++) {
    const combo = brainKeys.slice(0, k);
    let correct = 0;
    let sampleSize = 0;
    for (const s of graded) {
      const consensus = unanimousDirection(combo.map((key) => s.brains[key].direction));
      if (!consensus) continue;
      sampleSize++;
      if (consensus === actualDirectionFromReturn(s.forwardReturnPct, outcomeThresholdPct)) correct++;
    }
    rows.push({ combo, sampleSize, accuracy: sampleSize > 0 ? Math.round((correct / sampleSize) * 100) : 0 });
  }
  return rows;
}

/**
 * "Liquidity+Order Block já explica X% do comportamento do FVG" -- taxa
 * de concordância observada entre o alvo e o consenso unânime dos
 * explicadores. Não fabrica causalidade, só mede coincidência de
 * direção -- uma taxa alta é um bom candidato pra simplificação futura
 * (o alvo deixa de ser decisório e vira reforço visual), não uma prova.
 */
function computeRedundancy(snapshots, targetBrainKey, explainerBrainKeys) {
  let sampleSize = 0;
  let agree = 0;
  for (const s of snapshots) {
    const consensus = unanimousDirection(explainerBrainKeys.map((key) => s.brains[key].direction));
    const targetDirection = s.brains[targetBrainKey].direction;
    if (!consensus || !targetDirection) continue;
    sampleSize++;
    if (targetDirection === consensus) agree++;
  }
  return { targetBrainKey, explainerBrainKeys, sampleSize, agreementRatePct: sampleSize > 0 ? Math.round((agree / sampleSize) * 100) : 0 };
}

const GRADED_OUTCOMES = ["SUCCESS", "FAIL", "INCONCLUSIVE"];
// Hipóteses/heurísticas documentadas, não estatística formal -- servem
// pra dar um veredito objetivo e discutível, não a última palavra.
const MIN_REGIME_SAMPLE = 20;
const STABILITY_BUCKETS = 4;
const STABILITY_TOLERANCE_PP = 15;

/**
 * 3 critérios objetivos pedidos pelo usuário pra saber quando o Decision
 * Brain pode nascer. "Diversidade de regime" usa o que já está disponível
 * por snapshot -- o próprio context.state (FUSED_BULLISH/BEARISH/NEUTRAL
 * já é literalmente alta/baixa/lateralização) -- em vez de trazer
 * lib/volatilityRegime.js pra dentro do replay agora (deferido,
 * documentado). "Por ativo/timeframe" não é aplicável hoje -- a
 * plataforma roda um símbolo/intervalo só. `ready=true` não decide nada
 * sozinho, é só o número que autoriza o próximo passo manualmente.
 */
function evaluateDecisionBrainReadiness(snapshots, { minSnapshots }) {
  const graded = snapshots.filter((s) => GRADED_OUTCOMES.includes(s.outcome));

  const sampleSize = { pass: graded.length >= minSnapshots, count: graded.length, required: minSnapshots };

  const regimeCounts = { FUSED_BULLISH: 0, FUSED_BEARISH: 0, FUSED_NEUTRAL: 0 };
  for (const s of graded) {
    const state = s.brains.context.state;
    if (state in regimeCounts) regimeCounts[state]++;
  }
  const regimeDiversity = {
    pass: Object.values(regimeCounts).every((c) => c >= MIN_REGIME_SAMPLE),
    counts: regimeCounts,
    minRequiredPerRegime: MIN_REGIME_SAMPLE,
  };

  const bucketSize = Math.ceil(graded.length / STABILITY_BUCKETS);
  const bucketRates = [];
  for (let b = 0; b < STABILITY_BUCKETS; b++) {
    const bucket = graded.slice(b * bucketSize, (b + 1) * bucketSize);
    if (bucket.length === 0) continue;
    const successCount = bucket.filter((s) => s.outcome === "SUCCESS").length;
    bucketRates.push(Math.round((successCount / bucket.length) * 100));
  }
  const spreadPct = bucketRates.length > 0 ? Math.max(...bucketRates) - Math.min(...bucketRates) : null;
  const stability = { pass: bucketRates.length > 0 && spreadPct <= STABILITY_TOLERANCE_PP, bucketRates, spreadPct, tolerancePp: STABILITY_TOLERANCE_PP };

  return {
    ready: sampleSize.pass && regimeDiversity.pass && stability.pass,
    checks: { sampleSize, regimeDiversity, stability },
  };
}

/**
 * Forma compacta de evaluateDecisionBrainReadiness() pra persistência de
 * histórico -- só os campos escalares que importam pra acompanhar
 * tendência ao longo do tempo, nunca `bucketRates`/`regimeCounts` inteiros.
 * `confidence` não existe como métrica própria ainda (não inventado aqui:
 * Fase 1 é só persistência do que já é calculado por evaluateDecisionBrainReadiness).
 */
function summarizeDecisionBrainReadiness(decisionBrainReadiness) {
  if (!decisionBrainReadiness) return null;
  const { ready, checks } = decisionBrainReadiness;
  return {
    ready,
    sample: { pass: checks.sampleSize.pass, count: checks.sampleSize.count, required: checks.sampleSize.required },
    regimeDiversity: { pass: checks.regimeDiversity.pass, counts: checks.regimeDiversity.counts },
    stability: { pass: checks.stability.pass, spreadPct: checks.stability.spreadPct },
  };
}

module.exports = { computeBrainAccuracy, computeMarginalContribution, computeRedundancy, evaluateDecisionBrainReadiness, summarizeDecisionBrainReadiness, unanimousDirection };

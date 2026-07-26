// Liquidez baseada em preço -- Equal Highs/Lows (zonas) e Liquidity Sweep
// (caçada de stop). Reaproveita os mesmos swings de
// lib/marketStructure/swingDetector.js (mesma fundação que o Structure
// Brain usa), não recalcula nada do zero.
//
// Distinção importante com lib/marketStructure/structureEvidence.js: BOS/
// CHOCH só olham o CLOSE rompendo um nível (decisão de fechamento).
// Sweep aqui olha o PAVIO (high/low) ultrapassando o nível enquanto o
// close volta pra dentro -- é um evento diferente (rejeição/stop-hunt),
// não uma variação do mesmo cálculo.
//
// Próxima evolução prevista (documentado, não implementada nesta versão):
// FVG (imbalance) e Order Blocks são a fase seguinte da sequência, usando
// o contexto de estrutura+liquidez já disponível; "Trapped Traders"
// confirmado por OI/volume real (não só o proxy de preço daqui) e "Stop
// Clusters" (precisa de order book/Level 2, não coletado ainda) dependem
// do Context Fusion / de um coletor que não existe.

// Agrupa swings do mesmo tipo cujo preço fica dentro de `tolerancePct` do
// PRIMEIRO membro do cluster (âncora fixa, não média móvel -- evita
// "encadear" swings distantes através de uma sequência de vizinhos
// próximos). Só vira zona de verdade com >=2 toques; um swing sozinho não
// é "equal" a nada.
function clusterEqualLevels(swings, tolerancePct) {
  if (!swings || swings.length === 0) return [];
  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const clusters = [];
  let current = null;
  for (const s of sorted) {
    if (current && (Math.abs(s.price - current.members[0].price) / current.members[0].price) * 100 <= tolerancePct) {
      current.members.push(s);
    } else {
      current = { members: [s] };
      clusters.push(current);
    }
  }
  return clusters
    .filter((c) => c.members.length >= 2)
    .map((c) => ({
      level: c.members.reduce((sum, m) => sum + m.price, 0) / c.members.length,
      touchCount: c.members.length,
      swingIndexes: c.members.map((m) => m.index),
    }));
}

// Pra cada swing confirmado, procura o primeiro candle depois dele cujo
// pavio ultrapassa o nível mas o close volta pro lado de dentro. Para de
// procurar naquele nível se o close eventualmente romper de vez (BOS de
// verdade, não é mais candidato a sweep) ou se um sweep já foi encontrado
// (o nível "gastou" a liquidez).
function detectSweeps(candles, swingHighs, swingLows, { lookback }) {
  const sweeps = [];

  for (const swing of swingHighs) {
    const confirmIndex = swing.index + lookback;
    for (let i = confirmIndex + 1; i < candles.length; i++) {
      const high = parseFloat(candles[i][2]);
      const close = parseFloat(candles[i][4]);
      if (close > swing.price) break;
      if (high > swing.price && close < swing.price) {
        sweeps.push({ type: "SWEEP_HIGH", index: i, level: swing.price, sweptSwing: swing });
        break;
      }
    }
  }

  for (const swing of swingLows) {
    const confirmIndex = swing.index + lookback;
    for (let i = confirmIndex + 1; i < candles.length; i++) {
      const low = parseFloat(candles[i][3]);
      const close = parseFloat(candles[i][4]);
      if (close < swing.price) break;
      if (low < swing.price && close > swing.price) {
        sweeps.push({ type: "SWEEP_LOW", index: i, level: swing.price, sweptSwing: swing });
        break;
      }
    }
  }

  return sweeps.sort((a, b) => a.index - b.index);
}

// Proxy de "trapped traders" via preço -- NÃO confirmado por OI/volume
// real (isso exigiria ler o Market Brain, papel do futuro Context
// Fusion). Reversão "confirmada" = o close, dentro de `lookaheadCandles`
// depois do sweep, vai além do high/low do próprio candle de sweep (não
// só voltar pra dentro do nível, que já é a definição de sweep -- precisa
// continuar na direção da rejeição). `null` quando ainda não deu tempo de
// julgar (candles insuficientes à frente), nunca fabricado como
// true/false sem base.
function annotateReversalConfirmation(sweeps, candles, lookaheadCandles) {
  return sweeps.map((sweep) => {
    const sweepLow = parseFloat(candles[sweep.index][3]);
    const sweepHigh = parseFloat(candles[sweep.index][2]);
    const endIndex = Math.min(candles.length - 1, sweep.index + lookaheadCandles);
    if (endIndex <= sweep.index) return { ...sweep, reversalConfirmed: null };

    let reversalConfirmed = false;
    for (let i = sweep.index + 1; i <= endIndex; i++) {
      const close = parseFloat(candles[i][4]);
      if (sweep.type === "SWEEP_HIGH" && close < sweepLow) {
        reversalConfirmed = true;
        break;
      }
      if (sweep.type === "SWEEP_LOW" && close > sweepHigh) {
        reversalConfirmed = true;
        break;
      }
    }
    return { ...sweep, reversalConfirmed };
  });
}

module.exports = { clusterEqualLevels, detectSweeps, annotateReversalConfirmation };

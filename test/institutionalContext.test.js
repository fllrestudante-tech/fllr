const test = require("node:test");
const assert = require("node:assert/strict");
const { rangesOverlap, findConfluenceZones, synthesizeInstitutionalContext } = require("../lib/brains/institutionalContext");

// Fixtures verificadas rodando o código real (script descartável) antes
// de fixar os asserts -- mesma disciplina de sempre. Institucional Context
// é puro sobre os 3 Brains já computados, não precisa de candles/market.db
// pra testar, diferente dos Brains anteriores.
function brainResult(overrides = {}) {
  return { confidence: 80, metadata: { sourceDataTime: 123456 }, ...overrides };
}

test("rangesOverlap: sobrepõe, não sobrepõe e toca exatamente na borda (inclusivo)", () => {
  assert.equal(rangesOverlap({ low: 10, high: 12 }, { low: 11, high: 13 }), true);
  assert.equal(rangesOverlap({ low: 10, high: 12 }, { low: 13, high: 15 }), false);
  assert.equal(rangesOverlap({ low: 10, high: 12 }, { low: 12, high: 14 }), true);
});

test("findConfluenceZones: gap+block mesma direção sobrepostos, sem liquidez na interseção -- 2 fontes", () => {
  const liquidity = brainResult({ zones: { above: [{ level: 50, touchCount: 1 }], below: [] } });
  const fvg = brainResult({ activeGaps: [{ direction: "bullish", low: 10, high: 12 }] });
  const orderBlock = brainResult({ activeBlocks: [{ direction: "bullish", low: 11, high: 13, stage: "ACTIVE" }] });
  assert.deepEqual(findConfluenceZones({ liquidity, fvg, orderBlock }), [
    { low: 11, high: 12, direction: "bullish", blockStage: "ACTIVE", sources: ["fvg", "order_block"] },
  ]);
});

test("findConfluenceZones: nível de liquidez dentro da interseção -- 3 fontes", () => {
  const liquidity = brainResult({ zones: { above: [{ level: 11.5, touchCount: 2 }], below: [] } });
  const fvg = brainResult({ activeGaps: [{ direction: "bullish", low: 10, high: 12 }] });
  const orderBlock = brainResult({ activeBlocks: [{ direction: "bullish", low: 11, high: 13, stage: "ACTIVE" }] });
  assert.deepEqual(findConfluenceZones({ liquidity, fvg, orderBlock }), [
    { low: 11, high: 12, direction: "bullish", blockStage: "ACTIVE", sources: ["fvg", "order_block", "liquidity"] },
  ]);
});

test("findConfluenceZones: direções diferentes -- nenhuma zona (liquidez não decide direção, só reforça)", () => {
  const liquidity = brainResult({ zones: { above: [], below: [] } });
  const fvg = brainResult({ activeGaps: [{ direction: "bullish", low: 10, high: 12 }] });
  const orderBlock = brainResult({ activeBlocks: [{ direction: "bearish", low: 11, high: 13, stage: "ACTIVE" }] });
  assert.deepEqual(findConfluenceZones({ liquidity, fvg, orderBlock }), []);
});

test("findConfluenceZones: gap e block sem sobreposição de preço -- nenhuma zona", () => {
  const liquidity = brainResult({ zones: { above: [], below: [] } });
  const fvg = brainResult({ activeGaps: [{ direction: "bullish", low: 10, high: 12 }] });
  const orderBlock = brainResult({ activeBlocks: [{ direction: "bullish", low: 20, high: 22, stage: "ACTIVE" }] });
  assert.deepEqual(findConfluenceZones({ liquidity, fvg, orderBlock }), []);
});

test("synthesizeInstitutionalContext: nenhum gap/block ativo -- NO_CONFLUENCE, score 0", () => {
  const empty = brainResult({ activeGaps: [], activeBlocks: [] });
  const liquidity = brainResult({ zones: { above: [], below: [] } });
  const result = synthesizeInstitutionalContext({ liquidity, fvg: empty, orderBlock: empty });
  assert.equal(result.state, "NO_CONFLUENCE");
  assert.equal(result.score, 0);
  assert.deepEqual(result.reasons, ["Nenhuma confluência institucional (Liquidity+FVG+Order Block) encontrada no momento"]);
  assert.deepEqual(result.zones, []);
  assert.equal(result.dominantZone, null);
});

test("synthesizeInstitutionalContext: gap+block sobrepostos sem liquidez -- MODERATE_CONFLUENCE, score 60", () => {
  const liquidity = brainResult({ zones: { above: [{ level: 50, touchCount: 1 }], below: [] } });
  const fvg = brainResult({ activeGaps: [{ direction: "bullish", low: 10, high: 12 }] });
  const orderBlock = brainResult({ activeBlocks: [{ direction: "bullish", low: 11, high: 13, stage: "ACTIVE" }] });
  const result = synthesizeInstitutionalContext({ liquidity, fvg, orderBlock });
  assert.equal(result.state, "MODERATE_CONFLUENCE");
  assert.equal(result.score, 60);
  assert.ok(result.reasons[0].includes("FVG+Order Block)"));
});

test("synthesizeInstitutionalContext: gap+block+liquidez sobrepostos -- STRONG_CONFLUENCE, score 100, evidence/dependsOn/missingEvidence", () => {
  const liquidity = brainResult({ zones: { above: [{ level: 11.5, touchCount: 2 }], below: [] } });
  const fvg = brainResult({ activeGaps: [{ direction: "bullish", low: 10, high: 12 }] });
  const orderBlock = brainResult({ activeBlocks: [{ direction: "bullish", low: 11, high: 13, stage: "ACTIVE" }] });
  const result = synthesizeInstitutionalContext({ liquidity, fvg, orderBlock });
  assert.equal(result.state, "STRONG_CONFLUENCE");
  assert.equal(result.score, 100);
  assert.ok(result.reasons[0].includes("FVG+Order Block+Liquidity"));
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].type, "CONFLUENCE_ZONE");
  assert.equal(result.evidence[0].weight, 3);
  assert.deepEqual(result.metadata.dependsOn, ["liquidity_brain", "fvg_brain", "order_block_brain"]);
  assert.deepEqual(result.missingEvidence, ["Replay Engine (validação estatística de confluência)"]);
});

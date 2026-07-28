const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../../config");
const resolver = require("../../lib/knowledgeBase/resolver");

test("resolveStructureContext: v1 é pass-through de config.structure.lookback", () => {
  const envelope = resolver.resolveStructureContext(null, "SOLUSDT");
  assert.deepEqual(envelope.context, { lookback: config.structure.lookback });
  assert.equal(envelope.source, "config-default");
  assert.equal(envelope.knowledgeVersion, 1);
  assert.equal(envelope.confidence, 100);
  assert.ok(envelope.generatedAt);
});

test("resolveLiquidityContext: pass-through de lookback/equalTolerancePct/sweepReversalLookahead", () => {
  const { context } = resolver.resolveLiquidityContext(null, "SOLUSDT");
  assert.deepEqual(context, {
    lookback: config.structure.lookback,
    equalTolerancePct: config.structure.equalTolerancePct,
    sweepReversalLookahead: config.structure.sweepReversalLookahead,
  });
});

test("resolveFvgContext: pass-through de exhaustionLookback", () => {
  const { context } = resolver.resolveFvgContext(null, "SOLUSDT");
  assert.deepEqual(context, { exhaustionLookback: config.structure.exhaustionLookback });
});

test("resolveOrderBlockContext: pass-through de confirmAge/mitigationThreshold/exhaustionLookback", () => {
  const { context } = resolver.resolveOrderBlockContext(null, "SOLUSDT");
  assert.deepEqual(context, {
    confirmAge: config.structure.confirmAge,
    mitigationThreshold: config.structure.mitigationThreshold,
    exhaustionLookback: config.structure.exhaustionLookback,
  });
});

test("resolver: resultado independe do symbol (v1 ainda não é adaptativo por ativo)", () => {
  const a = resolver.resolveStructureContext(null, "SOLUSDT");
  const b = resolver.resolveStructureContext(null, "BTCUSDT");
  assert.deepEqual(a.context, b.context);
});

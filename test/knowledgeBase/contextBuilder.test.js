const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../../config");

// contextBuilder importa signals no load -- limpamos o cache dos dois pra
// cada teste ver um registry de sinais isolado (mesmo motivo de
// test/knowledgeBase/signals.test.js).
function freshModules() {
  delete require.cache[require.resolve("../../lib/knowledgeBase/signals")];
  delete require.cache[require.resolve("../../lib/knowledgeBase/contextBuilder")];
  return {
    signals: require("../../lib/knowledgeBase/signals"),
    contextBuilder: require("../../lib/knowledgeBase/contextBuilder"),
  };
}

test("buildStructureContext: sem sinais registrados, é idêntico ao Resolver sozinho", () => {
  const { contextBuilder } = freshModules();
  const envelope = contextBuilder.buildStructureContext(null, "SOLUSDT");
  assert.deepEqual(envelope.context, { lookback: config.structure.lookback });
});

test("buildLiquidityContext/buildFvgContext/buildOrderBlockContext: chamam o Resolver certo", () => {
  const { contextBuilder } = freshModules();
  assert.deepEqual(contextBuilder.buildLiquidityContext(null, "SOLUSDT").context, {
    lookback: config.structure.lookback,
    equalTolerancePct: config.structure.equalTolerancePct,
    sweepReversalLookahead: config.structure.sweepReversalLookahead,
  });
  assert.deepEqual(contextBuilder.buildFvgContext(null, "SOLUSDT").context, { exhaustionLookback: config.structure.exhaustionLookback });
  assert.deepEqual(contextBuilder.buildOrderBlockContext(null, "SOLUSDT").context, {
    confirmAge: config.structure.confirmAge,
    mitigationThreshold: config.structure.mitigationThreshold,
    exhaustionLookback: config.structure.exhaustionLookback,
  });
});

test("buildStructureContext: um Signal registrado é mesclado no contexto final", () => {
  const { signals, contextBuilder } = freshModules();
  signals.registerSignal("volatilityBump", () => ({ lookback: 999 }));

  const envelope = contextBuilder.buildStructureContext(null, "SOLUSDT");
  assert.equal(envelope.context.lookback, 999, "Signal deveria sobrescrever o valor do Resolver no merge");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFeatureVector } = require("../../lib/narrativeEngine/featureVector");

test("buildFeatureVector: achata ticker/direction/timeframe/structure/indicators num único objeto de booleanos", () => {
  const vector = buildFeatureVector({
    ticker: "BTC",
    pair: "BTCUSDT",
    direction: "LONG",
    timeframe: "4H",
    structure: { support: true, resistance: false },
    indicators: { funding: true, etf: false },
    hasLink: true,
    priceMentioned: null,
  });

  assert.equal(vector.hasTicker, true);
  assert.equal(vector.hasPair, true);
  assert.equal(vector.hasDirection, true);
  assert.equal(vector.hasTimeframe, true);
  assert.equal(vector.hasLink, true);
  assert.equal(vector.hasPriceMentioned, false);
  assert.equal(vector.hasSupport, true);
  assert.equal(vector.hasResistance, false);
  assert.equal(vector.mentionsFunding, true);
  assert.equal(vector.mentionsEtf, false);
});

test("buildFeatureVector: entradas vazias/ausentes não quebram", () => {
  const vector = buildFeatureVector({});
  assert.equal(vector.hasTicker, false);
  assert.equal(vector.hasLink, false);
});

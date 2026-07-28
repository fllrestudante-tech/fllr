const test = require("node:test");
const assert = require("node:assert/strict");
const statMath = require("../../lib/knowledgeBase/statMath");

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `esperado ~${expected}, recebido ${actual}`);
}

const SEQUENCE_1_TO_10 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const WITH_OUTLIER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
const SKEWED = [1, 2, 3, 4, 10];

test("mean/median/stddev: sequência 1..10 (valores calculados à mão)", () => {
  closeTo(statMath.mean(SEQUENCE_1_TO_10), 5.5);
  closeTo(statMath.median(SEQUENCE_1_TO_10), 5.5);
  closeTo(statMath.stddev(SEQUENCE_1_TO_10), Math.sqrt(8.25));
});

test("percentile: p10/p25/p75/p90 de 1..10, interpolação linear", () => {
  const sorted = statMath.sortAsc(SEQUENCE_1_TO_10);
  closeTo(statMath.percentile(sorted, 10), 1.9);
  closeTo(statMath.percentile(sorted, 25), 3.25);
  closeTo(statMath.percentile(sorted, 75), 7.75);
  closeTo(statMath.percentile(sorted, 90), 9.1);
});

test("mad/iqr: 1..10", () => {
  closeTo(statMath.mad(SEQUENCE_1_TO_10), 2.5);
  closeTo(statMath.iqr(SEQUENCE_1_TO_10), 4.5);
});

test("trimmedMean/winsorizedMean: outlier isolado (100) não deve puxar o resultado como a média puxa", () => {
  const rawMean = statMath.mean(WITH_OUTLIER);
  closeTo(rawMean, 14.5);
  closeTo(statMath.trimmedMean(WITH_OUTLIER, 0.2), 5.5);
  closeTo(statMath.winsorizedMean(WITH_OUTLIER, 0.2), 5.5);
});

test("skewness/kurtosis: amostra assimétrica [1,2,3,4,10] (calculado à mão)", () => {
  closeTo(statMath.skewness(SKEWED), 36 / Math.pow(10, 1.5));
  closeTo(statMath.kurtosis(SKEWED), 278.8 / 100 - 3);
});

test("todas as primitivas: array vazio devolve null, não erro nem NaN", () => {
  assert.equal(statMath.mean([]), null);
  assert.equal(statMath.median([]), null);
  assert.equal(statMath.stddev([]), null);
  assert.equal(statMath.percentile([], 50), null);
  assert.equal(statMath.mad([]), null);
  assert.equal(statMath.iqr([]), null);
  assert.equal(statMath.trimmedMean([]), null);
  assert.equal(statMath.winsorizedMean([]), null);
  assert.equal(statMath.skewness([1, 2]), null, "skewness exige pelo menos 3 pontos");
  assert.equal(statMath.kurtosis([1, 2, 3]), null, "kurtosis exige pelo menos 4 pontos");
});

test("stddev/skewness/kurtosis: amostra constante (stddev=0) não gera Infinity/NaN", () => {
  const constant = [5, 5, 5, 5, 5];
  assert.equal(statMath.stddev(constant), 0);
  assert.equal(statMath.skewness(constant), null);
  assert.equal(statMath.kurtosis(constant), null);
});

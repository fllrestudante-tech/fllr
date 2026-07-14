const test = require("node:test");
const assert = require("node:assert/strict");
const { computeMetrics, isCandidateBetter } = require("../lib/backtest");

test("computeMetrics: array vazio retorna tudo zerado", () => {
  const m = computeMetrics([]);
  assert.equal(m.totalTrades, 0);
  assert.equal(m.winRate, 0);
  assert.equal(m.profitFactor, 0);
  assert.equal(m.expectancy, 0);
  assert.equal(m.sharpe, 0);
});

test("computeMetrics: winRate, profitFactor e expectância batem com o cálculo manual", () => {
  const m = computeMetrics([0.02, -0.01, 0.02, -0.01, 0.02]);
  assert.equal(m.totalTrades, 5);
  assert.equal(m.winRate, 0.6); // 3 wins em 5
  assert.ok(Math.abs(m.profitFactor - 3) < 1e-9); // grossGain 0.06 / grossLoss 0.02
  assert.ok(Math.abs(m.expectancy - 0.008) < 1e-9); // média de (0.02,0.02,0.02,-0.01,-0.01)
});

test("computeMetrics: sem perdas, profitFactor cai pro grossGain (evita Infinity)", () => {
  const m = computeMetrics([0.02, 0.02, 0.02]);
  assert.equal(m.winRate, 1);
  assert.ok(Math.abs(m.profitFactor - 0.06) < 1e-9);
  assert.equal(m.sharpe, 0); // stdev zero (todos os trades iguais) -> sharpe definido como 0
});

test("computeMetrics: retornos simétricos em torno de zero dão sharpe zero", () => {
  const m = computeMetrics([0.01, -0.01, 0.01, -0.01]);
  assert.equal(m.expectancy, 0);
  assert.equal(m.sharpe, 0);
});

test("isCandidateBetter: rejeita amostra pequena mesmo com expectância melhor", () => {
  const baseline = { totalTrades: 50, expectancy: 0.001, maxDrawdown: 0.05 };
  const candidate = { totalTrades: 4, expectancy: 0.01, maxDrawdown: 0.02 };
  const decision = isCandidateBetter(baseline, candidate);
  assert.equal(decision.promote, false);
  assert.match(decision.reason, /amostra insuficiente/);
});

test("isCandidateBetter: aceita candidato quando baseline não tem histórico", () => {
  const baseline = { totalTrades: 0, expectancy: 0, maxDrawdown: 0 };
  const candidate = { totalTrades: 10, expectancy: 0.001, maxDrawdown: 0.1 };
  const decision = isCandidateBetter(baseline, candidate);
  assert.equal(decision.promote, true);
});

test("isCandidateBetter: rejeita quando expectância não melhora", () => {
  const baseline = { totalTrades: 30, expectancy: 0.01, maxDrawdown: 0.05 };
  const candidate = { totalTrades: 30, expectancy: 0.005, maxDrawdown: 0.02 };
  const decision = isCandidateBetter(baseline, candidate);
  assert.equal(decision.promote, false);
  assert.match(decision.reason, /expectância não melhorou/);
});

test("isCandidateBetter: rejeita quando drawdown piora além da tolerância de 10%", () => {
  const baseline = { totalTrades: 30, expectancy: 0.005, maxDrawdown: 0.05 };
  const candidate = { totalTrades: 30, expectancy: 0.01, maxDrawdown: 0.06 }; // 0.06 > 0.05*1.1
  const decision = isCandidateBetter(baseline, candidate);
  assert.equal(decision.promote, false);
  assert.match(decision.reason, /drawdown piorou/);
});

test("isCandidateBetter: promove quando expectância melhora e drawdown está dentro da tolerância", () => {
  const baseline = { totalTrades: 30, expectancy: 0.005, maxDrawdown: 0.05 };
  const candidate = { totalTrades: 30, expectancy: 0.01, maxDrawdown: 0.054 }; // dentro de 0.055
  const decision = isCandidateBetter(baseline, candidate);
  assert.equal(decision.promote, true);
});

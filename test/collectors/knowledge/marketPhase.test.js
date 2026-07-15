const test = require("node:test");
const assert = require("node:assert/strict");
const { getMarketPhase } = require("../../../lib/collectors/knowledge/marketPhase");

const HOUR_MS = 60 * 60 * 1000;

function fomcLikeEvent(eventTime) {
  return { eventTime, impactWindowBeforeMs: 24 * HOUR_MS, impactWindowAfterMs: 48 * HOUR_MS };
}

test("getMarketPhase: dentro da janela antes do evento é pre-event", () => {
  const eventTime = 100 * HOUR_MS;
  const now = eventTime - 10 * HOUR_MS;
  assert.equal(getMarketPhase(fomcLikeEvent(eventTime), now), "pre-event");
});

test("getMarketPhase: perto do horário exato é live-event", () => {
  const eventTime = 100 * HOUR_MS;
  assert.equal(getMarketPhase(fomcLikeEvent(eventTime), eventTime), "live-event");
  assert.equal(getMarketPhase(fomcLikeEvent(eventTime), eventTime + 10 * 60 * 1000), "live-event");
});

test("getMarketPhase: dentro da janela depois do evento é post-event", () => {
  const eventTime = 100 * HOUR_MS;
  const now = eventTime + 30 * HOUR_MS;
  assert.equal(getMarketPhase(fomcLikeEvent(eventTime), now), "post-event");
});

test("getMarketPhase: antes da janela de impacto é outside-window", () => {
  const eventTime = 100 * HOUR_MS;
  const now = eventTime - 30 * HOUR_MS; // janela antes é só 24h
  assert.equal(getMarketPhase(fomcLikeEvent(eventTime), now), "outside-window");
});

test("getMarketPhase: depois da janela de impacto é outside-window", () => {
  const eventTime = 100 * HOUR_MS;
  const now = eventTime + 60 * HOUR_MS; // janela depois é só 48h
  assert.equal(getMarketPhase(fomcLikeEvent(eventTime), now), "outside-window");
});

test("getMarketPhase: sem janelas definidas (event_time exato só)", () => {
  const eventTime = 100 * HOUR_MS;
  const event = { eventTime };
  assert.equal(getMarketPhase(event, eventTime), "live-event");
  assert.equal(getMarketPhase(event, eventTime - HOUR_MS), "outside-window");
});

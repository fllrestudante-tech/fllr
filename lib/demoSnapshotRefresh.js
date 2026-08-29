// Produtor operacional do snapshot confiável do perfil demo (item 3 da
// Rodada 4) -- orquestra as leituras privadas Demo autorizadas (wallet,
// posições, ordens abertas) + a metadata pública do instrumento, e só
// então grava o snapshot atômico (lib/demoAccountSnapshot.js).
//
// Fluxo exigido: leituras privadas Demo -> metadata pública do
// instrumento -> montar e gravar o snapshot -> só DEPOIS a estratégia
// pode propor uma ordem (index.js::openPosition chama isto ANTES de
// bybit.placeOrder, nunca depois). Ações defensivas (fechar/reduzir/
// cancelar) NUNCA passam por aqui -- usam a melhor informação disponível
// e não dependem de snapshot fresco (ver lib/demoOrderGate.js).
//
// Se QUALQUER leitura falhar ou vier incompleta, este módulo LANÇA e
// NUNCA grava -- nunca "tenta de novo com o que tem" nem reaproveita
// silenciosamente um snapshot velho pra autorizar aumento de exposição.
// O snapshot anterior (se houver) permanece intocado no disco e
// naturalmente perde validade pela idade
// (lib/demoAccountSnapshot.js::DEFAULT_MAX_SNAPSHOT_AGE_MS) -- é
// exatamente esse envelhecimento natural, nunca uma reescrita silenciosa,
// que faz lib/demoOrderGate.js bloquear a próxima tentativa de aumento
// de exposição enquanto o refresh não for bem-sucedido de novo.
const bybit = require("./bybit");
const { captureDemoAccountSnapshot } = require("./demoAccountSnapshot");

class DemoSnapshotRefreshFailedError extends Error {
  constructor(cause) {
    super(`Falha ao atualizar o snapshot da conta Demo -- nenhuma ordem será proposta neste ciclo (${cause.message}).`);
    this.name = this.constructor.name;
    this.code = "DEMO_SNAPSHOT_REFRESH_FAILED";
    this.cause = cause;
  }
}

async function refreshDemoAccountSnapshot({ env = process.env, symbol, now = Date.now() } = {}) {
  try {
    return await captureDemoAccountSnapshot({
      env,
      symbol,
      now,
      getWalletBalance: bybit.getWalletBalance,
      getPositions: bybit.getPositions,
      getOpenOrders: bybit.getOpenOrders,
      getInstrumentInfo: bybit.getInstrumentInfo,
    });
  } catch (err) {
    throw new DemoSnapshotRefreshFailedError(err);
  }
}

module.exports = { refreshDemoAccountSnapshot, DemoSnapshotRefreshFailedError };

// Roda o Narrative Engine v0 (lib/narrativeEngine/classify.js) sob demanda
// contra toda mensagem em telegram_messages_raw ainda não classificada por
// esta versão -- reprocessável a qualquer momento (idempotente pra mesma
// versão; uma versão nova do classificador sempre soma linha nova em vez de
// sobrescrever). Rodar via `npm run classify:telegram`.
const { openDb } = require("../lib/infra/db");
const { getUnclassifiedRawMessages, insertSignal } = require("../lib/collectors/telegramSignalsStore");
const { classify, CLASSIFIER_NAME, CLASSIFIER_VERSION } = require("../lib/narrativeEngine/classify");

function run() {
  const db = openDb();
  const pending = getUnclassifiedRawMessages(db, { classifierName: CLASSIFIER_NAME, classifierVersion: CLASSIFIER_VERSION, limit: 5000 });

  console.log(`Narrative Engine v${CLASSIFIER_VERSION}: ${pending.length} mensagem(ns) pendente(s) de classificação.`);
  if (pending.length === 0) return;

  const byMessageType = {};
  let relevant = 0;
  let calls = 0;

  for (const raw of pending) {
    const signal = classify(raw.text);
    insertSignal(db, raw.id, signal);
    byMessageType[signal.messageType] = (byMessageType[signal.messageType] || 0) + 1;
    if (signal.isRelevant) relevant += 1;
    if (signal.isCall) calls += 1;
  }

  console.log(`Classificadas: ${pending.length} | relevantes: ${relevant} | calls (ticker+direção): ${calls}`);
  console.log("Por tipo de mensagem:", JSON.stringify(byMessageType, null, 2));
}

if (require.main === module) {
  run();
}

module.exports = { run };

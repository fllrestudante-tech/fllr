const { EventEmitter } = require("events");
const crypto = require("crypto");

/**
 * Event bus local e leve (EventEmitter nativo) -- desacopla coletores de
 * consumidores sem precisar de fila distribuída. payload deve ser mínimo
 * (uuids/refs, não o dado completo) -- quem consome relê do banco, o banco
 * continua sendo a única fonte de verdade, o evento é só a notificação.
 *
 * persist (opcional) é injetado por quem monta o event bus (composition
 * root) -- normalmente grava o evento em events_log. O eventBus não conhece
 * o banco diretamente.
 */
function createEventBus({ persist } = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  function emit(eventName, payload = {}) {
    const event = {
      uuid: crypto.randomUUID(),
      eventName,
      payload,
      occurredAt: new Date().toISOString(),
    };
    if (persist) persist(event);
    emitter.emit(eventName, event);
    return event;
  }

  function on(eventName, handler) {
    emitter.on(eventName, handler);
  }

  return { emit, on };
}

module.exports = { createEventBus };

// Deduplicação de alertas: mesma chave (ex: nome do processo/domínio) dentro
// de uma janela (default 15min) vira UM alerta imediato na primeira
// ocorrência + um contador que só é enviado como resumo quando a janela
// fecha (se houve mais de uma ocorrência) -- evita a "tempestade de
// mensagens" de um coletor entrando em crash-loop.
function createAlertAggregator({ windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const buckets = new Map();

  /**
   * Primeira ocorrência de uma chave (ou primeira depois que a janela
   * anterior dela já tinha fechado) -> "send", dispara o alerta na hora.
   * Ocorrências seguintes dentro da mesma janela -> "suppress", só conta.
   */
  function record(key, message, severity) {
    const t = now();
    const existing = buckets.get(key);
    if (existing && t - existing.firstAt < windowMs) {
      existing.count++;
      existing.lastAt = t;
      return { action: "suppress", count: existing.count };
    }
    buckets.set(key, { count: 1, firstAt: t, lastAt: t, message, severity });
    return { action: "send", count: 1 };
  }

  /**
   * Chamado periodicamente (não em cada record). Buckets cuja janela já
   * fechou saem do mapa; só os que tiveram mais de 1 ocorrência (ou seja,
   * suprimiram pelo menos uma repetição) viram um resumo -- um bucket com
   * count=1 não gera alerta extra, o único alerta dele já foi o "send"
   * original.
   */
  function flushExpired() {
    const t = now();
    const expired = [];
    for (const [key, bucket] of buckets.entries()) {
      if (t - bucket.firstAt >= windowMs) {
        if (bucket.count > 1) {
          expired.push({ key, message: bucket.message, severity: bucket.severity, count: bucket.count, firstAt: bucket.firstAt, lastAt: bucket.lastAt });
        }
        buckets.delete(key);
      }
    }
    return expired;
  }

  return { record, flushExpired };
}

module.exports = { createAlertAggregator };

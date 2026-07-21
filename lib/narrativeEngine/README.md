# Narrative Engine

Transforma texto bruto (hoje: `telegram_messages_raw.text`) em sinais estruturados gravados em `telegram_signals`, sem IA -- v0 é 100% regex/regras determinísticas.

## Por que módulos separados

Cada `extractXxx()` recebe texto (e, no caso de `extractMessageType`/`extractSignalType`, o resultado de outros extractors) e devolve um pedaço isolado do sinal:

- `extractTicker` -- ticker/par (ex: `UNIUSDT` -> `{ticker: "UNI", pair: "UNIUSDT"}`)
- `extractDirection` -- LONG/SHORT/null
- `extractStructure` -- dicionário de padrões gráficos (suporte, resistência, cunha ascendente, etc)
- `extractTimeframe` -- 4H/1D/1W/1M/null
- `extractIndicators` -- menções a RSI/funding/OI/ETF/FOMC/etc
- `extractSentiment` -- bullish/bearish/neutral + confiança
- `extractPriceMentioned` -- preço explícito (conservador, peso 0 na confiança ainda)
- `extractSignalType` -- padrão técnico "principal" (Breakout/Wedge/Range), derivado de `extractStructure`
- `extractMessageType` -- taxonomia da mensagem (ANALYSIS/ENTRY/UPDATE/EXIT/WARNING/MACRO/NEWS/ADVERTISEMENT/CHAT)
- `detectLanguage` -- heurística leve pt-BR/en/unknown

`classify.js` só orquestra: chama cada extractor e monta o objeto final (`features` via `featureVector.js`, `confidenceBreakdown` via `confidenceBreakdown.js`).

**O ponto central**: qualquer `extractXxx()` pode virar uma chamada de IA no futuro sem tocar nos outros nem no formato de saída. Ex: trocar `extractStructure` por uma chamada a um modelo que lê o gráfico é uma mudança isolada em um arquivo -- `classify.js` e o resto do pipeline não mudam.

## Reprocessamento

`telegram_signals` tem índice único em `(raw_message_id, classifier_name, classifier_version)`. Rodar a mesma versão de novo (`npm run classify:telegram`) é idempotente (não duplica). Uma versão nova (`CLASSIFIER_VERSION` em `classify.js`) sempre soma linha nova, preservando o histórico de cada tentativa -- o Learning Engine/Source Reliability Engine (futuros) podem comparar como cada versão classificou a mesma mensagem.

## Limitações conhecidas do v0 (documentadas, não escondidas)

- `extractTicker`: ticker "nu" (sem `$`/par) só é reconhecido se estiver em `knownTickers.js` -- lista curada pequena, não expande sozinha.
- `extractStructure`: não tem feature de "canal" (channel pattern) de propósito -- colidiria com "canal" no sentido de canal do Telegram.
- `extractPriceMentioned`: só casa preço com prefixo de moeda explícito (`$`/`US$`/`R$`); pesa 0 na confiança até ser validado contra mais dado real.
- `extractDirection`/`extractSentiment`: empate na contagem de termos retorna `null`/`neutral` -- nunca força um lado sem base.
- Calibrado contra o histórico real do canal "Velatrader Squad Oficial" (ver `test/narrativeEngine/classify.test.js`) -- outros canais/estilos de escrita podem expor gaps novos, mesma lição do `extractSignals` antigo que este módulo substitui.

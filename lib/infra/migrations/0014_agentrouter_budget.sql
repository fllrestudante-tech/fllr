-- Fase 10 / Commit 2: ledger persistente de orcamento do AgentRouter.
--
-- agentrouter_budget_ledger = estado ATUAL (leitura rapida, 1 linha por
-- reserva). agentrouter_budget_events = trilha APPEND-ONLY (1+ linhas por
-- reserva, uma por transicao -- nunca editada/apagada pelo modulo).
--
-- Nenhuma coluna aceita prompt, resposta completa, chave/token secreto ou
-- texto do Telegram -- so identificadores curtos, codigos restritos e
-- numeros. Dinheiro sempre em micros de dolar (1 USD = 1000000), INTEGER,
-- nunca REAL/FLOAT. Este commit e infraestrutura pura -- nao integra com
-- aiGateway.js, agentrouterClient.js, supervisor, .env, config.toml ou rede.

CREATE TABLE agentrouter_budget_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  idempotency_key TEXT NOT NULL UNIQUE
    CHECK(length(idempotency_key) BETWEEN 1 AND 128
      AND instr(idempotency_key, char(10)) = 0
      AND instr(idempotency_key, char(13)) = 0
      AND instr(idempotency_key, char(0)) = 0),
  correlation_id TEXT NOT NULL
    CHECK(length(correlation_id) BETWEEN 1 AND 128
      AND instr(correlation_id, char(10)) = 0
      AND instr(correlation_id, char(13)) = 0
      AND instr(correlation_id, char(0)) = 0),
  request_id TEXT
    CHECK(request_id IS NULL OR (length(request_id) BETWEEN 1 AND 128
      AND instr(request_id, char(10)) = 0
      AND instr(request_id, char(13)) = 0
      AND instr(request_id, char(0)) = 0)),

  provider TEXT NOT NULL DEFAULT 'agentrouter' CHECK(provider = 'agentrouter'),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency = 'USD'),

  model TEXT NOT NULL
    CHECK(length(model) BETWEEN 1 AND 80
      AND instr(model, char(10)) = 0 AND instr(model, char(13)) = 0 AND instr(model, char(0)) = 0),
  task_class TEXT NOT NULL
    CHECK(length(task_class) BETWEEN 1 AND 40
      AND instr(task_class, char(10)) = 0 AND instr(task_class, char(13)) = 0 AND instr(task_class, char(0)) = 0),

  status TEXT NOT NULL CHECK(status IN (
    'reserved', 'confirmed', 'released',
    'worst_case_charged', 'expired_released', 'expired_worst_case'
  )),

  -- Intencao de envio -- NAO e prova de envio. NULL = fluxo controlado nunca
  -- autorizou a chamada de rede a comecar. NOT NULL = a chamada pode ou nao
  -- ter alcancado o AgentRouter; crash/timeout depois disso assume pior caso
  -- (ver markSendIntent/releaseBudget/sweepExpiredReservations no modulo).
  send_intent_at TEXT,
  send_intent_at_ms INTEGER,

  -- Tokens de uso REAL -- so confirmBudget() grava isto. Fica NULL em
  -- reserved/pior-caso (nunca inventa uso que nao foi observado).
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
  cached_input_tokens INTEGER CHECK(cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens INTEGER CHECK(reasoning_tokens IS NULL OR reasoning_tokens >= 0),

  estimated_micros_usd INTEGER NOT NULL CHECK(estimated_micros_usd >= 0),
  reserved_micros_usd INTEGER NOT NULL CHECK(reserved_micros_usd >= 0),
  confirmed_micros_usd INTEGER CHECK(confirmed_micros_usd IS NULL OR confirmed_micros_usd >= 0),

  -- Pior caso: valor ORIGINAL (= reserved_micros_usd no momento da
  -- transicao, nunca escolhido livremente pelo chamador) e valor EFETIVO
  -- pos-reconciliacao (nulo ate reconcileDown() rodar; nunca maior que o
  -- original -- reconciliacao so reduz, nunca aumenta).
  original_worst_case_micros_usd INTEGER CHECK(original_worst_case_micros_usd IS NULL OR original_worst_case_micros_usd >= 0),
  reconciled_effective_micros_usd INTEGER CHECK(
    reconciled_effective_micros_usd IS NULL OR (
      reconciled_effective_micros_usd >= 0
      AND original_worst_case_micros_usd IS NOT NULL
      AND reconciled_effective_micros_usd <= original_worst_case_micros_usd
    )
  ),

  price_source TEXT
    CHECK(price_source IS NULL OR (length(price_source) BETWEEN 1 AND 80
      AND instr(price_source, char(10)) = 0 AND instr(price_source, char(13)) = 0 AND instr(price_source, char(0)) = 0)),
  price_source_status TEXT NOT NULL CHECK(price_source_status IN ('confirmed', 'observed', 'unknown')),
  pricing_table_version TEXT NOT NULL
    CHECK(length(pricing_table_version) BETWEEN 1 AND 40
      AND instr(pricing_table_version, char(10)) = 0 AND instr(pricing_table_version, char(13)) = 0 AND instr(pricing_table_version, char(0)) = 0),

  -- Janela orcamentaria: gravada imutavelmente na criacao pelo modulo de
  -- POLITICA (fora deste commit -- ver Commit 3). Aqui so armazena/consulta,
  -- nunca calcula meia-noite/timezone.
  budget_window_start_ms INTEGER NOT NULL,
  budget_window_end_ms INTEGER NOT NULL CHECK(budget_window_end_ms > budget_window_start_ms),
  budget_window_timezone TEXT NOT NULL
    CHECK(length(budget_window_timezone) BETWEEN 1 AND 64
      AND instr(budget_window_timezone, char(10)) = 0 AND instr(budget_window_timezone, char(13)) = 0 AND instr(budget_window_timezone, char(0)) = 0),

  panel_observed_cost_micros_usd INTEGER CHECK(panel_observed_cost_micros_usd IS NULL OR panel_observed_cost_micros_usd >= 0),

  created_at TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  expires_at TEXT,
  expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms >= created_at_ms),
  reconciled_at TEXT,
  reconciled_at_ms INTEGER CHECK(reconciled_at_ms IS NULL OR reconciled_at_ms >= created_at_ms),

  CHECK(send_intent_at_ms IS NULL OR send_intent_at_ms >= created_at_ms),

  -- Coerencia status <-> campos monetarios
  CHECK(status != 'reserved' OR (
    confirmed_micros_usd IS NULL AND original_worst_case_micros_usd IS NULL AND reconciled_effective_micros_usd IS NULL
  )),
  CHECK(status != 'confirmed' OR (
    confirmed_micros_usd IS NOT NULL AND original_worst_case_micros_usd IS NULL AND reconciled_effective_micros_usd IS NULL
  )),
  CHECK(status NOT IN ('released', 'expired_released') OR (
    confirmed_micros_usd IS NULL AND original_worst_case_micros_usd IS NULL AND reconciled_effective_micros_usd IS NULL
  )),
  CHECK(status NOT IN ('worst_case_charged', 'expired_worst_case') OR (
    original_worst_case_micros_usd IS NOT NULL AND confirmed_micros_usd IS NULL
  ))
);

CREATE INDEX idx_agentrouter_budget_ledger_status
  ON agentrouter_budget_ledger(status);

CREATE INDEX idx_agentrouter_budget_ledger_window
  ON agentrouter_budget_ledger(budget_window_start_ms, budget_window_end_ms);

CREATE INDEX idx_agentrouter_budget_ledger_correlation_id
  ON agentrouter_budget_ledger(correlation_id);

CREATE INDEX idx_agentrouter_budget_ledger_request_id
  ON agentrouter_budget_ledger(request_id);

-- Trilha append-only: uma linha por transicao. O modulo (agentRouterLedger.js)
-- nunca expoe UPDATE/DELETE publico sobre esta tabela -- so INSERT, sempre
-- na MESMA transacao BEGIN IMMEDIATE que atualiza agentrouter_budget_ledger.
CREATE TABLE agentrouter_budget_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,

  event_type TEXT NOT NULL CHECK(event_type IN (
    'RESERVED', 'SEND_INTENT_RECORDED', 'CONFIRMED', 'RELEASED',
    'WORST_CASE_CHARGED', 'EXPIRED_RELEASED', 'EXPIRED_WORST_CASE', 'RECONCILED_DOWN'
  )),
  from_status TEXT CHECK(from_status IS NULL OR from_status IN (
    'reserved', 'confirmed', 'released', 'worst_case_charged', 'expired_released', 'expired_worst_case'
  )),
  to_status TEXT NOT NULL CHECK(to_status IN (
    'reserved', 'confirmed', 'released', 'worst_case_charged', 'expired_released', 'expired_worst_case'
  )),
  effective_micros_usd INTEGER NOT NULL CHECK(effective_micros_usd >= 0),

  evidence_type TEXT CHECK(evidence_type IS NULL OR evidence_type IN (
    'agentrouter_panel', 'agentrouter_invoice', 'provider_support', 'manual_verified_no_charge'
  )),
  evidence_reference TEXT
    CHECK(evidence_reference IS NULL OR (length(evidence_reference) BETWEEN 1 AND 200
      AND instr(evidence_reference, char(10)) = 0 AND instr(evidence_reference, char(13)) = 0 AND instr(evidence_reference, char(0)) = 0)),

  actor_type TEXT NOT NULL CHECK(actor_type IN ('system', 'operator', 'reconciliation_script')),
  actor_reference TEXT
    CHECK(actor_reference IS NULL OR (length(actor_reference) BETWEEN 1 AND 80
      AND instr(actor_reference, char(10)) = 0 AND instr(actor_reference, char(13)) = 0 AND instr(actor_reference, char(0)) = 0)),

  metadata_code TEXT
    CHECK(metadata_code IS NULL OR (length(metadata_code) BETWEEN 1 AND 40
      AND instr(metadata_code, char(10)) = 0 AND instr(metadata_code, char(13)) = 0 AND instr(metadata_code, char(0)) = 0)),

  occurred_at TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),

  FOREIGN KEY (ledger_id) REFERENCES agentrouter_budget_ledger(id)
);

CREATE INDEX idx_agentrouter_budget_events_ledger_id
  ON agentrouter_budget_events(ledger_id, occurred_at_ms, id);

CREATE INDEX idx_agentrouter_budget_events_type
  ON agentrouter_budget_events(event_type);

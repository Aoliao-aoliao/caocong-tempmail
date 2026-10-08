CREATE TABLE IF NOT EXISTS business_receipts (
  public_id VARCHAR(64) NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(128) NOT NULL,
  entity_type VARCHAR(128) NOT NULL,
  entity_id VARCHAR(128),
  detail_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_receipt_entity (user_id,entity_type,entity_id),
  CONSTRAINT fk_receipt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS api_rate_overrides (
  api_key_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  rate_limit INT UNSIGNED NOT NULL,
  source_audit_id BIGINT UNSIGNED NOT NULL,
  CONSTRAINT fk_rate_override_key FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

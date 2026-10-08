CREATE TABLE IF NOT EXISTS telegram_bindings (
  user_id BIGINT UNSIGNED NOT NULL,
  bot_id VARCHAR(32) NOT NULL,
  telegram_id VARCHAR(32) NOT NULL,
  username VARCHAR(64) NOT NULL DEFAULT '',
  bound_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_telegram_identity (bot_id, telegram_id),
  CONSTRAINT fk_telegram_binding_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS telegram_binding_requests (
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bot_id VARCHAR(32) NOT NULL,
  telegram_id VARCHAR(32),
  username VARCHAR(64) NOT NULL DEFAULT '',
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_telegram_binding_token (token_hash),
  KEY idx_telegram_binding_expiry (expires_at),
  CONSTRAINT fk_telegram_request_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

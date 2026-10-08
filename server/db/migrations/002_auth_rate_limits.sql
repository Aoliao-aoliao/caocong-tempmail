CREATE TABLE IF NOT EXISTS auth_rate_limits (
  action VARCHAR(64) NOT NULL,
  key_hash CHAR(64) NOT NULL,
  window_start BIGINT UNSIGNED NOT NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (action, key_hash, window_start),
  KEY idx_auth_rate_limits_window (window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

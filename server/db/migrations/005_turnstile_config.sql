CREATE TABLE IF NOT EXISTS turnstile_config (
  id TINYINT UNSIGNED NOT NULL DEFAULT 1,
  site_key VARCHAR(255) NOT NULL,
  secret_key_ciphertext VARBINARY(255) NOT NULL,
  secret_key_kdf_salt BINARY(16) NOT NULL,
  secret_key_iv BINARY(12) NOT NULL,
  secret_key_auth_tag BINARY(16) NOT NULL,
  allowed_hostnames JSON NOT NULL,
  timeout_ms SMALLINT UNSIGNED NOT NULL DEFAULT 6000,
  updated_by_user_id BIGINT UNSIGNED NOT NULL,
  verified_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_turnstile_config_updated_by (updated_by_user_id),
  CONSTRAINT fk_turnstile_config_updated_by
    FOREIGN KEY (updated_by_user_id) REFERENCES users(id),
  CONSTRAINT chk_turnstile_config_singleton CHECK (id = 1),
  CONSTRAINT chk_turnstile_config_timeout CHECK (timeout_ms BETWEEN 10 AND 15000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

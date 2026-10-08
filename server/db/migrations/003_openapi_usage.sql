CREATE TABLE IF NOT EXISTS api_request_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  api_key_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  method VARCHAR(10) NOT NULL,
  path VARCHAR(500) NOT NULL,
  status_code SMALLINT UNSIGNED NOT NULL,
  ip_address VARCHAR(45),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_api_request_key_created (api_key_id, created_at),
  KEY idx_api_request_created (created_at),
  CONSTRAINT fk_api_request_key FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
  CONSTRAINT fk_api_request_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

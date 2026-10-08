-- Additive only. Production requires a separately reviewed migration before release.
CREATE TABLE IF NOT EXISTS nodeloc_payment_config (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  config_json JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS nodeloc_payment_orders (
  id VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  plan_code VARCHAR(64) NOT NULL,
  points BIGINT UNSIGNED NOT NULL,
  energy BIGINT UNSIGNED NOT NULL,
  config_json JSON NOT NULL,
  trade_no VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  payment_url VARCHAR(512) NULL,
  status ENUM('PENDING','PAID') NOT NULL DEFAULT 'PENDING',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  paid_at DATETIME(3) NULL,
  UNIQUE KEY uq_nodeloc_request (user_id,request_id),
  UNIQUE KEY uq_nodeloc_trade (trade_no),
  KEY idx_nodeloc_user (user_id,created_at),
  CONSTRAINT fk_nodeloc_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT chk_nodeloc_points CHECK (points > 0),
  CONSTRAINT chk_nodeloc_energy CHECK (energy > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

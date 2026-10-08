CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(64) NOT NULL,
  email VARCHAR(254) COLLATE utf8mb4_0900_ai_ci NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('USER', 'ADMIN', 'SUPER_ADMIN') NOT NULL DEFAULT 'USER',
  status ENUM('ACTIVE', 'RESTRICTED', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  points_balance BIGINT NOT NULL DEFAULT 0,
  locale VARCHAR(16) NOT NULL DEFAULT 'zh-CN',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_public_id (public_id),
  UNIQUE KEY uq_users_email (email),
  CONSTRAINT chk_users_points_balance CHECK (points_balance >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(36) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  ip_address VARCHAR(45),
  user_agent VARCHAR(500),
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token_hash (token_hash),
  KEY idx_sessions_user_expires (user_id, expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS membership_plans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  duration_days INT UNSIGNED NOT NULL,
  price_points BIGINT UNSIGNED NOT NULL,
  mailbox_discount_percent TINYINT UNSIGNED NOT NULL DEFAULT 70,
  message_retention_days INT UNSIGNED NOT NULL DEFAULT 90,
  api_limit_multiplier INT UNSIGNED NOT NULL DEFAULT 5,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_membership_plans_code (code),
  CONSTRAINT chk_membership_duration CHECK (duration_days > 0),
  CONSTRAINT chk_membership_price CHECK (price_points > 0),
  CONSTRAINT chk_membership_discount CHECK (mailbox_discount_percent BETWEEN 0 AND 100),
  CONSTRAINT chk_membership_retention CHECK (message_retention_days > 0),
  CONSTRAINT chk_membership_api_limit CHECK (api_limit_multiplier > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS memberships (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  plan_id BIGINT UNSIGNED NOT NULL,
  status ENUM('PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  starts_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_memberships_user_status (user_id, status, expires_at),
  KEY idx_memberships_plan (plan_id),
  CONSTRAINT fk_memberships_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_memberships_plan FOREIGN KEY (plan_id) REFERENCES membership_plans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS recharge_plans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL,
  points BIGINT UNSIGNED NOT NULL,
  amount_usd_cents BIGINT UNSIGNED NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_recharge_plans_code (code),
  CONSTRAINT chk_recharge_points CHECK (points > 0),
  CONSTRAINT chk_recharge_amount CHECK (amount_usd_cents > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS payment_channels (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL,
  mode ENUM('CRYPTO', 'ALIPAY', 'WXPAY') NOT NULL,
  token VARCHAR(32),
  network VARCHAR(64),
  label VARCHAR(128) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_channels_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS recharge_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  recharge_plan_id BIGINT UNSIGNED NOT NULL,
  payment_channel_id BIGINT UNSIGNED NOT NULL,
  amount_usd_cents BIGINT UNSIGNED NOT NULL,
  points BIGINT UNSIGNED NOT NULL,
  status ENUM('PENDING', 'PAID', 'CANCELLED', 'EXPIRED', 'FAILED') NOT NULL DEFAULT 'PENDING',
  payment_address VARCHAR(255),
  external_reference VARCHAR(255),
  expires_at DATETIME(3) NOT NULL,
  paid_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_recharge_orders_public_id (public_id),
  KEY idx_recharge_orders_user_created (user_id, created_at DESC),
  KEY idx_recharge_orders_open (status, expires_at),
  KEY idx_recharge_orders_plan (recharge_plan_id),
  KEY idx_recharge_orders_channel (payment_channel_id),
  CONSTRAINT fk_recharge_orders_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_recharge_orders_plan FOREIGN KEY (recharge_plan_id) REFERENCES recharge_plans(id),
  CONSTRAINT fk_recharge_orders_channel FOREIGN KEY (payment_channel_id) REFERENCES payment_channels(id),
  CONSTRAINT chk_recharge_order_amount CHECK (amount_usd_cents > 0),
  CONSTRAINT chk_recharge_order_points CHECK (points > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS point_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  type ENUM('REGISTER_BONUS', 'RECHARGE', 'MAILBOX_PURCHASE', 'MEMBERSHIP_PURCHASE', 'REFUND', 'ADMIN_ADJUSTMENT') NOT NULL,
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  reference_type VARCHAR(64),
  reference_id VARCHAR(128),
  note VARCHAR(500),
  operator_user_id BIGINT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_point_transactions_public_id (public_id),
  KEY idx_point_transactions_user_created (user_id, created_at DESC),
  KEY idx_point_transactions_operator (operator_user_id),
  CONSTRAINT fk_point_transactions_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_point_transactions_operator FOREIGN KEY (operator_user_id) REFERENCES users(id),
  CONSTRAINT chk_point_transaction_amount CHECK (amount <> 0),
  CONSTRAINT chk_point_transaction_balance CHECK (balance_after >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS domains (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  domain VARCHAR(253) COLLATE utf8mb4_0900_ai_ci NOT NULL,
  kind ENUM('PUBLIC', 'LOGIN', 'MEMBER', 'PRIVATE') NOT NULL,
  owner_user_id BIGINT UNSIGNED,
  mx_status ENUM('PENDING', 'ACTIVE', 'MISMATCH', 'NOT_FOUND', 'UNAVAILABLE') NOT NULL DEFAULT 'PENDING',
  status ENUM('PENDING', 'ACTIVE', 'DISABLED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  mailbox_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_domains_domain (domain),
  KEY idx_domains_owner_status (owner_user_id, status),
  CONSTRAINT fk_domains_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS mailboxes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  domain_id BIGINT UNSIGNED NOT NULL,
  address VARCHAR(320) COLLATE utf8mb4_0900_ai_ci NOT NULL,
  duration_minutes INT UNSIGNED,
  status ENUM('ACTIVE', 'PAUSED', 'EXPIRED', 'DELETED') NOT NULL DEFAULT 'ACTIVE',
  received_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_mailboxes_public_id (public_id),
  UNIQUE KEY uq_mailboxes_address (address),
  KEY idx_mailboxes_user_status (user_id, status),
  KEY idx_mailboxes_domain_status (domain_id, status),
  CONSTRAINT fk_mailboxes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mailboxes_domain FOREIGN KEY (domain_id) REFERENCES domains(id),
  CONSTRAINT chk_mailboxes_duration CHECK (duration_minutes IS NULL OR duration_minutes > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(64) NOT NULL,
  mailbox_id BIGINT UNSIGNED NOT NULL,
  message_id VARCHAR(998),
  from_address VARCHAR(320) NOT NULL,
  subject TEXT,
  text_content MEDIUMTEXT,
  html_content MEDIUMTEXT,
  size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  risk_status ENUM('SAFE', 'REVIEW', 'QUARANTINED') NOT NULL DEFAULT 'SAFE',
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  received_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_messages_public_id (public_id),
  KEY idx_messages_mailbox_received (mailbox_id, received_at DESC),
  KEY idx_messages_risk_received (risk_status, received_at DESC),
  CONSTRAINT fk_messages_mailbox FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS message_attachments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id BIGINT UNSIGNED NOT NULL,
  file_name VARCHAR(500) NOT NULL,
  content_type VARCHAR(255),
  size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  storage_key VARCHAR(500) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_message_attachments_message (message_id),
  CONSTRAINT fk_message_attachments_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS api_keys (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  key_prefix VARCHAR(32) NOT NULL,
  key_hash CHAR(64) NOT NULL,
  status ENUM('ACTIVE', 'DISABLED', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
  rate_limit_per_minute INT UNSIGNED NOT NULL DEFAULT 30,
  last_used_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_api_keys_public_id (public_id),
  UNIQUE KEY uq_api_keys_key_hash (key_hash),
  KEY idx_api_keys_user_status (user_id, status),
  CONSTRAINT fk_api_keys_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_api_keys_rate_limit CHECK (rate_limit_per_minute > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS system_settings (
  `key` VARCHAR(128) NOT NULL,
  value TEXT NOT NULL,
  value_type ENUM('string', 'integer', 'boolean', 'json') NOT NULL DEFAULT 'string',
  description VARCHAR(500),
  updated_by_user_id BIGINT UNSIGNED,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`key`),
  KEY idx_system_settings_updated_by (updated_by_user_id),
  CONSTRAINT fk_system_settings_updated_by FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(64) NOT NULL,
  actor_user_id BIGINT UNSIGNED,
  action VARCHAR(128) NOT NULL,
  entity_type VARCHAR(128) NOT NULL,
  entity_id VARCHAR(128),
  detail_json JSON,
  ip_address VARCHAR(45),
  status ENUM('SUCCESS', 'FAILED') NOT NULL DEFAULT 'SUCCESS',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_logs_public_id (public_id),
  KEY idx_audit_logs_actor_created (actor_user_id, created_at DESC),
  KEY idx_audit_logs_entity (entity_type, entity_id, created_at DESC),
  CONSTRAINT fk_audit_logs_actor FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

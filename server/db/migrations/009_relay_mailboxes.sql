ALTER TABLE domains
  MODIFY kind ENUM('PUBLIC', 'LOGIN', 'MEMBER', 'PRIVATE', 'RELAY') NOT NULL;

CREATE TABLE IF NOT EXISTS relay_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(64) NOT NULL,
  provider ENUM('GMAIL', 'OUTLOOK', 'CUSTOM') NOT NULL DEFAULT 'CUSTOM',
  email VARCHAR(320) COLLATE utf8mb4_0900_ai_ci NOT NULL,
  suffix VARCHAR(253) COLLATE utf8mb4_0900_ai_ci NOT NULL,
  imap_host VARCHAR(253) NOT NULL,
  imap_port SMALLINT UNSIGNED NOT NULL DEFAULT 993,
  imap_secure BOOLEAN NOT NULL DEFAULT TRUE,
  username VARCHAR(320) NOT NULL,
  credential_ciphertext VARBINARY(512) NOT NULL,
  credential_kdf_salt BINARY(16) NOT NULL,
  credential_iv BINARY(12) NOT NULL,
  credential_auth_tag BINARY(16) NOT NULL,
  status ENUM('ACTIVE', 'DISABLED', 'ERROR') NOT NULL DEFAULT 'DISABLED',
  max_aliases INT UNSIGNED NOT NULL DEFAULT 500,
  last_uid BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(500),
  last_checked_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_relay_accounts_public_id (public_id),
  UNIQUE KEY uq_relay_accounts_email (email),
  KEY idx_relay_accounts_suffix_status (suffix, status),
  CONSTRAINT chk_relay_accounts_port CHECK (imap_port BETWEEN 1 AND 65535),
  CONSTRAINT chk_relay_accounts_capacity CHECK (max_aliases BETWEEN 1 AND 100000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE relay_accounts
  ADD COLUMN uid_validity BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER last_uid;

CREATE TABLE IF NOT EXISTS relay_message_links (
  relay_account_id BIGINT UNSIGNED NOT NULL,
  uid_validity BIGINT UNSIGNED NOT NULL,
  imap_uid BIGINT UNSIGNED NOT NULL,
  mailbox_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (relay_account_id, uid_validity, imap_uid, mailbox_id),
  KEY idx_relay_message_links_mailbox (mailbox_id),
  CONSTRAINT fk_relay_message_links_account
    FOREIGN KEY (relay_account_id) REFERENCES relay_accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_relay_message_links_mailbox
    FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS relay_remote_cleanup_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  relay_account_id BIGINT UNSIGNED NOT NULL,
  uid_validity BIGINT UNSIGNED NOT NULL,
  imap_uid BIGINT UNSIGNED NOT NULL,
  status ENUM('PENDING', 'RETRY', 'DONE', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_error VARCHAR(500),
  completed_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_relay_remote_cleanup_source (relay_account_id, uid_validity, imap_uid),
  KEY idx_relay_remote_cleanup_due (status, next_attempt_at),
  CONSTRAINT fk_relay_remote_cleanup_account
    FOREIGN KEY (relay_account_id) REFERENCES relay_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

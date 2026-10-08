CREATE TABLE IF NOT EXISTS guest_sessions (
  id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  ip_hash CHAR(64),
  user_agent_hash CHAR(64),
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_guest_sessions_token_hash (token_hash),
  KEY idx_guest_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE mailboxes
  MODIFY COLUMN user_id BIGINT UNSIGNED NULL,
  ADD COLUMN guest_session_id CHAR(36) NULL AFTER user_id,
  ADD KEY idx_mailboxes_guest_status_expires (guest_session_id, status, expires_at),
  ADD CONSTRAINT fk_mailboxes_guest_session
    FOREIGN KEY (guest_session_id) REFERENCES guest_sessions(id) ON DELETE CASCADE,
  ADD CONSTRAINT chk_mailboxes_owner
    CHECK ((user_id IS NOT NULL AND guest_session_id IS NULL) OR (user_id IS NULL AND guest_session_id IS NOT NULL));

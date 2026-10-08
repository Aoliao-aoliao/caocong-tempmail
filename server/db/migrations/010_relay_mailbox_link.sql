ALTER TABLE mailboxes
  ADD COLUMN relay_account_id BIGINT UNSIGNED NULL AFTER domain_id,
  ADD KEY idx_mailboxes_relay_status (relay_account_id, status, expires_at),
  ADD CONSTRAINT fk_mailboxes_relay_account
    FOREIGN KEY (relay_account_id) REFERENCES relay_accounts(id) ON DELETE RESTRICT;

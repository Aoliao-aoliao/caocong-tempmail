ALTER TABLE mailboxes
  ADD COLUMN request_id CHAR(36) NULL AFTER public_id,
  ADD UNIQUE KEY uq_mailboxes_user_request (user_id, request_id);

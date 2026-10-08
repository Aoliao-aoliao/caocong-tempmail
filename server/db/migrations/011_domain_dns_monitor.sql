ALTER TABLE domains
  ADD COLUMN mx_checked_at DATETIME(3) NULL AFTER mx_status,
  ADD COLUMN mx_records_json JSON NULL AFTER mx_checked_at,
  ADD COLUMN mx_error VARCHAR(500) NULL AFTER mx_records_json;

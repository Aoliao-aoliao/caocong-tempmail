ALTER TABLE api_keys
  ADD COLUMN key_ciphertext VARBINARY(512) NULL AFTER key_hash,
  ADD COLUMN key_kdf_salt BINARY(16) NULL AFTER key_ciphertext,
  ADD COLUMN key_iv BINARY(12) NULL AFTER key_kdf_salt,
  ADD COLUMN key_auth_tag BINARY(16) NULL AFTER key_iv;

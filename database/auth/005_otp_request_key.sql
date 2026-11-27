ALTER TABLE otp_challenges ADD COLUMN request_key_hash BINARY(32) NULL,
  ADD UNIQUE KEY ux_otp_request_key (request_key_hash);

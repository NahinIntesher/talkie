ALTER TABLE sessions MODIFY expires_at DATETIME(3) NULL;
UPDATE sessions s JOIN devices d ON d.id = s.device_id
SET s.expires_at = NULL WHERE d.platform IN ('android', 'ios') AND s.revoked_at IS NULL
  AND s.expires_at > CURRENT_TIMESTAMP(3);

ALTER TABLE refresh_tokens ADD COLUMN rotation_attempt BINARY(32) NULL;

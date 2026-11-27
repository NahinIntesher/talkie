-- A joined participant belongs to the device that answered. Older callers can be identified from their media key.
SET @ddl = IF(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'call_participants' AND column_name = 'joined_device_id'),
  'SELECT 1', 'ALTER TABLE call_participants ADD COLUMN joined_device_id BIGINT UNSIGNED NULL, ADD COLUMN media_missing_since DATETIME(3) NULL');
PREPARE call_ddl FROM @ddl;
EXECUTE call_ddl;
DEALLOCATE PREPARE call_ddl;
UPDATE call_participants p JOIN calls c ON c.id = p.call_id
SET p.joined_device_id = c.key_sender_device_id
WHERE c.state IN ('ringing','active') AND p.user_id = c.initiator_id AND p.state = 'joined' AND p.joined_device_id IS NULL;

SET @ddl = IF(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'calls' AND column_name = 'media_checked_at'),
  'SELECT 1', 'ALTER TABLE calls ADD COLUMN media_checked_at DATETIME(3) NULL, ADD INDEX ix_call_media_check (state, media_checked_at)');
PREPARE call_ddl FROM @ddl;
EXECUTE call_ddl;
DEALLOCATE PREPARE call_ddl;

-- Serialize simultaneous dial/answer attempts, including a user's very first call.
CREATE TABLE IF NOT EXISTS call_user_locks (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY
) ENGINE=InnoDB;

-- 3NF: a session belongs to exactly one device and a device to one account, so sessions.account_id only repeated
-- devices.account_id (session → device → account). The account is now always reached through the device.
ALTER TABLE sessions DROP FOREIGN KEY fk_sessions_account;
ALTER TABLE sessions DROP INDEX ix_sessions_account;
ALTER TABLE sessions DROP COLUMN account_id;

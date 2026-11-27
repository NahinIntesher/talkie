-- A recovery recipient has only a public encryption key. It cannot sign in or receive session tokens.
CREATE TABLE IF NOT EXISTS history_backups (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  recipient_id BIGINT UNSIGNED NOT NULL UNIQUE,
  identity_key CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

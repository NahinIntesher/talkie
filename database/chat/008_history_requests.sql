CREATE TABLE history_requests (
  user_id BIGINT UNSIGNED NOT NULL,
  device_id BIGINT UNSIGNED NOT NULL,
  identity_key CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (user_id, device_id),
  KEY ix_history_requests_time (requested_at)
) ENGINE=InnoDB;

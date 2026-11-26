-- Transactional outbox (events this service publishes) and consumer de-duplication.
CREATE TABLE outbox (
  id           BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  event_type   VARCHAR(64)     NOT NULL,
  event_key    VARCHAR(64)     NOT NULL,
  payload      LONGTEXT        NOT NULL,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at DATETIME(3)     NULL,
  KEY ix_outbox_pending (published_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE processed_events (
  consumer_group VARCHAR(64)     NOT NULL,
  event_id       BIGINT UNSIGNED NOT NULL,
  processed_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (consumer_group, event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

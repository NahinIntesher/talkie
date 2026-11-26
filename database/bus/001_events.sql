-- Event log used by BUS_DRIVER=mysql (local development / single-host installs). Production uses Redis Streams.
CREATE TABLE events (
  id          BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  event_type  VARCHAR(64)     NOT NULL,
  event_key   VARCHAR(64)     NOT NULL,
  payload     LONGTEXT        NOT NULL,
  occurred_at DATETIME(3)     NOT NULL,
  KEY ix_events_type_id (event_type, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE consumer_offsets (
  consumer_group VARCHAR(64)     NOT NULL PRIMARY KEY,
  last_event_id  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

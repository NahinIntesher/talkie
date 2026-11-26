-- Abuse reports, moderation actions and the admin audit trail.

CREATE TABLE reports (
  id          BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  reporter_id BIGINT UNSIGNED NOT NULL,
  target_type ENUM('user','group','meeting') NOT NULL,
  target_id   BIGINT UNSIGNED NOT NULL,
  reason      ENUM('spam','harassment','impersonation','inappropriate','other') NOT NULL,
  note        VARCHAR(500)    NOT NULL DEFAULT '',
  status      ENUM('open','reviewing','actioned','dismissed') NOT NULL DEFAULT 'open',
  assigned_to BIGINT UNSIGNED NULL,
  resolution  VARCHAR(500)    NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_at DATETIME(3)     NULL,
  KEY ix_reports_status (status, id),
  KEY ix_reports_target (target_type, target_id),
  KEY ix_reports_reporter (reporter_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_log (
  id          BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  actor_id    BIGINT UNSIGNED NOT NULL,
  action      VARCHAR(64)     NOT NULL,
  target_type VARCHAR(32)     NOT NULL,
  target_id   BIGINT UNSIGNED NULL,
  details     LONGTEXT        NULL,
  ip          VARBINARY(16)   NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_audit_actor (actor_id, id),
  KEY ix_audit_target (target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Daily platform numbers for the dashboard, filled by the admin service from events.
CREATE TABLE daily_stats (
  stat_date       DATE            NOT NULL PRIMARY KEY,
  signups         INT UNSIGNED    NOT NULL DEFAULT 0,
  active_users    INT UNSIGNED    NOT NULL DEFAULT 0,
  messages_sent   INT UNSIGNED    NOT NULL DEFAULT 0,
  calls_started   INT UNSIGNED    NOT NULL DEFAULT 0,
  meetings_held   INT UNSIGNED    NOT NULL DEFAULT 0,
  meeting_minutes INT UNSIGNED    NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Push tokens and email delivery log. One-time codes are never stored here.

CREATE TABLE push_tokens (
  device_id  BIGINT UNSIGNED NOT NULL PRIMARY KEY,   -- = auth.devices.id
  user_id    BIGINT UNSIGNED NOT NULL,
  provider   ENUM('fcm','webpush') NOT NULL,
  token      VARCHAR(1024)   NOT NULL,
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_push_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE email_deliveries (
  id         BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  recipient  VARCHAR(254)    NOT NULL,
  template   ENUM('otp','welcome','new_device','account_deleted') NOT NULL,
  status     ENUM('sent','failed') NOT NULL,
  provider_message_id VARCHAR(255) NULL,
  error      VARCHAR(500)    NULL,
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_email_recipient (recipient, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notification_preferences (
  user_id        BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  messages       TINYINT(1)      NOT NULL DEFAULT 1,
  groups_enabled TINYINT(1)      NOT NULL DEFAULT 1,
  calls          TINYINT(1)      NOT NULL DEFAULT 1,
  show_preview   TINYINT(1)      NOT NULL DEFAULT 1,
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

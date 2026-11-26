-- Uploaded objects in S3-compatible storage. Message media is encrypted on the device; the server never has its key.

CREATE TABLE media_objects (
  id           BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  owner_id     BIGINT UNSIGNED NOT NULL,
  purpose      ENUM('avatar','group_avatar','message','status','recording','meeting_file') NOT NULL,
  storage_key  VARCHAR(255)    NOT NULL,
  content_type VARCHAR(127)    NOT NULL,
  byte_size    BIGINT UNSIGNED NOT NULL,
  sha256       BINARY(32)      NULL,
  encrypted    TINYINT(1)      NOT NULL DEFAULT 1,
  width        SMALLINT UNSIGNED NULL,
  height       SMALLINT UNSIGNED NULL,
  duration_ms  INT UNSIGNED    NULL,
  status       ENUM('pending','ready','deleted') NOT NULL DEFAULT 'pending',
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3)     NULL,
  deleted_at   DATETIME(3)     NULL,
  UNIQUE KEY ux_media_storage_key (storage_key),
  KEY ix_media_owner (owner_id, id),
  KEY ix_media_pending (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-user storage use, maintained when an upload completes or is deleted.
CREATE TABLE storage_usage (
  owner_id   BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  bytes_used BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

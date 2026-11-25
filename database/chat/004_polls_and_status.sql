-- Poll votes. The question and options are inside the encrypted message; votes refer to options by position.
CREATE TABLE poll_votes (
  message_id   BIGINT UNSIGNED  NOT NULL,
  user_id      BIGINT UNSIGNED  NOT NULL,
  option_index TINYINT UNSIGNED NOT NULL,
  voted_at     DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (message_id, user_id, option_index),
  CONSTRAINT fk_poll_votes_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Status updates (disappear after 24 hours). Encrypted like messages: one key sealed per audience device.
CREATE TABLE statuses (
  id               BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  owner_id         BIGINT UNSIGNED NOT NULL,
  sender_device_id BIGINT UNSIGNED NOT NULL,
  kind             ENUM('text','image','video') NOT NULL,
  ciphertext       MEDIUMBLOB      NOT NULL,
  nonce            VARBINARY(24)   NOT NULL,
  media_id         BIGINT UNSIGNED NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at       DATETIME(3)     NOT NULL,
  KEY ix_statuses_owner (owner_id, id),
  KEY ix_statuses_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Who may see a status (chosen by the owner's privacy setting on their device).
CREATE TABLE status_audience (
  status_id BIGINT UNSIGNED NOT NULL,
  user_id   BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (status_id, user_id),
  KEY ix_status_audience_user (user_id, status_id),
  CONSTRAINT fk_status_audience_status FOREIGN KEY (status_id) REFERENCES statuses (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE status_keys (
  status_id  BIGINT UNSIGNED NOT NULL,
  device_id  BIGINT UNSIGNED NOT NULL,
  sealed_key VARBINARY(128)  NOT NULL,
  PRIMARY KEY (status_id, device_id),
  CONSTRAINT fk_status_keys_status FOREIGN KEY (status_id) REFERENCES statuses (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE status_views (
  status_id BIGINT UNSIGNED NOT NULL,
  viewer_id BIGINT UNSIGNED NOT NULL,
  viewed_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reaction  VARCHAR(16)     NULL,
  PRIMARY KEY (status_id, viewer_id),
  CONSTRAINT fk_status_views_status FOREIGN KEY (status_id) REFERENCES statuses (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- People whose status updates I chose not to see in my feed.
CREATE TABLE status_mutes (
  user_id    BIGINT UNSIGNED NOT NULL,
  muted_id   BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, muted_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Conversations (direct and group), membership, end-to-end encrypted messages and per-user message state.

CREATE TABLE conversations (
  id              BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  kind            ENUM('direct','group') NOT NULL,
  created_by      BIGINT UNSIGNED NOT NULL,
  last_message_id BIGINT UNSIGNED NULL,          -- denormalized for chat-list ordering (maintained on send)
  disappearing_seconds INT UNSIGNED NULL,        -- default timer for new messages
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Guarantees exactly one direct conversation per pair of users (user_low < user_high).
CREATE TABLE direct_pairs (
  user_low        BIGINT UNSIGNED NOT NULL,
  user_high       BIGINT UNSIGNED NOT NULL,
  conversation_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_low, user_high),
  UNIQUE KEY ux_direct_conversation (conversation_id),
  KEY ix_direct_high (user_high),
  CONSTRAINT fk_direct_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT ck_direct_order CHECK (user_low < user_high)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `groups` (
  conversation_id   BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  name              VARCHAR(100)    NOT NULL,
  description       VARCHAR(2048)   NOT NULL DEFAULT '',
  avatar_media_id   BIGINT UNSIGNED NULL,
  send_policy       ENUM('all','admins') NOT NULL DEFAULT 'all',
  edit_info_policy  ENUM('all','admins') NOT NULL DEFAULT 'admins',
  add_member_policy ENUM('all','admins') NOT NULL DEFAULT 'admins',
  approval_required TINYINT(1)      NOT NULL DEFAULT 0,
  invite_code       CHAR(22)        NULL,
  max_members       SMALLINT UNSIGNED NOT NULL DEFAULT 1024,
  UNIQUE KEY ux_groups_invite (invite_code),
  CONSTRAINT fk_groups_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE conversation_members (
  conversation_id           BIGINT UNSIGNED NOT NULL,
  user_id                   BIGINT UNSIGNED NOT NULL,
  role                      ENUM('member','admin','owner') NOT NULL DEFAULT 'member',
  joined_at                 DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  left_at                   DATETIME(3)     NULL,
  added_by                  BIGINT UNSIGNED NULL,
  -- Per-user chat state.
  muted_until               DATETIME(3)     NULL,
  archived_at               DATETIME(3)     NULL,
  pinned_at                 DATETIME(3)     NULL,
  marked_unread             TINYINT(1)      NOT NULL DEFAULT 0,
  -- Watermarks: everything up to this id is delivered / read / cleared for this user.
  last_delivered_message_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_read_message_id      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  cleared_before_message_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id),
  KEY ix_members_user (user_id, left_at, conversation_id),
  CONSTRAINT fk_members_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE group_join_requests (
  conversation_id BIGINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (conversation_id, user_id),
  KEY ix_join_requests_user (user_id),
  CONSTRAINT fk_join_requests_group FOREIGN KEY (conversation_id) REFERENCES `groups` (conversation_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The server sees only metadata; `ciphertext` is the encrypted message body (text, media key, poll, …).
CREATE TABLE messages (
  id                BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  conversation_id   BIGINT UNSIGNED NOT NULL,
  sender_id         BIGINT UNSIGNED NOT NULL,
  sender_device_id  BIGINT UNSIGNED NOT NULL,
  kind              ENUM('text','image','video','audio','voice','document','sticker','location','contact','poll','system','call') NOT NULL,
  ciphertext        MEDIUMBLOB      NULL,          -- NULL after "delete for everyone"
  nonce             VARBINARY(24)   NULL,
  reply_to_id       BIGINT UNSIGNED NULL,
  forwarded_count   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  client_message_id CHAR(26)        NOT NULL,      -- client idempotency key
  edited_at         DATETIME(3)     NULL,
  deleted_at        DATETIME(3)     NULL,
  expires_at        DATETIME(3)     NULL,          -- disappearing messages
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY ux_messages_client (sender_id, client_message_id),
  KEY ix_messages_conversation (conversation_id, id),
  KEY ix_messages_expiry (expires_at),
  CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The message key sealed for each recipient device (and the sender's other devices).
CREATE TABLE message_keys (
  message_id  BIGINT UNSIGNED NOT NULL,
  device_id   BIGINT UNSIGNED NOT NULL,
  sealed_key  VARBINARY(128)  NOT NULL,
  PRIMARY KEY (message_id, device_id),
  KEY ix_message_keys_device (device_id, message_id),
  CONSTRAINT fk_message_keys_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE message_attachments (
  message_id BIGINT UNSIGNED NOT NULL,
  ordinal    TINYINT UNSIGNED NOT NULL,
  media_id   BIGINT UNSIGNED NOT NULL,           -- = media.media_objects.id (encrypted blob)
  PRIMARY KEY (message_id, ordinal),
  KEY ix_attachments_media (media_id),
  CONSTRAINT fk_attachments_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE message_reactions (
  message_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  emoji      VARCHAR(16)     NOT NULL,
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (message_id, user_id),
  CONSTRAINT fk_reactions_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE message_stars (
  user_id    BIGINT UNSIGNED NOT NULL,
  message_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, message_id),
  KEY ix_stars_message (message_id),
  CONSTRAINT fk_stars_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- "Delete for me".
CREATE TABLE message_hidden (
  user_id    BIGINT UNSIGNED NOT NULL,
  message_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, message_id),
  KEY ix_hidden_message (message_id),
  CONSTRAINT fk_hidden_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE conversation_pins (
  conversation_id BIGINT UNSIGNED NOT NULL,
  message_id      BIGINT UNSIGNED NOT NULL,
  pinned_by       BIGINT UNSIGNED NOT NULL,
  pinned_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at      DATETIME(3)     NULL,             -- NULL = pinned until unpinned
  PRIMARY KEY (conversation_id, message_id),
  CONSTRAINT fk_pins_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_pins_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- System lines in a conversation ("Nahin added Rafi", "Group name changed") are not encrypted: they describe
-- actions the server performed. Stored as a small JSON document.
ALTER TABLE messages ADD COLUMN system_event VARCHAR(1000) NULL AFTER nonce;

-- Copies of the few user settings the chat service needs, kept current from `privacy.updated` events.
CREATE TABLE user_flags (
  user_id       BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  read_receipts TINYINT(1)      NOT NULL DEFAULT 1,
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Unread counting walks a member's conversation from their read watermark; this index serves it.
ALTER TABLE messages ADD KEY ix_messages_conversation_sender (conversation_id, sender_id, id);

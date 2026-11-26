-- "Delete chat": hides the chat from this member's list until a newer message arrives (and clears its history for them).
ALTER TABLE conversation_members ADD COLUMN deleted_before_message_id BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER cleared_before_message_id;

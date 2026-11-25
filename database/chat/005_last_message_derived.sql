-- 3NF: conversations.last_message_id was MAX(messages.id) for the conversation, kept in step by hand.
-- It is now read from messages through ix_messages_conversation (conversation_id, id), which is just as fast.
ALTER TABLE conversations DROP COLUMN last_message_id;

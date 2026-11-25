-- End-to-end encrypted calls: the caller's device makes a random media key and seals it for every invited
-- device (like a message key). The media server only ever relays encrypted audio and video.
ALTER TABLE calls ADD COLUMN key_sender_device_id BIGINT UNSIGNED NULL AFTER e2ee;

CREATE TABLE call_keys (
  call_id    BIGINT UNSIGNED NOT NULL,
  device_id  BIGINT UNSIGNED NOT NULL,
  sealed_key VARBINARY(128)  NOT NULL,
  PRIMARY KEY (call_id, device_id),
  CONSTRAINT fk_call_keys_call FOREIGN KEY (call_id) REFERENCES calls (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Live-stream destinations and the in-meeting reactions counter are not stored; questions need an answered time.
ALTER TABLE questions ADD COLUMN answered_at DATETIME(3) NULL AFTER status;

-- Public profiles, usernames, privacy, contacts and blocks.

CREATE TABLE profiles (
  user_id         BIGINT UNSIGNED NOT NULL PRIMARY KEY,   -- = auth.accounts.id
  username        VARCHAR(32)     NOT NULL,
  display_name    VARCHAR(64)     NOT NULL,
  about           VARCHAR(140)    NOT NULL DEFAULT '',
  avatar_media_id BIGINT UNSIGNED NULL,                   -- = media.media_objects.id
  locale          ENUM('bn','en') NOT NULL DEFAULT 'bn',
  last_seen_at    DATETIME(3)     NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)     NULL,
  UNIQUE KEY ux_profiles_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Names nobody may take (brand, staff and system words).
CREATE TABLE reserved_usernames (
  username VARCHAR(32) NOT NULL PRIMARY KEY
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO reserved_usernames (username) VALUES
  ('admin'),('administrator'),('root'),('system'),('support'),('help'),('talkie'),('talkieapp'),('official'),
  ('moderator'),('mod'),('staff'),('security'),('api'),('www'),('mail'),('null'),('undefined'),('me'),('settings');

-- Who can see each part of a profile. A missing row means the default ('everyone', except groups_add = 'everyone').
CREATE TABLE privacy_settings (
  user_id     BIGINT UNSIGNED NOT NULL,
  setting_key ENUM('last_seen','online','profile_photo','about','status','groups_add') NOT NULL,
  audience    ENUM('everyone','contacts','nobody') NOT NULL,
  updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, setting_key),
  CONSTRAINT fk_privacy_user FOREIGN KEY (user_id) REFERENCES profiles (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_settings (
  user_id       BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  read_receipts TINYINT(1)      NOT NULL DEFAULT 1,
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES profiles (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- People a user saved, optionally under their own name for them.
CREATE TABLE contacts (
  owner_id   BIGINT UNSIGNED NOT NULL,
  contact_id BIGINT UNSIGNED NOT NULL,
  nickname   VARCHAR(64)     NULL,
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (owner_id, contact_id),
  KEY ix_contacts_contact (contact_id),
  CONSTRAINT fk_contacts_owner   FOREIGN KEY (owner_id)   REFERENCES profiles (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_contacts_contact FOREIGN KEY (contact_id) REFERENCES profiles (user_id) ON DELETE CASCADE,
  CONSTRAINT ck_contacts_self CHECK (owner_id <> contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE blocks (
  blocker_id BIGINT UNSIGNED NOT NULL,
  blocked_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (blocker_id, blocked_id),
  KEY ix_blocks_blocked (blocked_id),
  CONSTRAINT fk_blocks_blocker FOREIGN KEY (blocker_id) REFERENCES profiles (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_blocks_blocked FOREIGN KEY (blocked_id) REFERENCES profiles (user_id) ON DELETE CASCADE,
  CONSTRAINT ck_blocks_self CHECK (blocker_id <> blocked_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

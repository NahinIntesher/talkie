-- Accounts, email one-time codes, linked devices and refresh-token sessions.

CREATE TABLE accounts (
  id            BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  email         VARCHAR(254)    NOT NULL,
  -- pending_profile: email verified, username not chosen yet.
  status        ENUM('pending_profile','active','suspended','deleted') NOT NULL DEFAULT 'pending_profile',
  role          ENUM('user','moderator','admin','owner') NOT NULL DEFAULT 'user',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3)     NULL,
  suspended_reason VARCHAR(255) NULL,
  UNIQUE KEY ux_accounts_email (email),
  KEY ix_accounts_status (status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE otp_challenges (
  id                BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  email             VARCHAR(254)    NOT NULL,
  code_hash         BINARY(32)      NOT NULL,         -- HMAC-SHA256(pepper, challenge id + code)
  attempts          TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at        DATETIME(3)     NOT NULL,
  verified_at       DATETIME(3)     NULL,
  -- Single-use ticket to finish sign-up after a verified code for a new email.
  signup_token_hash BINARY(32)      NULL,
  consumed_at       DATETIME(3)     NULL,
  request_ip        VARBINARY(16)   NULL,
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_otp_email_created (email, created_at),
  KEY ix_otp_ip_created (request_ip, created_at),
  UNIQUE KEY ux_otp_signup_token (signup_token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE devices (
  id             BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  account_id     BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(80)     NOT NULL,
  platform       ENUM('web','android','ios','desktop') NOT NULL,
  -- Curve25519 public identity key (base64url) for end-to-end encryption; private key never leaves the device.
  identity_key   CHAR(43)        NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_active_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at     DATETIME(3)     NULL,
  KEY ix_devices_account (account_id, revoked_at),
  CONSTRAINT fk_devices_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One session per signed-in device.
CREATE TABLE sessions (
  id           BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  account_id   BIGINT UNSIGNED NOT NULL,
  device_id    BIGINT UNSIGNED NOT NULL,
  expires_at   DATETIME(3)     NOT NULL,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at   DATETIME(3)     NULL,
  revoke_reason ENUM('sign_out','device_removed','token_reuse','account_suspended','expired','admin') NULL,
  user_agent   VARCHAR(255)    NULL,
  ip           VARBINARY(16)   NULL,
  UNIQUE KEY ux_sessions_device (device_id),
  KEY ix_sessions_account (account_id, revoked_at),
  CONSTRAINT fk_sessions_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_sessions_device  FOREIGN KEY (device_id)  REFERENCES devices (id)  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every refresh token ever issued for a session. A token is valid once; presenting a used token revokes the session.
CREATE TABLE refresh_tokens (
  token_hash BINARY(32)      NOT NULL PRIMARY KEY,
  session_id BIGINT UNSIGNED NOT NULL,
  issued_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  used_at    DATETIME(3)     NULL,
  KEY ix_refresh_session (session_id),
  CONSTRAINT fk_refresh_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

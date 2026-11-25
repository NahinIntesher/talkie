-- Chat calls (1:1 and group) and Meet-style meetings with their in-meeting activities.

CREATE TABLE calls (
  id              BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  conversation_id BIGINT UNSIGNED NULL,           -- = chat.conversations.id
  initiator_id    BIGINT UNSIGNED NOT NULL,
  media           ENUM('audio','video') NOT NULL,
  state           ENUM('ringing','active','ended','missed','declined','cancelled','busy','failed') NOT NULL,
  e2ee            TINYINT(1)      NOT NULL DEFAULT 1,
  room_name       VARCHAR(64)     NOT NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  answered_at     DATETIME(3)     NULL,
  ended_at        DATETIME(3)     NULL,
  UNIQUE KEY ux_calls_room (room_name),
  KEY ix_calls_conversation (conversation_id, id),
  KEY ix_calls_open (state, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE call_participants (
  call_id     BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  state       ENUM('invited','ringing','joined','left','declined','missed','busy') NOT NULL,
  invited_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  joined_at   DATETIME(3)     NULL,
  left_at     DATETIME(3)     NULL,
  PRIMARY KEY (call_id, user_id),
  KEY ix_call_participants_user (user_id, call_id),
  CONSTRAINT fk_call_participants_call FOREIGN KEY (call_id) REFERENCES calls (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE meetings (
  id                 BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  code               CHAR(12)        NOT NULL,     -- abc-defg-hij
  title              VARCHAR(160)    NOT NULL DEFAULT '',
  description        VARCHAR(2048)   NOT NULL DEFAULT '',
  host_id            BIGINT UNSIGNED NOT NULL,
  scheduled_start_at DATETIME(3)     NULL,
  scheduled_end_at   DATETIME(3)     NULL,
  timezone           VARCHAR(64)     NOT NULL DEFAULT 'Asia/Dhaka',
  access             ENUM('open','trusted','restricted') NOT NULL DEFAULT 'trusted',
  e2ee               TINYINT(1)      NOT NULL DEFAULT 0,
  status             ENUM('scheduled','live','ended','cancelled') NOT NULL DEFAULT 'scheduled',
  created_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY ux_meetings_code (code),
  KEY ix_meetings_host (host_id, scheduled_start_at),
  KEY ix_meetings_status (status, scheduled_start_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Host management: which actions ordinary participants may take. One row per meeting.
CREATE TABLE meeting_controls (
  meeting_id          BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  host_management     TINYINT(1) NOT NULL DEFAULT 0,
  allow_screen_share  TINYINT(1) NOT NULL DEFAULT 1,
  allow_chat          TINYINT(1) NOT NULL DEFAULT 1,
  allow_reactions     TINYINT(1) NOT NULL DEFAULT 1,
  allow_unmute        TINYINT(1) NOT NULL DEFAULT 1,
  allow_video         TINYINT(1) NOT NULL DEFAULT 1,
  locked              TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_controls_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE meeting_cohosts (
  meeting_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  added_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (meeting_id, user_id),
  KEY ix_cohosts_user (user_id),
  CONSTRAINT fk_cohosts_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE meeting_invitees (
  meeting_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  rsvp       ENUM('pending','yes','no','maybe') NOT NULL DEFAULT 'pending',
  invited_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (meeting_id, user_id),
  KEY ix_invitees_user (user_id),
  CONSTRAINT fk_invitees_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row each time a meeting link goes live (a link can be reused).
CREATE TABLE meeting_sessions (
  id          BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  meeting_id  BIGINT UNSIGNED NOT NULL,
  room_name   VARCHAR(64)     NOT NULL,
  started_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at    DATETIME(3)     NULL,
  peak_participants SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY ux_sessions_room (room_name),
  KEY ix_sessions_meeting (meeting_id, started_at),
  CONSTRAINT fk_sessions_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE meeting_participants (
  id               BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  session_id       BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NULL,          -- NULL for guests
  guest_name       VARCHAR(64)     NULL,
  role             ENUM('host','cohost','participant','viewer') NOT NULL DEFAULT 'participant',
  admission        ENUM('waiting','admitted','denied','removed','left') NOT NULL,
  hand_raised_at   DATETIME(3)     NULL,
  first_joined_at  DATETIME(3)     NULL,
  last_joined_at   DATETIME(3)     NULL,
  last_left_at     DATETIME(3)     NULL,
  duration_seconds INT UNSIGNED    NOT NULL DEFAULT 0,
  UNIQUE KEY ux_participants_session_user (session_id, user_id),
  KEY ix_participants_admission (session_id, admission),
  KEY ix_participants_user (user_id),
  CONSTRAINT fk_participants_session FOREIGN KEY (session_id) REFERENCES meeting_sessions (id) ON DELETE CASCADE,
  CONSTRAINT ck_participants_identity CHECK (user_id IS NOT NULL OR guest_name IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meeting_chat_messages (
  id             BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  session_id     BIGINT UNSIGNED NOT NULL,
  participant_id BIGINT UNSIGNED NOT NULL,
  body           VARCHAR(2000)   NOT NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at     DATETIME(3)     NULL,
  KEY ix_meeting_chat_session (session_id, id),
  CONSTRAINT fk_meeting_chat_session FOREIGN KEY (session_id) REFERENCES meeting_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_meeting_chat_participant FOREIGN KEY (participant_id) REFERENCES meeting_participants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE polls (
  id              BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  session_id      BIGINT UNSIGNED NOT NULL,
  created_by      BIGINT UNSIGNED NOT NULL,       -- participant id
  question        VARCHAR(300)    NOT NULL,
  multiple_choice TINYINT(1)      NOT NULL DEFAULT 0,
  anonymous       TINYINT(1)      NOT NULL DEFAULT 0,
  results_shared  TINYINT(1)      NOT NULL DEFAULT 0,
  status          ENUM('draft','open','closed') NOT NULL DEFAULT 'draft',
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_at       DATETIME(3)     NULL,
  KEY ix_polls_session (session_id, id),
  CONSTRAINT fk_polls_session FOREIGN KEY (session_id) REFERENCES meeting_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE poll_options (
  id      BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  poll_id BIGINT UNSIGNED NOT NULL,
  ordinal TINYINT UNSIGNED NOT NULL,
  label   VARCHAR(120)    NOT NULL,
  UNIQUE KEY ux_poll_options_order (poll_id, ordinal),
  CONSTRAINT fk_poll_options_poll FOREIGN KEY (poll_id) REFERENCES polls (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE poll_votes (
  poll_id        BIGINT UNSIGNED NOT NULL,
  option_id      BIGINT UNSIGNED NOT NULL,
  participant_id BIGINT UNSIGNED NOT NULL,
  voted_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (poll_id, participant_id, option_id),
  KEY ix_poll_votes_option (option_id),
  CONSTRAINT fk_poll_votes_poll   FOREIGN KEY (poll_id)   REFERENCES polls (id) ON DELETE CASCADE,
  CONSTRAINT fk_poll_votes_option FOREIGN KEY (option_id) REFERENCES poll_options (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE questions (
  id             BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  session_id     BIGINT UNSIGNED NOT NULL,
  participant_id BIGINT UNSIGNED NOT NULL,
  body           VARCHAR(500)    NOT NULL,
  anonymous      TINYINT(1)      NOT NULL DEFAULT 0,
  status         ENUM('open','answered','hidden') NOT NULL DEFAULT 'open',
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_questions_session (session_id, status, id),
  CONSTRAINT fk_questions_session FOREIGN KEY (session_id) REFERENCES meeting_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE question_votes (
  question_id    BIGINT UNSIGNED NOT NULL,
  participant_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (question_id, participant_id),
  CONSTRAINT fk_question_votes_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE breakout_rooms (
  id         BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  session_id BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(60)     NOT NULL,
  room_name  VARCHAR(64)     NOT NULL,
  opened_at  DATETIME(3)     NULL,
  closes_at  DATETIME(3)     NULL,
  closed_at  DATETIME(3)     NULL,
  UNIQUE KEY ux_breakout_room (room_name),
  KEY ix_breakout_session (session_id),
  CONSTRAINT fk_breakout_session FOREIGN KEY (session_id) REFERENCES meeting_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE breakout_assignments (
  participant_id   BIGINT UNSIGNED NOT NULL PRIMARY KEY,   -- a participant is in at most one breakout room
  breakout_room_id BIGINT UNSIGNED NOT NULL,
  KEY ix_assignments_room (breakout_room_id),
  CONSTRAINT fk_assignments_participant FOREIGN KEY (participant_id) REFERENCES meeting_participants (id) ON DELETE CASCADE,
  CONSTRAINT fk_assignments_room FOREIGN KEY (breakout_room_id) REFERENCES breakout_rooms (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cloud recordings and live streams (LiveKit Egress).
CREATE TABLE recordings (
  id         BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  session_id BIGINT UNSIGNED NOT NULL,
  kind       ENUM('recording','stream') NOT NULL,
  egress_id  VARCHAR(64)     NOT NULL,
  status     ENUM('starting','active','ending','complete','failed') NOT NULL,
  started_by BIGINT UNSIGNED NOT NULL,
  media_id   BIGINT UNSIGNED NULL,               -- finished file, = media.media_objects.id
  started_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at   DATETIME(3)     NULL,
  UNIQUE KEY ux_recordings_egress (egress_id),
  KEY ix_recordings_session (session_id),
  CONSTRAINT fk_recordings_session FOREIGN KEY (session_id) REFERENCES meeting_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

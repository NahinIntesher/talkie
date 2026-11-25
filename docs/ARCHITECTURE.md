# Talkie — Architecture

Talkie is an independent product (no shared code, database or accounts with Diganta).

- **Clients:** Next.js web app (`apps/web`), Flutter Android app (`apps/mobile`).
- **Domain:** `talkie.kodofact.com` (web + `/api` + `/ws` on one origin).
- **Media:** LiveKit Cloud (calls, meetings, recording, streaming).
- **Languages:** বাংলা + English. **Themes:** light, dark, system.

## 1. Service map

```
                    ┌──────────────── talkie.kodofact.com (HTTPS) ────────────────┐
 Browser / Android ─┤  Nginx edge: TLS, HTTP/2, gzip/brotli, rate limits,          │
                    │  load balancing (least_conn) across service replicas         │
                    └─┬──────┬───────┬───────┬────────┬───────┬───────┬──────┬─────┘
                      │      │       │       │        │       │       │      │
                    web   auth    users    chat   realtime  media   meet   admin
                  (Next) service service service  (Socket.IO)service service service
                      │      │       │       │        │       │       │      │
                      └──────┴───────┴───┬───┴────────┴───────┴───────┴──────┘
                                         │  events (Redis Streams, consumer groups)
                                   notification service (email OTP, FCM push)
             MySQL 8 (one database per service)   Redis 7   S3-compatible storage   LiveKit Cloud
```

| Service | Port | Owns database | Responsibility |
|---|---|---|---|
| `auth` | 4101 | `talkie_auth` | Email OTP, sign-up, sessions, refresh-token rotation, linked devices, device public keys |
| `users` | 4102 | `talkie_users` | Profiles, usernames, privacy settings, contacts, blocks, reports |
| `chat` | 4103 | `talkie_chat` | Conversations, groups, members, encrypted messages, receipts, reactions, pins, stars |
| `realtime` | 4104 | — (Redis) | WebSocket fan-out, presence, typing; stateless, scales horizontally via Redis adapter |
| `media` | 4105 | `talkie_media` | Pre-signed uploads/downloads of encrypted blobs, quotas |
| `meet` | 4106 | `talkie_meet` | Calls, meetings, waiting room, co-hosts, polls, Q&A, breakout rooms, LiveKit tokens/webhooks |
| `notify` | 4107 | `talkie_notify` | Email delivery, push tokens, push delivery, notification preferences |
| `admin` | 4108 | `talkie_admin` | Admin users/roles, moderation queue, audit log, statistics (reads via service APIs) |

Rules:
- A service reads and writes **only its own database**. Cross-service references are plain IDs, never foreign keys.
- Services talk **synchronously** only for reads that must be fresh (internal HTTP with a service token), and **asynchronously** for everything else through events (`user.created`, `message.sent`, `call.ringing`, …).
- Every write that publishes an event uses a **transactional outbox** (`outbox` table in the same database, same transaction), relayed to Redis Streams. No lost or phantom events.
- Every service is **stateless**: any replica can serve any request. State lives in MySQL/Redis.

## 2. Identity and security
- **Passwordless email OTP.** 6-digit code, stored as an HMAC hash, 10-minute expiry, 5 attempts, per-email and per-IP rate limits.
- **Access token:** EdDSA (Ed25519) JWT, 15 minutes, signed only by `auth`; every other service verifies it with the public key — no shared secret.
- **Refresh token:** 256-bit random, stored hashed, rotated on every use; re-use of an old token revokes the whole session family (theft detection). Web keeps it in an `HttpOnly; Secure; SameSite=Strict` cookie; Android keeps it in Android Keystore-backed secure storage.
- **IDs:** 64-bit time-ordered Snowflake IDs (`BIGINT UNSIGNED`), sent to clients as strings. Sortable, compact, index-friendly, not guessable as a sequence.
- **End-to-end encryption (v1, `packages/e2ee`):** each device makes an X25519 key pair; only the public key is uploaded (web keeps the private key in IndexedDB). Every message gets a fresh key K; the body is encrypted once with XChaCha20-Poly1305(K), and K is sealed with `crypto_box` (authenticated with the sending device's key) for every active device of every member, including the sender's own devices. The server stores ciphertext and sealed keys only, and refuses a message that is not sealed for every current device (`devices_changed`, the client re-encrypts). Reactions, receipts and group system lines are metadata, not encrypted.
  - Known limits of v1: no forward secrecy (a stolen device key opens that device's past messages); a device linked later cannot read older messages (shown as "sent before this device was linked"); key changes are trusted on first use, with safety numbers available in contact info. A ratcheting protocol and encrypted history transfer are planned.

## 3. Database principles
- MySQL 8 (InnoDB, `utf8mb4_0900_ai_ci`); local development works on MariaDB 10.4+.
- **3NF / BCNF inside every service:** every non-key column depends on the whole key and nothing else. No stored totals or copies. "Last message", upload progress, storage use and dashboard numbers are computed with indexed queries.
  - Per-member read/delivered watermarks are facts about each member, not totals.
  - Across services, a few ids are kept on purpose: a message's `sender_id` next to `sender_device_id`, and chat's copy of the read-receipts setting. Each service owns its data and never joins another service's tables; these copies are filled from events.
- Single-database hosting (`DB_SHARED_NAME`) keeps the same tables. The four names that two services share get the service's name in front (`chat_outbox`).
- Lookup values (platforms, roles, privacy audiences) are `ENUM`s or small reference tables.
- Every foreign key is indexed; every list query has a covering composite index matching its `WHERE … ORDER BY`.
- Read receipts use per-member **watermarks** (`last_read_message_id`) instead of one row per message per reader.
- Pagination is **keyset** (`WHERE id < ? ORDER BY id DESC LIMIT ?`), never `OFFSET`.
- Soft delete only where the product needs "This message was deleted"; everything else is hard-deleted.

## 4. Performance
- Nginx `least_conn` load balancing, keep-alive upstreams, HTTP/2, Brotli/gzip, static assets with immutable caching.
- Fastify (fast JSON serialization with schemas), MySQL connection pooling, prepared statements.
- Redis for presence, typing, rate limits, session lookup cache and the Socket.IO adapter.
- WebSocket-only Socket.IO transport (no sticky sessions needed).
- Next.js server components, route-level code splitting, `next/font`, image optimization.

## 5. Repository layout
```
apps/web              Next.js web app (also serves the admin panel at /admin)
apps/mobile           Flutter Android app
services/<name>       One folder per microservice
packages/core         Config, logger, errors, Snowflake IDs, HTTP server bootstrap
packages/db           MySQL pool, transactions, migrations runner, outbox
packages/auth-kit     JWT verification, service tokens, auth hooks
packages/bus          Event bus (Redis Streams; in-process driver for single-process dev)
packages/contracts    Zod schemas and TypeScript types shared by services and web
database/<service>    Versioned SQL migrations per service database
infra                 Docker Compose, Nginx, deployment scripts
docs                  Feature study, architecture, runbooks
```

## 6. Delivery phases
1. **Foundation:** monorepo, infra, schemas, auth + users services, web design system, sign-in/onboarding.
2. **Messaging:** chat + realtime services, E2EE, chat UI (1:1, groups, receipts, reactions, replies, edits, deletes, search).
3. **Media and status:** media service, photos/videos/documents/voice notes, status, polls.
4. **Calls and meetings:** meet service, 1:1/group calls, Meet-style meetings, waiting room, co-hosts, layouts, screen share, chat, hand raise, polls, Q&A, breakout rooms, whiteboard, recording, live streaming.
5. **Android app** (Flutter) with full feature parity, native call ringing, push.
6. **Admin panel, notifications, hardening, deployment** to `talkie.kodofact.com`.

## 7. Hosting requirement
The microservices, Redis and WebSockets need a **VPS with Docker** (Ubuntu 24.04, 4 vCPU / 8 GB to start). Shared cPanel hosting cannot run them. Point `talkie.kodofact.com` at that VPS.

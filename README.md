# Talkie

End-to-end encrypted messaging, calls and meetings, Next.js web app, Flutter Android app, Node.js microservices.

- [Feature study](docs/FEATURE_STUDY.md), what Talkie does, by priority
- [Architecture](docs/ARCHITECTURE.md), services, security, database, performance, phases
- [Databases](database/README.md), one MySQL database per service
- [Design principles](docs/DESIGN.md), Shneiderman's 8 golden rules and the other rules every screen follows
- [Deploying](docs/DEPLOY.md), VPS setup, first deploy, updates, backups, Android release build

## Run locally (Windows)

Requirements: Node.js 22.12+ (22.11 works with the bundled runner), MySQL 8 or MariaDB 10.4+ (XAMPP is fine).

```powershell
npm install
npm run keys:generate      # creates secrets/ (JWT keys) and .env with random secrets
npm run db:migrate         # creates talkie_auth, talkie_users, … and applies migrations
npm run dev                # starts every service + the web app on http://localhost:3000
```

Calls and meetings need a LiveKit server. For local testing, run the bundled one (`tools/livekit`, official release 1.13.11) in its own terminal; the first run adds development keys to `.env`, then restart `npm run dev`:

```powershell
npm run livekit
```

For production, use a LiveKit Cloud project (or self-hosted LiveKit) and set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`. Without them everything else works and the call buttons explain that calls are not set up.

To test calls and meetings against a scripted participant that sends a test tone and colour bars:

```powershell
npm run call-bot                                  # answers your calls
npm run call-bot -- --call <your-username> --video  # calls you
npm run call-bot -- --meet abc-defg-hij           # joins your meeting
```

Without SMTP settings, sign-in codes are printed in the `auth` log line `development sign-in code for …`.

Set `OWNER_EMAILS=you@example.com` in `.env` to get the owner role (it applies at sign-up or at the next sign-in). Staff see **Admin** in the app's side bar: dashboard, people, reports and the audit log at `/app/admin`.

## Checks

```powershell
npm run typecheck          # backend + shared packages
npm run typecheck -w @talkie/web
npm test                   # unit tests
npm run build              # bundles services and builds the web app
npm run e2e:chat           # starts the services and runs 115 end-to-end checks (messaging, groups, files, polls, status, photos, calls, meetings, admin and moderation)
```

To chat with a scripted partner while testing the web app, set `DEV_FIXED_OTP=123456` in `.env` (development only), run `npm run dev`, then:

```powershell
npm run bot -- --to <your-username>
```

## Deploy (VPS with Docker)

```bash
npm run keys:generate && echo "<strong-password>" > secrets/mysql-root.txt
# edit .env: NODE_ENV=production, PUBLIC_ORIGIN=https://talkie.kodofact.com, DB_PASSWORD, SMTP_*, OWNER_EMAILS
docker compose -f infra/docker-compose.yml run --rm certbot certonly --webroot -w /var/www/certbot -d talkie.kodofact.com
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml up -d --scale users=2 --scale auth=2   # more replicas behind Nginx
```

## Repository

| Path | What |
|---|---|
| `apps/web` | Next.js 16 web app (landing, sign-in, app shell, settings) |
| `apps/mobile` | Flutter Android app (phase 5) |
| `services/auth` | Email codes, sign-up, sessions, refresh-token rotation, linked devices, device keys |
| `services/users` | Profiles, usernames, privacy, contacts, blocks, reports |
| `services/notify` | Email delivery, push tokens |
| `services/chat` | Direct chats, groups, invite links, encrypted messages, receipts, reactions, pins, stars, disappearing messages |
| `services/realtime` | WebSocket live updates, presence (online / last seen), typing |
| `services/meet` | Calls (1:1 and group, ringing, busy, missed, end-to-end encrypted media keys) and meetings (waiting room, co-hosts, host controls, chat, polls, Q&A, breakout rooms, recording, live streaming, attendance); LiveKit tokens and webhooks |
| `services/media` | Encrypted file uploads in 8 MB parts (resumable, up to 2 GB), downloads with byte ranges, profile/group photos (re-encoded 640 px JPEG); local disk or S3-compatible storage |
| `packages/e2ee` | End-to-end encryption shared by the web app and tests |
| `packages/*` | Shared service framework, database, auth verification, event bus, API contracts |
| `database/*` | SQL migrations per service |
| `infra` | Dockerfiles, Compose stack, Nginx load balancer |

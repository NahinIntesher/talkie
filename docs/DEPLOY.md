# Deploying Talkie to talkie.kodofact.com

Talkie can be hosted in two ways:
- **On a VPS with Docker** (sections 1–7). Separate containers, Redis, and it can scale.
- **On cPanel's "Setup Node.js App"** (section 8). Everything runs in one Node.js process next to cPanel's MySQL, with no VPS needed. It suits a first launch with a small number of people.

Talkie runs as a Docker Compose stack on one Linux VPS:
- nginx (TLS and load balancing)
- the web app
- the eight services
- MySQL and Redis

Calls and meetings go through **LiveKit Cloud**, so the VPS never carries audio or video.

```
Internet ──443──▶ nginx ──▶ web · auth · users · chat · realtime(/ws) · media · meet · notify · admin
                                   │                                         │
                                MySQL 8 (talkie_* databases)           Redis 7 (events, presence, rate limits)
Phones/browsers ──WebRTC──▶ LiveKit Cloud (calls and meetings)
```

## 1. What you need

| | |
|---|---|
| **VPS** | Ubuntu 24.04, 4 vCPU, 8 GB RAM, 80 GB SSD to start (Hetzner, DigitalOcean, Vultr, Contabo …). Shared cPanel hosting cannot run this. |
| **DNS** | An `A` record `talkie.kodofact.com → <VPS IPv4>` (and `AAAA` if the VPS has IPv6). |
| **Email (SMTP)** | Sends the sign-in codes. Amazon SES, Brevo, Mailgun, Zoho, or a mailbox on your cPanel host. |
| **LiveKit Cloud** | A project at cloud.livekit.io. You need its URL (`wss://…livekit.cloud`), an API key and the API secret. |
| **Storage (optional)** | Cloudflare R2 / Backblaze B2 / S3 for uploads. Without it, files stay in a Docker volume on the VPS. |

## 2. Set up the server (once)

```bash
ssh you@<vps-ip>
git clone <your Talkie repository> talkie && cd talkie
sudo bash infra/scripts/bootstrap-vps.sh     # Docker, firewall (22/80/443 only), auto security updates, swap
exit                                          # log in again so your user can run docker
```

## 3. First deploy

```bash
cd talkie
bash infra/scripts/deploy.sh                  # creates secrets/ and .env, then stops
nano .env                                     # fill in OWNER_EMAILS, SMTP_*, LIVEKIT_*
LETSENCRYPT_EMAIL=you@example.com bash infra/scripts/deploy.sh
bash infra/scripts/install-cron.sh            # nightly backups + certificate renewal
```

The second run of `deploy.sh` does the rest:
1. Gets the TLS certificate.
2. Builds the images.
3. Applies the database migrations.
4. Starts everything.
5. Waits for `https://talkie.kodofact.com` to answer.

Then:
1. Open the site and sign up with the email you put in `OWNER_EMAILS`. You become the owner.
2. The **Admin** item appears in the app's side bar.
3. In LiveKit Cloud → Settings → Webhooks, add `https://talkie.kodofact.com/api/meet/livekit/webhook`. Talkie uses it to know when calls and meetings end.

## 3b. Using a hosted (cPanel) database instead of the bundled MySQL

Set these in `.env`. When `DB_HOST` is set, `deploy.sh` does not start the MySQL container.

```
DB_HOST=s11642.sgp1.stableserver.net
DB_PORT=3306
DB_USER=kodofact_nahin
DB_PASSWORD=…
DB_SHARED_NAME=kodofact_talkie
```

**One database (`DB_SHARED_NAME`).** Every service uses the same database. Four table names exist in more than one service (`outbox`, `processed_events`, `schema_migrations`, and meetings' `poll_votes`), so in this mode they get the service's name in front, like `chat_outbox` and `meet_poll_votes`. Nothing else changes.

**One database per service (`DB_NAME_PREFIX=kodofact_talkie_`).** Create `kodofact_talkie_bus`, `_auth`, `_users`, `_chat`, `_media`, `_meet`, `_notify` and `_admin` in cPanel, and give the user All Privileges on each.

In both cases:
1. In **cPanel → Remote MySQL**, add the VPS's public IP address. After you add a database or change privileges, delete that host and add it again. cPanel only copies privileges to remote hosts when the host is added.
2. `deploy.sh` creates and updates the tables on every deploy.

Things to know about a hosted database:
- **Backups:** `backup.sh` backs up only media files, so use cPanel's own backups for the database.
- **Location:** keep the VPS in the same region as the database host (here: Singapore). Every request makes several database queries, and distance adds delay to each one.
- **Encryption in transit:** the connection is not encrypted (`DB_SSL=false`). If the host supports TLS for MySQL, turn it on.
- **Password:** do not use `$` in it, because Docker Compose would read it as a variable.

## 4. Updating

```bash
cd talkie && git pull && bash infra/scripts/deploy.sh
```

Migrations run before the new containers start. Each migration adds new columns or tables; none renames or drops anything an older container still uses.

## 5. Day-to-day

| Task | Command (from the `talkie` folder) |
|---|---|
| Status | `docker compose -f infra/docker-compose.yml ps` |
| Logs (one service) | `docker compose -f infra/docker-compose.yml logs -f --tail=200 chat` |
| More capacity for one service | `docker compose -f infra/docker-compose.yml up -d --scale chat=3 --scale realtime=2` |
| Backup now | `bash infra/scripts/backup.sh --media` |
| Restore a database backup | `gunzip -c /var/backups/talkie/db-<stamp>.sql.gz \| docker compose -f infra/docker-compose.yml exec -T mysql sh -c 'mysql -uroot -p"$(cat /run/secrets/mysql_root)"'` |
| Make someone a moderator/admin | Admin panel → People → the person → Change role (owner only) |

Notes on scaling:
- nginx spreads requests across every replica (`least_conn`).
- Each replica gets its own ID generator automatically (`WORKER_ID=auto`).
- With `STORAGE_DRIVER=disk`, keep `media` at one replica. Move to S3/R2 before scaling it.

Backups:
- They are written to `/var/backups/talkie` and kept for 14 days.
- **Also copy that folder off the server** (rclone to R2/Drive, or `scp` to another machine).
- Message contents are end-to-end encrypted, so a database backup holds only ciphertext.

## 6. Security checklist

- [ ] `.env` has `NODE_ENV=production`. It has no `DEV_FIXED_OTP` line, and `DEV_LOG_OTP=false`. `deploy.sh` refuses to run otherwise.
- [ ] `secrets/` and `.env` exist only on the server. Both are in `.gitignore` and `.dockerignore`.
- [ ] Only ports 22, 80 and 443 are open (`sudo ufw status`). MySQL and Redis are not published.
- [ ] SSH uses keys. Set `PasswordAuthentication no` in `/etc/ssh/sshd_config`.
- [ ] The offsite backup copy is set up and has been restored once as a test.
- [ ] Admin roles are given only to people who need them. Every admin action is in **Admin → Audit log**.

## 7. Android release build

1. Create the upload key once and keep it safe. If it is lost, updates to the Play Store listing can no longer be signed.

   ```powershell
   & F:\SDKs\jdk21\bin\keytool -genkeypair -v -keystore D:\Projects\Talkie\apps\mobile\android\talkie-upload.jks -keyalg RSA -keysize 4096 -validity 10000 -alias talkie
   ```

2. Create `apps/mobile/android/key.properties`. It is git-ignored.

   ```properties
   storeFile=talkie-upload.jks
   storePassword=<the password you chose>
   keyAlias=talkie
   keyPassword=<the password you chose>
   ```

3. Build. Release builds talk to `https://talkie.kodofact.com` by default.

   ```powershell
   ./scripts/flutter.ps1 build appbundle --release     # for Google Play (.aab)
   ./scripts/flutter.ps1 build apk --release --split-per-abi   # direct-download APKs
   ```

Without `key.properties`, release builds are signed with the debug key. That is fine for testing, but the Play Store will not accept them.

## 8. cPanel (Setup Node.js App)

The upload holds:
- `app.cjs`: one entry file, running three processes:
  - **The gateway:** listens on the app's port and does nginx's job.
  - **A child process:** runs the eight services on `127.0.0.1`.
  - **A second child process:** runs the Next.js web app.
- **Why child processes:** LiteSpeed (lsnode) ignores every `listen()` after the first one in the app's own process.
- **Sleep and wake:** each child exits when the gateway goes away, so the app sleeps and wakes cleanly.
- The tables are created or updated automatically every time the app starts.
- Events between services are passed in memory (`BUS_DRIVER=process`).

### First time
1. **Subdomain:** cPanel → **Domains** → create `talkie.kodofact.com`.
2. **HTTPS:** cPanel → **SSL/TLS Status** → select `talkie.kodofact.com` → **Run AutoSSL**.
3. **Settings:**
   - Fill in `.env.hosted` on your PC: `SMTP_PASSWORD`, `LIVEKIT_API_SECRET` and `OWNER_EMAILS`.
   - The database lines are already set: `DB_HOST=localhost`, `DB_SHARED_NAME=kodofact_talkie`.
4. **Build:** on your PC, run `npm run build:cpanel`. It creates `build/talkie-cpanel.zip`.
5. cPanel → **Setup Node.js App** → **Create Application**:
   - Node.js version: the newest **22.x** (20.11 at least)
   - Application mode: **Production**
   - Application root: `talkie`
   - Application URL: `talkie.kodofact.com`
   - Application startup file: `app.cjs`
6. cPanel → **File Manager** → open the `talkie` folder → **Upload** `talkie-cpanel.zip` → **Extract** → delete the zip.
7. Back in **Setup Node.js App**: **Run NPM Install**, then **Restart**.
8. Open `https://talkie.kodofact.com` and sign up with the email in `OWNER_EMAILS`. You become the owner, and **Admin** appears in the side bar.
9. In LiveKit Cloud → Settings → Webhooks, add `https://talkie.kodofact.com/api/meet/livekit/webhook`.

### Updating
**Easiest: `git pull` (once set up).** Every push to `main` is built on Linux by GitHub Actions and committed to the `cpanel` branch, ready to run.

One-time setup, in cPanel → Terminal, inside the app folder:
```bash
git init && git remote add origin https://github.com/NahinIntesher/talkie.git
bash -c "git fetch origin cpanel && git reset --hard origin/cpanel"
```

Every update after that:
```bash
bash update.sh
```

`update.sh` fetches the deployment branch, runs `npm install` when `package.json` changes, and requests a restart. Keep the app running while you update. `.env`, `secrets/`, `node_modules/` and `data/` are git-ignored there, so updates preserve them.

After updating, open `/api/health` on the deployed domain. Its `revision` should match the `Source` line from the update script and the services should show `up`. The `Code` line identifies the deployment branch checkout. If the revision stays old, use **Restart** in **Setup Node.js App** and check again. If services stay down, check the app folder's `talkie.log` and cPanel **Resource Usage**. A response from Imunify360 means the request was blocked before reaching Talkie.

**Without git: the Linux build as a download.** Every push to `main` builds the upload on Linux, the same OS as the server:
1. Open GitHub → **Actions** → **cPanel build** → the latest green run → **Artifacts** → `talkie-cpanel`.
2. Download it. It's a zip of the app folder.
3. Upload it to the app folder in cPanel and **Extract**.
4. Then **Restart**. If `package.json` changed, also run **Run NPM Install**.

This zip holds code only (no `.env`, no `secrets/`), so the server keeps its own settings and keys. Only the first install needs the full local build (`npm run build:cpanel`), which includes them.

1. Run `npm run build:cpanel`. If only the services changed, `npm run build:cpanel -- --skip-web` is faster.
2. Upload the zip to `talkie` and **Extract**, overwriting the old files.
3. Then **Restart**. Also run **Run NPM Install** if `package.json` changed.
4. Uploaded files live in `talkie/data/` (not in the zip), so updates never touch them.

Keep `secrets/hosted/` on your PC. It holds the sign-in signing key, and every build reuses it. If it is lost, everyone has to sign in again.

### Good to know on shared hosting
- **Logs:** they are in `talkie/stderr.log` (or via the Node.js App page).
- **Memory:** the app needs roughly 600–900 MB of RAM. If it keeps restarting, check **Resource Usage** in cPanel and ask the host for a higher limit.
- **Live updates:** messages, typing and presence use WebSockets on `/ws`. If chats only update after a refresh, ask the host to allow WebSockets for Node.js apps.
- **Sleeping:** the server may put the app to sleep when nobody uses it. The first visit after that takes a few seconds to wake it.
- **Backups:** cPanel → **Backup** saves the database and the `talkie` folder, which includes the uploaded files in `talkie/data/`.
- **Outgrowing it:** when Talkie outgrows shared hosting, move to the VPS setup (sections 1–7). The same database and `.env` values carry over.


## 9. Push notifications (Firebase)

Push notifications keep end-to-end encryption intact: a notification says who wrote and what kind of message it is (📷 Photo, 🎤 Voice message, incoming call), never the text. Muted chats, each person's notification switches and signed-out devices are respected.

Everything below comes from the Firebase project (`talkie-fd138`) → **Project settings**.

| What | Where in Firebase | Where it goes |
|---|---|---|
| Android config | **General** → Android app `com.kodofact.talkie` → `google-services.json` | `apps/mobile/android/app/google-services.json` (git-ignored). Then rebuild the app. |
| Server key | **Service accounts** → **Generate new private key** (a JSON file) | `secrets/hosted/firebase-service-account.json`. `npm run build:cpanel` includes it. Alternatively, paste the JSON into the cPanel variable `FIREBASE_SERVICE_ACCOUNT`. |
| Web push key | **Cloud Messaging** → **Web Push certificates** → **Generate key pair** | `.env.hosted` → `NEXT_PUBLIC_FIREBASE_VAPID_KEY=…`, then `npm run build:cpanel` |

- Without the server key, the app works normally, just without push. The log says `push notifications are off`.
- Treat the service-account key like a password: never commit it, never share it.
- People turn notifications on in the app. On Android, permission is requested after sign-in. On the web, use the "Turn on notifications" bar.

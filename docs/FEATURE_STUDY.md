# Talkie — Feature study and requirements

Talkie is a Next.js web app and a Flutter mobile app (Android + iOS) with two halves:

1. **Messaging** that works the way WhatsApp messaging works.
2. **Meetings / live streaming** that work the way Google Meet works.

It is an original product: it copies *behaviour*, not names, logos, icons, colours or text of WhatsApp or Google Meet.

Researched 24 Nov 2026 from WhatsApp's blog and Meta newsroom, Google's Workspace edition matrix and Meet product page, and third-party reviews (sources at the end). Where Diganta (`F:\Diganta`) already does something, it is marked **[D]** — that code is a starting point, not a finished feature.

Priority: **P1** = first release, **P2** = second release, **P3** = later / optional.

---

## Decisions so far (24 Nov 2026)

| Topic | Decision | What it means |
|---|---|---|
| Sign-up | **Email OTP + username** | No SMS gateway. People find each other by username (and QR/invite link), not by phone contacts. Phone-book contact discovery (A1) is dropped. |
| Encryption | **Full end-to-end encryption** | Proposed: Olm (1:1, per device) + Megolm (groups) through **vodozemac**, which has both a Dart (Flutter) and a WASM (web) build. Server stores only ciphertext. Each linked device has its own keys; new devices get history via key backup protected by a recovery key/passphrase. Server-side message search is not possible — search runs on each device. Media files are encrypted on the device before upload. 1:1 and group **chat calls** use LiveKit E2EE. |
| Media server | **LiveKit Cloud** | No media VPS, TURN or Egress server to run. Recording, YouTube streaming and noise cancellation come from LiveKit Cloud (usage-billed). |
| Size | **Small: under 1,000 users** | One VPS for API + database + Redis; object storage for files. Meetings up to ~100 people. |

**Consequence to accept:** Meet-style meetings that need **recording, live captions, transcripts, AI notes or YouTube streaming** cannot be end-to-end encrypted, because the server must see the media to do those things (Google Meet works the same way). Proposal: chat calls are always E2EE; a meeting is E2EE only when the host turns it on, and then recording/captions/streaming are switched off for that meeting.

---

## Part A — Messaging (WhatsApp-style)

### A1. Account and identity
| Feature | Priority | Notes |
|---|---|---|
| Sign up with phone number + SMS OTP | P1 | Needs an SMS provider. Alternative: email OTP (cheaper). |
| Profile: name, photo, about/bio | P1 | [D] bio, photo |
| Username (3–35 chars) so people can chat without sharing a phone number; optional username key | P2 | WhatsApp rolling this out in 2026 |
| Contact discovery from the phone's address book | P1 | Hash numbers before upload |
| Passkey / biometric login, two-step PIN | P2 | [D] has TOTP MFA |
| Multiple accounts on one phone, account switcher | P3 | |
| Linked devices: web/desktop/tablet keep working while phone is offline (up to 4) | P1 | [D] has 3-device sessions, but not linked-device sync |
| Delete account, export my data | P1 | Store/Play policy requirement |

### A2. One-to-one chat
| Feature | Priority | Notes |
|---|---|---|
| Text, emoji, links with preview | P1 | [D] text, emoji |
| Single tick / double tick / blue tick (sent, delivered, read); read receipts can be turned off | P1 | [D] ticks |
| Online / last seen / typing… / recording audio… | P1 | [D] presence, typing |
| Reply (quote), forward (with "Forwarded" / "Forwarded many times"), copy | P1 | [D] reply, forward |
| Edit within 15 min, delete for me / delete for everyone | P1 | [D] |
| Reactions on any message | P1 | [D] |
| Star messages, pin up to 3 messages (24 h / 7 d / 30 d / forever) | P1 | [D] star, pin |
| Search inside chat and across all chats; filter by media/links/docs | P1 | [D] per-chat search |
| Voice notes with waveform, play speed 1×/1.5×/2×, listen before sending, locked recording | P1 | [D] voice notes |
| Photos & videos (HD option), albums, camera, captions, crop/draw/text/stickers editor | P1 | [D] attachments up to 5 MB — must go up to 2 GB with chunked upload |
| Documents up to 2 GB | P1 | |
| Location share and **live location** (15 min / 1 h / 8 h) | P2 | Needs maps SDK |
| Contact cards | P2 | |
| Polls (single/multi choice, anonymous, timed) | P2 | |
| Events with RSVP and reminders | P3 | |
| Stickers, GIFs, text-to-sticker, custom sticker packs | P2 | GIF provider API needed |
| View-once photo/video/voice | P2 | |
| Disappearing messages (24 h / 7 d / 90 d), default timer for new chats | P2 | |
| Chat lock (fingerprint/secret code), archive, mute (8 h / 1 wk / always), mark unread, pin chat, block, report | P1 | [D] mute |
| Chat list filters: All, Unread, Favourites, Groups, custom lists, Mentions & replies | P2 | |
| Chat wallpaper/theme per chat | P2 | [D] chat themes |
| Draft saving, scheduled messages | P3 | |
| Message translation | P3 | Paid API |
| Manage storage (find & delete big files per chat), auto-download rules per network | P2 | |
| Chat backup & restore (Google Drive / iCloud, encrypted) and chat export | P2 | Depends on E2EE choice |

### A3. Groups
| Feature | Priority | Notes |
|---|---|---|
| Create group (up to 1024 members), name, photo, description | P1 | [D] groups (admin-only creation) |
| Admins: add/remove, make admin, approve new members, invite link / QR, who can edit info, who can send messages | P1 | [D] join requests, post policy |
| @mentions and @all | P1 | |
| Member tags (custom per-group label) | P3 | 2026 feature |
| Group polls, events | P2 | |
| Send recent history to a newly added member | P3 | 2026 feature |
| Per-member read info ("Read by" list) | P1 | [D] |
| Group status (status visible only inside a group) | P3 | 2026 feature |
| Leave quietly, exit and delete | P1 | |

### A4. Communities, broadcast lists and channels
| Feature | Priority | Notes |
|---|---|---|
| Community = umbrella of many groups + one announcement group | P2 | |
| Broadcast list (one-to-many, replies come back privately) | P2 | |
| Channels: one-way public broadcast, followers, reactions, polls, questions, admin QR code, directory | P3 | |

### A5. Status (stories)
| Feature | Priority | Notes |
|---|---|---|
| Text / photo / video / voice status, disappears after 24 h | P2 | |
| Who saw it, reply privately, react, mute someone's status | P2 | |
| Privacy: My contacts / except… / only share with… | P2 | |

### A6. Calls (inside messaging)
| Feature | Priority | Notes |
|---|---|---|
| 1:1 voice & video call; ringing on a locked phone (CallKit on iOS, full-screen intent on Android) | P1 | [D] calls work in the app, but no native ringing on a locked phone |
| Group calls up to 32 people; add people during a call | P1 | [D] group calls up to 30 |
| Call links, scheduled calls, guest join without an account | P2 | |
| Screen sharing, call reactions, raise hand, video effects/backgrounds, low-light mode | P2 | [D] screen share |
| Switch voice ↔ video, front/back camera, speaker/bluetooth, picture-in-picture | P1 | |
| Busy, missed call, call history tab, call back, "silence unknown callers" | P1 | [D] busy, missed |
| Move an ongoing call between phone and web | P3 | |

### A7. Privacy and security
| Feature | Priority | Notes |
|---|---|---|
| **End-to-end encryption** of messages, media, calls | P1 | Decided: yes (see Decisions) |
| Security code / safety number verification | with E2EE | |
| Privacy settings for last seen, online, photo, about, status, groups (who can add me), read receipts | P1 | |
| Advanced chat privacy (block export and auto-download per chat) | P3 | |
| Limits on how many new people one account can message per day; spam reporting | P1 | Anti-abuse |

---

## Part B — Meetings and live streaming (Google Meet-style)

### B1. Creating and joining
| Feature | Priority | Notes |
|---|---|---|
| Instant meeting, meeting for later, scheduled meeting with a link and code (e.g. `abc-defg-hij`) | P1 | [D] scheduled live class per course |
| Join from link/code in a browser with no install; mobile app join | P1 | |
| Green room / pre-join preview: camera, mic, speaker test, choose devices, backgrounds | P1 | [D] device selection |
| Calendar invite with RSVP (.ics, Google Calendar), reminders | P2 | |
| Guests without an account (name only) | P2 | |
| Phone dial-in (number + PIN) | P3 | Needs a SIP/telephony provider — costs money per minute |
| Companion mode (second device for chat/polls/hand-raise, no echo) | P3 | |

### B2. Host controls and safety
| Feature | Priority | Notes |
|---|---|---|
| Waiting room / "ask to join", admit one or all, auto-admit rules (open / trusted / restricted) | P1 | [D] |
| Host and **co-hosts** | P1 | [D] only one host |
| Lock meeting; host can control who can share screen, chat, unmute, turn on video, react | P1 | [D] lock, mic/screen permissions |
| Mute one / mute all, turn off someone's camera, remove, block from rejoining | P1 | [D] |
| End meeting for everyone | P1 | [D] |
| Report/abuse, external-guest labels | P2 | |

### B3. In the meeting
| Feature | Priority | Notes |
|---|---|---|
| Layouts: Auto, Tiled (up to 49 tiles), Spotlight, Sidebar; pin, unpin, multi-pin; hide self view; hide tiles without video | P1 | [D] pin local video |
| Active-speaker detection | P1 | LiveKit gives this |
| Screen share (tab / window / whole screen), share tab audio, present-to-all, multiple presenters | P1 | [D] |
| In-meeting chat with links/files | P1 | [D] |
| Emoji reactions, raise hand queue (in order, host lowers hands) | P1 | [D] |
| Polls (host creates, results shown/hidden) | P2 | |
| Q&A (ask, upvote, mark answered) | P2 | |
| Breakout rooms (auto/manual assign, timer, broadcast message, ask-for-help, move people) | P2 | Separate media rooms |
| Whiteboard (shared, multi-user drawing, export PNG/PDF) | P2 | Can use tldraw/Excalidraw (open source) |
| Background blur, image backgrounds, own image | P2 | MediaPipe / LiveKit track processors |
| Noise cancellation | P2 | Krisp (LiveKit Cloud paid) or RNNoise (free, self-host) |
| Picture-in-picture, full screen, low-bandwidth / audio-only mode, connection quality indicator | P1 | [D] full screen |
| Video tile pairing (sign-language interpreter next to speaker) | P3 | |

### B4. Recording, captions, AI
| Feature | Priority | Notes |
|---|---|---|
| Cloud recording (up to 1080p), everyone notified, saved to storage, download/share link | P2 | LiveKit Egress |
| Attendance report (name, join/leave, minutes) | P1 | [D] |
| Live captions | P2 | Speech-to-text API — paid per minute, or self-hosted Whisper (needs a GPU) |
| Transcript saved after meeting | P2 | Same as captions |
| Translated captions / speech translation | P3 | Paid API |
| AI notes: summary, action items, "take notes for me" | P3 | LLM API (e.g. Claude) — paid per use |

### B5. Live streaming
| Feature | Priority | Notes |
|---|---|---|
| View-only live stream inside Talkie for large audiences (Meet allows 10,000–100,000 viewers) | P2 | Viewers get HLS through a CDN, not WebRTC |
| Stream to YouTube / Facebook (RTMP) | P2 | LiveKit Egress |
| Live chat + reactions + Q&A for viewers | P2 | |
| Replay after the stream | P3 | |

### B6. Limits to aim for (Google Meet reference)
- Free plan: 100 people, 60-minute group meetings; 1:1 no limit.
- Paid: 150–1,000 people, 24-hour meetings; above 500 the rest are view-only.
- Talkie first version: up to ~100 people per meeting, 24-hour meetings, streaming viewers limited by the LiveKit Cloud plan.

---

## Part C — What you need to host it

### C1. Servers

**With the decisions above you need only:** one VPS (4 vCPU / 8 GB / 160 GB SSD, Ubuntu 24.04) for API + PostgreSQL + Redis, S3-compatible object storage, a domain with HTTPS, and a LiveKit Cloud project. The media, TURN and Egress rows below are only for a later move to self-hosting.
| Item | Why | Rough size to start |
|---|---|---|
| **VPS** (Ubuntu 24.04), not shared cPanel hosting | WebRTC needs UDP ports and long-running processes; cPanel cannot run them | API + DB: 4 vCPU / 8 GB RAM / 160 GB SSD |
| **Media server (LiveKit SFU)** on its own VPS, or LiveKit Cloud | Carries all call/meeting audio & video | 4–8 vCPU / 8–16 GB, good bandwidth (1 Gbps), public IP |
| **TURN server** (coturn, or LiveKit's built-in TURN) | People behind strict mobile/office networks can't connect without it | Can run on the media VPS; port 443 TLS + 3478 UDP |
| **Recording / streaming worker (LiveKit Egress)** | Recording and YouTube streaming; heavy on CPU | 4+ vCPU, only when recording/streaming is used |
| Domain name + DNS | e.g. `talkie.example.com`, `api.`, `media.`, `turn.` subdomains | |
| SSL/TLS certificates | Browsers block camera/mic and WebRTC without HTTPS | Free with Let's Encrypt / Caddy |

Ports to open on the media server: 443 TCP, 7881 TCP, 3478 UDP, 50000–60000 UDP.

### C2. Software stack (proposed)
| Layer | Choice |
|---|---|
| Web | Next.js (App Router, TypeScript), LiveKit web SDK |
| Mobile | Flutter (Android + iOS), `livekit_client`, `flutter_callkit_incoming`, `firebase_messaging` |
| API | Node.js (NestJS or Express, TypeScript) — Express matches Diganta |
| Realtime | Socket.IO / WebSocket gateway with a Redis adapter so it can run on more than one server |
| Database | PostgreSQL (or MySQL like Diganta) |
| Cache / presence / queues | Redis |
| Media files | S3-compatible object storage (Cloudflare R2, Backblaze B2, Wasabi, or self-hosted MinIO) + CDN |
| Media processing | FFmpeg (video thumbnails/compression), libvips/sharp (images) |
| Search | PostgreSQL full-text search first; Meilisearch later |
| Process manager / deploy | Docker Compose + Caddy/Nginx reverse proxy |
| Monitoring / logs | Uptime Kuma, Grafana + Prometheus or a hosted service; Sentry for app crashes |
| Backups | Nightly encrypted database + object storage backup, kept off the server |

### C3. Third-party accounts and keys
| Service | Why | Cost |
|---|---|---|
| Firebase project (FCM) | Push notifications on Android and web | Free |
| Apple Developer Program | iOS app, APNs push, **PushKit VoIP** for ringing calls | USD 99 / year |
| Google Play Console | Android app | USD 25 once |
| Transactional email provider (e.g. Resend, Brevo, Amazon SES, Mailgun) | **Email OTP sign-up** — must deliver fast and not land in spam; needs SPF/DKIM/DMARC on your domain | Free tier usually enough for <1,000 users |
| **LiveKit Cloud** project (URL, API key, API secret) | All calls, meetings, recording, streaming, noise cancellation | Free tier, then usage-based |
| Speech-to-text (optional) | Captions, transcripts | Per minute |
| LLM API (optional) | AI meeting notes, summaries | Per use |
| Maps SDK (optional) | Location / live location | Free tier |
| GIF API (optional) | GIF picker | Free tier |

---

## Part D — Reuse from Diganta

Diganta already has working code for: 1:1 and group chat, reactions, pins, stars, reply/forward, edit/delete time windows, ticks, typing, presence, voice notes, attachments, mute, search, chat themes, LiveKit 1:1 and group calls (up to 30), live classroom with waiting room, lock, mute/remove, raise hand, chat, reactions, attendance, Socket.IO realtime, FCM push, MFA, device limits.

It is tied to coaching roles (admin/moderator/teacher/student) and courses, stores messages in plain text, keeps typing/ring timers in one server's memory, and scans whole tables in places. Talkie should **reuse ideas and selected modules, not fork the whole project**.

---

## Sources
- WhatsApp: [9to5Mac — four new group features (Oct 2026)](https://9to5mac.com/2026/10/30/whatsapp-announces-four-new-features-to-make-group-chats-easier-to-manage/), [Meta newsroom — storage, account switching (Mar 2026)](https://about.fb.com/news/2026/03/whatsapp-new-features-simplify-storage-switch-accounts/), [WhatsApp blog — member tags, text stickers, event reminders](https://blog.whatsapp.com/level-up-your-whatsapp-group-chats-with-new-member-tags-text-stickers-and-more), [Al Jazeera — usernames and privacy (Jun 2026)](https://www.aljazeera.com/news/2026/6/30/what-privacy-settings-has-whatsapp-changed), [WhatsApp blog — group chats, events, calls, channels](https://blog.whatsapp.com/new-feature-roundup-updates-to-group-chats-events-calls-channels-and-more?lang=en), [Roklo — 2026 feature list (secondary)](https://www.roklo.ai/blog/whatsapp-new-features-2026)
- Google Meet: [Compare Meet features across Workspace editions (official)](https://knowledge.workspace.google.com/admin/meet/compare-meet-features-across-google-workspace-editions), [Google Meet product page](https://workspace.google.com/products/meet/), [Workspace blog — Meet admin guide](https://www.workspaceblog.in/blog/google-meet-enterprise-admin-guide/), [Docam — Meet tips (secondary)](https://docam.io/knowledge/google-meet-tips-and-tricks)
- LiveKit hosting: [Ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/), [Deployment](https://docs.livekit.io/transport/self-hosting/deployment/)

import { z } from 'zod';

// ───────── Shared field rules (used by services for validation and by clients for instant feedback) ─────────

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const DISPLAY_NAME_MAX = 64;
export const ABOUT_MAX = 140;
export const OTP_LENGTH = 6;
export const MAX_LINKED_DEVICES = 3;

export const id = z.string().regex(/^[1-9]\d{0,19}$/, 'Invalid id');

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('Enter a valid email address'));

/** Lowercase letters, digits, dot and underscore; no leading/trailing dot, no double dots. */
export const username = z
  .string()
  .trim()
  .toLowerCase()
  .min(USERNAME_MIN, `At least ${USERNAME_MIN} characters`)
  .max(USERNAME_MAX, `At most ${USERNAME_MAX} characters`)
  .regex(/^[a-z0-9._]+$/, 'Use only letters, numbers, dot and underscore')
  .refine((value) => !value.startsWith('.') && !value.endsWith('.') && !value.includes('..'), 'Dots cannot be at the start, end or next to each other')
  .refine((value) => /[a-z]/.test(value), 'Include at least one letter');

export const displayName = z
  .string()
  .trim()
  .min(1, 'Enter your name')
  .max(DISPLAY_NAME_MAX, `At most ${DISPLAY_NAME_MAX} characters`)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Remove special control characters');

export const about = z.string().trim().max(ABOUT_MAX, `At most ${ABOUT_MAX} characters`);

export const otpCode = z.string().trim().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `Enter the ${OTP_LENGTH}-digit code`);

export const platform = z.enum(['web', 'android', 'ios', 'desktop']);
export type Platform = z.infer<typeof platform>;

export const locale = z.enum(['bn', 'en']);
export type Locale = z.infer<typeof locale>;

/** Base64url Curve25519 public key (32 bytes). */
export const publicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid public key');

export const device = z.object({
  name: z.string().trim().min(1).max(80),
  platform,
  /** Device identity key for end-to-end encryption, generated on the device. */
  identityKey: publicKey.optional(),
});

// ───────── Auth API ─────────

const otpRequestKey = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const otpRequest = z.object({ email, locale: locale.default('bn'), requestKey: otpRequestKey.optional() });
export const otpVerify = z.union([
  z.object({ challengeId: id, code: otpCode, device }),
  z.object({ requestKey: otpRequestKey, code: otpCode, device }),
]);
export const signupComplete = z.object({ signupToken: z.string().min(20).max(512), username, displayName, device });
export const usernameCheck = z.object({ username });

export interface OtpRequested {
  challengeId: string;
  expiresAt: string;
  resendAfterSeconds: number;
  delivery?: 'sent' | 'uncertain';
}

export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  /** Only returned to native apps; web receives it as an HttpOnly cookie. */
  refreshToken?: string;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  about: string;
  avatarUrl: string | null;
  createdAt: string;
}

export interface Me extends PublicUser {
  email: string;
  locale: Locale;
  role: 'user' | 'moderator' | 'admin' | 'owner';
}

export type OtpVerified =
  | { status: 'signed_in'; user: Me; tokens: SessionTokens; deviceId: string }
  | { status: 'needs_signup'; signupToken: string; email: string };

export interface DeviceInfo {
  id: string;
  name: string;
  platform: Platform;
  current: boolean;
  createdAt: string;
  lastActiveAt: string;
}

// ───────── Users API ─────────

export const privacyAudience = z.enum(['everyone', 'contacts', 'nobody']);
export type PrivacyAudience = z.infer<typeof privacyAudience>;

export const privacyKey = z.enum(['last_seen', 'online', 'profile_photo', 'about', 'status', 'groups_add']);
export type PrivacyKey = z.infer<typeof privacyKey>;

export const profileUpdate = z
  .object({ displayName: displayName.optional(), about: about.optional(), locale: locale.optional() })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const privacyUpdate = z.object({
  settings: z.array(z.object({ key: privacyKey, audience: privacyAudience })).min(1).max(6).optional(),
  readReceipts: z.boolean().optional(),
});

export const userReport = z.object({
  reason: z.enum(['spam', 'harassment', 'impersonation', 'inappropriate', 'other']),
  note: z.string().trim().max(500).default(''),
});

export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

// ───────── Chat API ─────────

export const GROUP_NAME_MAX = 100;
export const GROUP_DESCRIPTION_MAX = 2048;
export const GROUP_MAX_MEMBERS = 1024;
export const EDIT_WINDOW_MS = 15 * 60_000;
export const DELETE_FOR_EVERYONE_WINDOW_MS = 48 * 3_600_000;
export const MAX_PINS = 3;
export const DISAPPEARING_OPTIONS = [86_400, 604_800, 7_776_000] as const;

/** Base64url without padding (libsodium's default). */
export const b64 = (maxChars: number) => z.string().regex(/^[A-Za-z0-9_-]*$/, 'Invalid encoding').max(maxChars);

export const messageKind = z.enum(['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'poll']);
export type MessageKind = z.infer<typeof messageKind> | 'system' | 'call';

/** 26-character client-generated id; the same id sent twice creates one message. */
export const clientMessageId = z.string().regex(/^[0-9A-Za-z]{26}$/, 'Invalid client message id');

export const sealedKeys = z
  .array(z.object({ deviceId: id, sealedKey: b64(200) }))
  .min(1)
  .max(GROUP_MAX_MEMBERS * 5); // Allow cached pre-upgrade device lists. Services filter revoked devices.

export const sendMessage = z.object({
  clientMessageId,
  kind: messageKind,
  ciphertext: b64(140_000),
  nonce: b64(40),
  keys: sealedKeys,
  replyToId: id.optional(),
  forwardedCount: z.number().int().min(0).max(255).default(0),
  /** Uploaded (encrypted) files this message carries; their keys travel inside the ciphertext. */
  mediaIds: z.array(id).max(10).default([]),
});

export const editMessage = z.object({ ciphertext: b64(140_000), nonce: b64(40), keys: sealedKeys });

export const createGroup = z.object({
  name: z.string().trim().min(1).max(GROUP_NAME_MAX),
  description: z.string().trim().max(GROUP_DESCRIPTION_MAX).default(''),
  memberIds: z.array(id).max(GROUP_MAX_MEMBERS - 1).default([]),
});

export const updateGroup = z
  .object({
    name: z.string().trim().min(1).max(GROUP_NAME_MAX).optional(),
    description: z.string().trim().max(GROUP_DESCRIPTION_MAX).optional(),
    sendPolicy: z.enum(['all', 'admins']).optional(),
    editInfoPolicy: z.enum(['all', 'admins']).optional(),
    addMemberPolicy: z.enum(['all', 'admins']).optional(),
    approvalRequired: z.boolean().optional(),
    avatarMediaId: id.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const conversationSettings = z
  .object({
    mutedUntil: z.iso.datetime().nullable().optional(),
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
    markedUnread: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export interface WireReaction {
  emoji: string;
  userIds: string[];
}

export interface SystemEvent {
  type:
    | 'group_created'
    | 'members_added'
    | 'member_removed'
    | 'member_left'
    | 'member_joined'
    | 'admin_promoted'
    | 'admin_demoted'
    | 'name_changed'
    | 'description_changed'
    | 'settings_changed'
    | 'disappearing_changed'
    | 'call';
  actorId: string;
  targetIds?: string[];
  value?: string | number | null;
  /** Call lines in the chat: how it went and how long it lasted. */
  call?: { callId: string; media: 'audio' | 'video'; outcome: string; durationSeconds: number; joinedIds: string[] };
}

export interface WireMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: string;
  kind: MessageKind;
  ciphertext: string | null;
  nonce: string | null;
  /** The message key sealed for the requesting device; null when this device was linked after the message. */
  sealedKey: string | null;
  /** The account's device that transferred this key, when different from the original sender. */
  keySenderDeviceId?: string;
  systemEvent: SystemEvent | null;
  replyToId: string | null;
  forwardedCount: number;
  editedAt: string | null;
  deletedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  reactions: WireReaction[];
  starred: boolean;
  /** Poll messages: who chose each option (by position). */
  pollVotes?: Array<{ option: number; userIds: string[] }>;
}

/** Highest message id everyone else has received / read (drives the ticks). */
export interface Receipts {
  delivered: string;
  read: string;
}

export interface GroupInfo {
  name: string;
  description: string;
  avatarUrl: string | null;
  memberCount: number;
  sendPolicy: 'all' | 'admins';
  editInfoPolicy: 'all' | 'admins';
  addMemberPolicy: 'all' | 'admins';
  approvalRequired: boolean;
}

export interface ConversationSummary {
  id: string;
  kind: 'direct' | 'group';
  peerId: string | null;
  group: GroupInfo | null;
  role: 'member' | 'admin' | 'owner';
  active: boolean;
  lastMessage: WireMessage | null;
  unreadCount: number;
  mutedUntil: string | null;
  archived: boolean;
  pinned: boolean;
  markedUnread: boolean;
  disappearingSeconds: number | null;
  receipts: Receipts;
  updatedAt: string;
}

export interface MemberInfo {
  userId: string;
  role: 'member' | 'admin' | 'owner';
  joinedAt: string;
}

export interface DeviceKey {
  userId: string;
  deviceId: string;
  identityKey: string;
}

// ───────── Media API ─────────

/** Uploads are sent in parts of this many bytes (the last part may be smaller). */
export const MEDIA_PART_SIZE = 8 * 1024 * 1024;
/** Plaintext bytes per encrypted chunk inside a media file (each chunk adds 17 bytes of authentication). */
export const MEDIA_CHUNK_SIZE = 64 * 1024;
export const MEDIA_LIMITS = {
  message: 2 * 1024 * 1024 * 1024 + 64 * 1024 * 1024,
  status: 64 * 1024 * 1024,
  avatar: 10 * 1024 * 1024,
  group_avatar: 10 * 1024 * 1024,
} as const;
export type MediaPurpose = keyof typeof MEDIA_LIMITS;

export const createUpload = z.object({
  purpose: z.enum(['message', 'status', 'avatar', 'group_avatar']),
  byteSize: z.number().int().positive(),
  /** Encrypted media is always application/octet-stream on the server; avatars are images. */
  contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/).max(127),
});

export interface UploadCreated {
  mediaId: string;
  partSize: number;
  partsReceived: number;
}

/** What travels inside an encrypted message body for each attachment. */
export interface AttachmentRef {
  mediaId: string;
  /** Base64url secretstream key and header: only people who can read the message can open the file. */
  key: string;
  header: string;
  mime: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Tiny inline preview (base64 JPEG data URL), so the bubble shows something before download. */
  thumb?: string;
  /** Voice notes: 48 bars, 0–100. */
  waveform?: number[];
}

export interface PollBody {
  question: string;
  options: string[];
  multiple: boolean;
}

// ───────── Polls and status ─────────

export const pollVote = z.object({ options: z.array(z.number().int().min(0).max(11)).max(12) });

export interface PollTally {
  option: number;
  userIds: string[];
}

export const STATUS_TTL_MS = 24 * 3_600_000;

export const createStatus = z.object({
  kind: z.enum(['text', 'image', 'video']),
  ciphertext: b64(20_000),
  nonce: b64(40),
  keys: sealedKeys,
  audience: z.array(id).max(5000),
  mediaId: id.optional(),
});

export interface WireStatus {
  id: string;
  ownerId: string;
  senderDeviceId: string;
  kind: 'text' | 'image' | 'video';
  ciphertext: string;
  nonce: string;
  sealedKey: string | null;
  createdAt: string;
  expiresAt: string;
  viewed: boolean;
}

export interface StatusViewer {
  userId: string;
  viewedAt: string;
  reaction: string | null;
}

// ───────── Calls (WhatsApp-style) ─────────

export const CALL_RING_MS = 45_000;
export const GROUP_CALL_MAX = 32;

export const startCall = z.object({
  conversationId: id,
  media: z.enum(['audio', 'video']),
  /** The call's media key sealed for every invited device (end-to-end encrypted calls). */
  keys: sealedKeys,
});

export type CallState = 'ringing' | 'active' | 'ended' | 'missed' | 'declined' | 'cancelled' | 'busy' | 'failed';

export interface CallParticipantInfo {
  userId: string;
  state: 'invited' | 'ringing' | 'joined' | 'left' | 'declined' | 'missed' | 'busy';
  joinedAt: string | null;
  leftAt: string | null;
}

export interface CallInfo {
  id: string;
  conversationId: string | null;
  initiatorId: string;
  media: 'audio' | 'video';
  state: CallState;
  e2ee: boolean;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  participants: CallParticipantInfo[];
  /** This device's sealed media key and who sealed it (null if this device was not invited). */
  sealedKey: string | null;
  keySenderDeviceId: string | null;
}

export interface MediaGrant {
  url: string;
  token: string;
  room: string;
}

// ───────── Meetings (Meet-style) ─────────

export const meetingAccess = z.enum(['open', 'trusted', 'restricted']);

export const createMeeting = z.object({
  title: z.string().trim().max(160).default(''),
  description: z.string().trim().max(2048).default(''),
  scheduledStartAt: z.iso.datetime().nullable().default(null),
  scheduledEndAt: z.iso.datetime().nullable().default(null),
  access: meetingAccess.default('trusted'),
  inviteeIds: z.array(id).max(500).default([]),
});

export const meetingControls = z
  .object({
    hostManagement: z.boolean(),
    allowScreenShare: z.boolean(),
    allowChat: z.boolean(),
    allowReactions: z.boolean(),
    allowUnmute: z.boolean(),
    allowVideo: z.boolean(),
    locked: z.boolean(),
  })
  .partial();
export type MeetingControls = Required<z.infer<typeof meetingControls>>;

export const updateMeeting = z
  .object({
    title: z.string().trim().max(160).optional(),
    description: z.string().trim().max(2048).optional(),
    access: meetingAccess.optional(),
    controls: meetingControls.optional(),
    scheduledStartAt: z.iso.datetime().nullable().optional(),
    scheduledEndAt: z.iso.datetime().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export type MeetingRole = 'host' | 'cohost' | 'participant';

export interface MeetingInfo {
  id: string;
  code: string;
  title: string;
  description: string;
  hostId: string;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  access: 'open' | 'trusted' | 'restricted';
  status: 'scheduled' | 'live' | 'ended' | 'cancelled';
  controls: MeetingControls;
  cohostIds: string[];
  inviteeIds: string[];
  myRole: MeetingRole;
  sessionId: string | null;
  participantCount: number;
  recording: { kind: 'recording' | 'stream'; startedAt: string } | null;
  createdAt: string;
}

export interface MeetingParticipantInfo {
  id: string;
  userId: string;
  role: MeetingRole;
  admission: 'waiting' | 'admitted' | 'denied' | 'removed' | 'left';
  handRaisedAt: string | null;
  joinedAt: string | null;
}

export type JoinResult =
  | { state: 'admitted'; participantId: string; sessionId: string; role: MeetingRole; grant: MediaGrant }
  | { state: 'waiting'; participantId: string; sessionId: string }
  | { state: 'denied' };

export const meetingChat = z.object({ body: z.string().trim().min(1).max(2000) });

export const createMeetingPoll = z.object({
  question: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(120)).min(2).max(10),
  multipleChoice: z.boolean().default(false),
  anonymous: z.boolean().default(false),
});

export const askQuestion = z.object({ body: z.string().trim().min(1).max(500), anonymous: z.boolean().default(false) });

export const breakoutPlan = z.object({
  rooms: z.array(z.object({ name: z.string().trim().min(1).max(60), participantIds: z.array(id).max(500) })).min(1).max(50),
  minutes: z.number().int().min(1).max(240).nullable().default(null),
});

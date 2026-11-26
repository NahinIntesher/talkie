// Plain models over the API's JSON (same shapes as packages/contracts).

typedef Json = Map<String, dynamic>;

class Profile {
  Profile(this.json);
  final Json json;
  String get id => json['id'] as String;
  String get username => json['username'] as String? ?? '';
  String get displayName => json['displayName'] as String? ?? '';
  String? get nickname => json['nickname'] as String?;
  String get about => json['about'] as String? ?? '';
  String? get avatarUrl => json['avatarUrl'] as String?;
  String? get lastSeenAt => json['lastSeenAt'] as String?;
  bool get blockedByMe => json['blockedByMe'] == true;
  bool get isContact => json['isContact'] == true;
  String get name => (nickname?.isNotEmpty ?? false) ? nickname! : (displayName.isNotEmpty ? displayName : '@$username');
}

class Reaction {
  Reaction(this.emoji, this.userIds);
  final String emoji;
  final List<String> userIds;
}

class ChatMessage {
  ChatMessage({
    required this.id,
    required this.conversationId,
    required this.senderId,
    required this.senderDeviceId,
    required this.kind,
    this.ciphertext,
    this.nonce,
    this.sealedKey,
    this.keySenderDeviceId,
    this.systemEvent,
    this.replyToId,
    this.forwardedCount = 0,
    this.editedAt,
    this.deletedAt,
    this.expiresAt,
    required this.createdAt,
    List<Reaction>? reactions,
    this.starred = false,
    this.pollVotes,
    this.body,
    this.unreadable,
    this.local,
  }) : reactions = reactions ?? [];

  factory ChatMessage.fromWire(Json m) => ChatMessage(
        id: m['id'] as String,
        conversationId: m['conversationId'] as String,
        senderId: m['senderId'] as String,
        senderDeviceId: m['senderDeviceId'] as String,
        kind: m['kind'] as String,
        ciphertext: m['ciphertext'] as String?,
        nonce: m['nonce'] as String?,
        sealedKey: m['sealedKey'] as String?,
        keySenderDeviceId: m['keySenderDeviceId'] as String?,
        systemEvent: m['systemEvent'] as Json?,
        replyToId: m['replyToId'] as String?,
        forwardedCount: (m['forwardedCount'] as num?)?.toInt() ?? 0,
        editedAt: m['editedAt'] as String?,
        deletedAt: m['deletedAt'] as String?,
        expiresAt: m['expiresAt'] as String?,
        createdAt: m['createdAt'] as String,
        reactions: ((m['reactions'] as List?) ?? []).map((r) => Reaction(r['emoji'] as String, List<String>.from(r['userIds'] as List))).toList(),
        starred: m['starred'] == true,
        pollVotes: (m['pollVotes'] as List?)?.map((t) => MapEntry((t['option'] as num).toInt(), List<String>.from(t['userIds'] as List))).toList(),
      );

  final String id;
  final String conversationId;
  final String senderId;
  final String senderDeviceId;
  final String kind;
  final String? ciphertext, nonce, sealedKey;
  final String? keySenderDeviceId;
  final Json? systemEvent;
  final String? replyToId;
  final int forwardedCount;
  final String? editedAt, deletedAt, expiresAt;
  final String createdAt;
  List<Reaction> reactions;
  bool starred;
  List<MapEntry<int, List<String>>>? pollVotes;
  Json? body;

  /// 'not_for_this_device' or 'failed' when the body could not be opened.
  String? unreadable;

  /// 'sending' or 'failed' for my messages the server has not confirmed.
  String? local;

  bool get deleted => deletedAt != null;
  String? get text => body?['text'] as String?;
  List<Json> get attachments => ((body?['attachments'] as List?) ?? []).cast<Json>();
  Json? get poll => body?['poll'] as Json?;
  DateTime get time => DateTime.parse(createdAt).toLocal();

  ChatMessage copyWith({Json? body, String? local, bool clearLocal = false, String? unreadable}) => ChatMessage(
        id: id,
        conversationId: conversationId,
        senderId: senderId,
        senderDeviceId: senderDeviceId,
        kind: kind,
        ciphertext: ciphertext,
        nonce: nonce,
        sealedKey: sealedKey,
        keySenderDeviceId: keySenderDeviceId,
        systemEvent: systemEvent,
        replyToId: replyToId,
        forwardedCount: forwardedCount,
        editedAt: editedAt,
        deletedAt: deletedAt,
        expiresAt: expiresAt,
        createdAt: createdAt,
        reactions: reactions,
        starred: starred,
        pollVotes: pollVotes,
        body: body ?? this.body,
        unreadable: unreadable ?? this.unreadable,
        local: clearLocal ? null : (local ?? this.local),
      );
}

class Conversation {
  Conversation(this.json, {this.last});
  Json json;
  ChatMessage? last;

  String get id => json['id'] as String;
  bool get isGroup => json['kind'] == 'group';
  String? get peerId => json['peerId'] as String?;
  Json? get group => json['group'] as Json?;
  String get role => json['role'] as String? ?? 'member';
  bool get active => json['active'] != false;
  int get unreadCount => (json['unreadCount'] as num?)?.toInt() ?? 0;
  String? get mutedUntil => json['mutedUntil'] as String?;
  bool get archived => json['archived'] == true;
  bool get pinned => json['pinned'] == true;
  bool get markedUnread => json['markedUnread'] == true;
  int? get disappearingSeconds => (json['disappearingSeconds'] as num?)?.toInt();
  bool get isAdmin => role == 'admin' || role == 'owner';
  String get sortKey => last?.id ?? (json['lastMessage'] as Json?)?['id'] as String? ?? id;
}

class Receipts {
  const Receipts(this.delivered, this.read);
  factory Receipts.fromJson(Json? json) => Receipts(json?['delivered'] as String? ?? '0', json?['read'] as String? ?? '0');
  final String delivered;
  final String read;
}

class Member {
  Member(this.userId, this.role);
  final String userId;
  final String role;
}

/// Snowflake ids compared as big numbers.
bool newer(String a, String b) => BigInt.parse(a) > BigInt.parse(b);

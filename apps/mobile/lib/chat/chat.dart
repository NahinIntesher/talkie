import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/api.dart';
import '../core/crypto.dart';
import '../core/realtime.dart';
import '../core/session.dart';
import 'models.dart';

class Thread {
  List<ChatMessage> items = [];
  bool hasMore = false;
  bool loaded = false;
}

/// The chat engine (a port of the web's lib/chat/engine.ts): loads conversations, decrypts and sends
/// messages, and keeps everything current from live events. Screens listen to it and call its methods.
class Chat extends ChangeNotifier {
  Chat(this.session);
  final Session session;

  bool ready = false;
  bool loadFailed = false;
  final Map<String, Conversation> conversations = {};
  final Map<String, Thread> threads = {};
  final Map<String, Receipts> receipts = {};
  final Map<String, List<Member>> members = {};
  final Map<String, List<String>> pins = {};
  final Map<String, Profile> profiles = {};
  final Map<String, Map<String, int>> typing = {};
  final Map<String, bool> online = {};
  final Map<String, double> uploads = {};
  String? activeId;

  final _deviceCache = <String, List<Recipient>>{};
  final _publicKeys = <String, String>{};
  final _keyOwners = <String, String>{};
  final _readSent = <String, String>{};
  final _deliveredSent = <String, String>{};
  final _profileRequests = <String>{};
  final _timers = <Timer>[];
  bool _started = false;
  bool _disposed = false;
  Future<void>? _loadingConversations;

  String get me => session.userId;
  Crypto get _crypto => Crypto.instance;

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  // ───────── Lifecycle ─────────

  Future<void> start() async {
    if (_started) return;
    _started = true;
    _bindRealtime();
    await loadConversations();
  }

  void stop() {
    _started = false;
    for (final t in _timers) {
      t.cancel();
    }
    _timers.clear();
    realtime.disconnect();
  }

  @override
  void dispose() {
    _disposed = true;
    stop();
    super.dispose();
  }

  // ───────── Keys and decryption ─────────

  void _remember(List<Recipient> devices) {
    for (final d in devices) {
      _publicKeys[d.deviceId] = d.identityKey;
    }
  }

  Future<void> _senderKeys(Iterable<String> deviceIds, {Set<String> wrappers = const {}}) async {
    final deviceId = session.deviceId;
    final keys = session.keys;
    if (deviceId != null && keys != null) {
      _publicKeys[deviceId] = keys.publicKey;
      _keyOwners[deviceId] = me;
    }
    final missing = deviceIds.toSet().where((id) => !_publicKeys.containsKey(id) || (wrappers.contains(id) && !_keyOwners.containsKey(id))).toList();
    if (missing.isEmpty) return;
    for (var i = 0; i < missing.length; i += 200) {
      final result = await api.post('/auth/device-keys/lookup', {'deviceIds': missing.sublist(i, (i + 200).clamp(0, missing.length))});
      for (final item in (result['devices'] as List).cast<Json>()) {
        final device = Recipient.fromJson(item);
        _publicKeys[device.deviceId] = device.identityKey;
        _keyOwners[device.deviceId] = item['userId'] as String;
      }
    }
  }

  /// Public keys of several devices (fetched once, then cached).
  Future<Map<String, String>> keysFor(Iterable<String> deviceIds) async {
    try {
      await _senderKeys(deviceIds);
    } catch (_) {}
    return _publicKeys;
  }

  void rememberKeys(List<Recipient> devices) => _remember(devices);

  /// The public key of one device (for opening call keys and status keys).
  Future<String?> publicKeyOf(String deviceId) async {
    await _senderKeys([deviceId]);
    return _publicKeys[deviceId];
  }

  Future<List<ChatMessage>> _decrypt(List<Json> wire) async {
    final keys = session.keys;
    final messages = wire.map(ChatMessage.fromWire).toList();
    final encrypted = messages.where((m) => m.ciphertext != null && m.sealedKey != null).toList();
    final wrappers = encrypted.map((m) => m.keySenderDeviceId).whereType<String>().toSet();
    final senders = encrypted.map((m) => m.keySenderDeviceId ?? m.senderDeviceId);
    try {
      await _senderKeys(senders, wrappers: wrappers);
    } catch (_) {}
    for (final m in messages) {
      if (m.ciphertext == null || m.deleted || m.kind == 'system') continue;
      if (m.sealedKey == null || keys == null) {
        m.unreadable = 'not_for_this_device';
        continue;
      }
      final wrap = m.keySenderDeviceId;
      final senderKey = wrap != null && _keyOwners[wrap] != me ? null : _publicKeys[wrap ?? m.senderDeviceId];
      if (senderKey == null) {
        m.unreadable = 'failed';
        continue;
      }
      try {
        m.body = _crypto.open(ciphertext: m.ciphertext!, nonce: m.nonce!, sealedKey: m.sealedKey!, senderIdentityKey: senderKey, receiver: keys);
      } catch (_) {
        m.unreadable = 'failed';
      }
    }
    return messages;
  }

  // ───────── Profiles ─────────

  Future<void> loadProfiles(Iterable<String> ids) async {
    final missing = ids.toSet().where((id) => !profiles.containsKey(id) && !_profileRequests.contains(id)).toList();
    if (missing.isEmpty) return;
    _profileRequests.addAll(missing);
    try {
      for (var i = 0; i < missing.length; i += 50) {
        final batch = missing.sublist(i, (i + 50).clamp(0, missing.length));
        try {
          final result = await api.post('/users/lookup', {'ids': batch});
          for (final u in result['users'] as List) {
            final p = Profile(u as Json);
            profiles[p.id] = p;
          }
          _changed();
        } catch (_) {
          for (final id in batch) {
            if (_disposed) return;
            try {
              await refreshProfile(id);
            } catch (_) {}
          }
        }
      }
    } finally {
      _profileRequests.removeAll(missing);
    }
  }

  Future<Profile> refreshProfile(String userId) async {
    final result = await api.get('/users/$userId');
    final p = Profile(result['user'] as Json);
    profiles[userId] = p;
    _changed();
    return p;
  }

  String nameOf(String userId, {String you = 'You'}) => userId == me ? you : (profiles[userId]?.name ?? '…');

  String titleOf(Conversation c, {String fallback = '…'}) => c.isGroup ? (c.group?['name'] as String? ?? fallback) : (profiles[c.peerId]?.name ?? fallback);

  String? avatarOf(Conversation c) => c.isGroup ? (c.group?['avatarUrl'] as String?) : profiles[c.peerId]?.avatarUrl;

  // ───────── Conversations ─────────

  Future<void> _storeSummaries(List<Json> summaries, {bool replace = false}) async {
    if (_disposed) return;
    final stamped = <String, Conversation>{};
    if (replace) conversations.clear();
    for (final s in summaries) {
      final id = s['id'] as String;
      if (id == activeId) {
        s['unreadCount'] = 0;
        s['markedUnread'] = false;
      }
      final wire = s['lastMessage'] as Json?;
      conversations[id] = stamped[id] = Conversation(s, last: wire == null ? null : ChatMessage.fromWire(wire));
      receipts[id] = Receipts.fromJson(s['receipts'] as Json?);
    }
    _changed();
    loadProfiles(summaries.expand((s) => [s['peerId'], (s['lastMessage'] as Json?)?['senderId']]).whereType<String>());
    _watchPresence();
    final lasts = await _decrypt(summaries.map((s) => s['lastMessage']).whereType<Json>().toList());
    for (final message in lasts) {
      final current = conversations[message.conversationId];
      if (current != null && identical(stamped[message.conversationId], current) && current.last?.id == message.id) current.last = message;
    }
    _changed();
  }

  List<Conversation> ordered({bool archived = false}) {
    final list = conversations.values.where((c) => c.archived == archived).toList();
    list.sort((a, b) {
      if (a.pinned != b.pinned) return a.pinned ? -1 : 1;
      return BigInt.parse(b.sortKey).compareTo(BigInt.parse(a.sortKey));
    });
    return list;
  }

  int get unreadChats => conversations.values.where((c) => !c.archived && (c.unreadCount > 0 || c.markedUnread)).length;

  Future<void> loadConversations() async {
    return _loadingConversations ??= () async {
      try {
        final result = await api.get('/chat/conversations');
        ready = true;
        loadFailed = false;
        await _storeSummaries((result['conversations'] as List).cast<Json>(), replace: true);
      } catch (_) {
        loadFailed = true;
      } finally {
        ready = true;
        _loadingConversations = null;
        _changed();
      }
    }();
  }

  Future<Json?> reload(String conversationId) async {
    try {
      final data = await api.get('/chat/conversations/$conversationId') as Json;
      await _storeSummaries([data['conversation'] as Json]);
      members[conversationId] = (data['members'] as List).map((m) => Member(m['userId'] as String, m['role'] as String)).toList();
      pins[conversationId] = List<String>.from(data['pinnedMessageIds'] as List? ?? []);
      loadProfiles(members[conversationId]!.map((m) => m.userId));
      _deviceCache.remove(conversationId);
      _changed();
      return data;
    } on ApiError catch (error) {
      if (error.status == 404) {
        conversations.remove(conversationId);
        if (activeId == conversationId) activeId = null;
        _changed();
      }
      return null;
    }
  }

  Future<void> open(String? conversationId) async {
    activeId = conversationId;
    if (conversationId == null) return;
    final summary = reload(conversationId);
    if (!conversations.containsKey(conversationId) && await summary == null) throw ApiError(0, 'unavailable', 'Could not load this chat.');
    final thread = threads[conversationId];
    if (thread?.loaded != true || thread!.items.any((m) => m.unreadable != null)) await loadOlder(conversationId, initial: true);
    markRead(conversationId);
  }

  Future<void> loadOlder(String conversationId, {bool initial = false}) async {
    final thread = threads.putIfAbsent(conversationId, Thread.new);
    if (!initial && (!thread.hasMore || thread.items.isEmpty)) return;
    final oldest = thread.items.where((m) => m.local == null).firstOrNull;
    final before = !initial && oldest != null ? '&before=${oldest.id}' : '';
    final page = await api.get('/chat/conversations/$conversationId/messages?limit=50$before') as Json;
    final decrypted = await _decrypt((page['messages'] as List).cast<Json>());
    loadProfiles(decrypted.map((m) => m.senderId));
    thread.items = initial ? [...decrypted, ...thread.items.where((m) => m.local != null)] : [...decrypted, ...thread.items];
    thread.hasMore = page['hasMore'] == true;
    thread.loaded = true;
    receipts[conversationId] = Receipts.fromJson(page['receipts'] as Json?);
    _changed();
    _acknowledgeDelivery(conversationId);
  }

  Future<void> _loadNewer(String conversationId) async {
    final thread = threads[conversationId];
    final last = thread?.items.lastWhere((m) => m.local == null, orElse: () => _none);
    if (thread == null || !thread.loaded || last == null || identical(last, _none)) return loadOlder(conversationId, initial: true);
    final page = await api.get('/chat/conversations/$conversationId/messages?after=${last.id}&limit=100') as Json;
    final decrypted = await _decrypt((page['messages'] as List).cast<Json>());
    loadProfiles(decrypted.map((m) => m.senderId));
    final ids = thread.items.map((m) => m.id).toSet();
    final confirmed = decrypted.map((m) => m.id).toSet();
    thread.items = [...thread.items.where((m) => !(m.local != null && confirmed.contains(m.id))), ...decrypted.where((m) => !ids.contains(m.id))];
    final newest = decrypted.lastOrNull;
    final summary = conversations[conversationId];
    if (newest != null && summary != null && (summary.last == null || newer(newest.id, summary.last!.id))) summary.last = newest;
    receipts[conversationId] = Receipts.fromJson(page['receipts'] as Json?);
    _changed();
  }

  static final _none = ChatMessage(id: '0', conversationId: '', senderId: '', senderDeviceId: '', kind: 'text', createdAt: '1970-01-01T00:00:00Z');

  // ───────── Receipts ─────────

  String? _latestFromOthers(String conversationId) {
    final fromThread = threads[conversationId]?.items.lastWhere((m) => m.local == null && m.senderId != me, orElse: () => _none);
    final t = fromThread == null || identical(fromThread, _none) ? null : fromThread.id;
    final last = conversations[conversationId]?.last;
    final s = last != null && last.senderId != me ? last.id : null;
    if (t != null && s != null) return newer(t, s) ? t : s;
    return t ?? s;
  }

  bool appVisible = true;

  void markRead(String conversationId) {
    if (!appVisible || activeId != conversationId) return;
    final summary = conversations[conversationId];
    if (summary != null && !summary.active) return;
    if (summary != null && (summary.unreadCount > 0 || summary.markedUnread)) {
      summary.json['unreadCount'] = 0;
      summary.json['markedUnread'] = false;
      _changed();
    }
    final latest = _latestFromOthers(conversationId);
    final sent = _readSent[conversationId];
    if (latest == null || (sent != null && !newer(latest, sent))) return;
    _readSent[conversationId] = latest;
    api.post('/chat/conversations/$conversationId/read', {'messageId': latest}).catchError((_) => _readSent.remove(conversationId));
  }

  void _acknowledgeDelivery(String conversationId) {
    final latest = _latestFromOthers(conversationId);
    final sent = _deliveredSent[conversationId];
    if (latest == null || (sent != null && !newer(latest, sent))) return;
    _deliveredSent[conversationId] = latest;
    api.post('/chat/conversations/$conversationId/delivered', {'messageId': latest}).catchError((_) => _deliveredSent.remove(conversationId));
  }

  // ───────── Sending ─────────

  Future<List<Recipient>> _devicesFor(String conversationId, {bool fresh = false}) async {
    if (!fresh && _deviceCache.containsKey(conversationId)) return _deviceCache[conversationId]!;
    final result = await api.get('/chat/conversations/$conversationId/devices${fresh ? '?fresh=1' : ''}');
    final devices = (result['devices'] as List).map((d) => Recipient.fromJson(d as Json)).toList();
    _deviceCache[conversationId] = devices;
    _remember(devices);
    return devices;
  }

  List<Recipient> _withSelf(List<Recipient> devices) {
    final keys = session.keys!;
    final list = [...devices];
    if (!list.any((d) => d.deviceId == session.deviceId)) list.add(Recipient(deviceId: session.deviceId!, identityKey: keys.publicKey));
    return list;
  }

  /// Encrypts for every device and posts; re-encrypts once if someone linked or removed a device meanwhile.
  Future<T> sealAndPost<T>(String conversationId, Json body, Future<T> Function(Sealed sealed) post) async {
    final keys = session.keys;
    if (keys == null) throw StateError('Device keys are not ready');
    try {
      return await post(_crypto.seal(body, keys, _withSelf(await _devicesFor(conversationId))));
    } on ApiError catch (error) {
      if (error.code != 'devices_changed') rethrow;
      final listed = (error.details?['devices'] as List?)?.map((d) => Recipient.fromJson(d as Json)).toList();
      final devices = listed ?? await _devicesFor(conversationId, fresh: true);
      _deviceCache[conversationId] = devices;
      _remember(devices);
      return post(_crypto.seal(body, keys, _withSelf(devices)));
    }
  }

  Future<List<Recipient>> devicesOf(String conversationId) async {
    final result = await api.get('/chat/conversations/$conversationId/devices?fresh=1&media=1');
    return (result['devices'] as List).cast<Json>().map(Recipient.fromJson).toList();
  }

  void _upsert(String conversationId, ChatMessage message, {String? replaceId}) {
    final thread = threads.putIfAbsent(conversationId, Thread.new);
    thread.items = thread.items.where((m) => m.id != message.id && m.id != replaceId).toList()..add(message);
    thread.items.sort((a, b) {
      if (a.local != null && b.local == null) return 1;
      if (a.local == null && b.local != null) return -1;
      if (a.local != null && b.local != null) return 0;
      return BigInt.parse(a.id).compareTo(BigInt.parse(b.id));
    });
    final summary = conversations[conversationId];
    if (summary != null && message.local == null && (summary.last == null || !newer(summary.last!.id, message.id))) summary.last = message;
    _changed();
  }

  Future<void> _send(String conversationId, String kind, Json body, {String? replyToId, String? requestId, ChatMessage? retry, Future<({Json? body, List<String> mediaIds})> Function(String localId)? prepare}) async {
    final clientMessageId = retry?.id.substring(6) ?? requestId ?? _crypto.clientMessageId();
    final localId = 'local:$clientMessageId';
    final optimistic = retry?.copyWith(local: 'sending') ??
        ChatMessage(
          id: localId,
          conversationId: conversationId,
          senderId: me,
          senderDeviceId: session.deviceId!,
          kind: kind,
          replyToId: replyToId,
          createdAt: DateTime.now().toUtc().toIso8601String(),
          body: body,
          local: 'sending',
        );
    _upsert(conversationId, optimistic);
    try {
      final prepared = prepare != null ? await prepare(localId) : (body: null, mediaIds: <String>[]);
      final finalBody = {...body, ...?prepared.body};
      final result = await sealAndPost(
        conversationId,
        finalBody,
        (sealed) => api.post('/chat/conversations/$conversationId/messages', {
          'clientMessageId': clientMessageId,
          'kind': kind,
          ...sealed.toJson(),
          'mediaIds': prepared.mediaIds,
          if (optimistic.replyToId != null) 'replyToId': optimistic.replyToId,
        }),
      );
      final message = ChatMessage.fromWire(result['message'] as Json)..body = finalBody;
      _upsert(conversationId, message, replaceId: localId);
      _readSent[conversationId] = message.id;
    } catch (error) {
      _upsert(conversationId, optimistic.copyWith(local: 'failed'));
      rethrow;
    } finally {
      uploads.remove(localId);
    }
  }

  void setProgress(String localId, double? value) {
    if (value == null) {
      uploads.remove(localId);
    } else {
      uploads[localId] = value;
    }
    _changed();
  }

  Future<void> sendText(String conversationId, String text, {String? replyToId, ChatMessage? retry, String? requestId}) =>
      _send(conversationId, 'text', {'v': 1, 'text': text}, replyToId: replyToId, retry: retry, requestId: requestId);

  /// Sends a message whose attachment is uploaded first (see media.dart).
  Future<void> sendWithUpload(String conversationId, String kind, Json body, Future<({Json? body, List<String> mediaIds})> Function(String localId) prepare, {String? replyToId}) =>
      _send(conversationId, kind, body, replyToId: replyToId, prepare: prepare);

  Future<void> sendPoll(String conversationId, String question, List<String> options, bool multiple) =>
      _send(conversationId, 'poll', {'v': 1, 'poll': {'question': question, 'options': options, 'multiple': multiple}});

  Future<void> vote(String conversationId, String messageId, List<int> options) async {
    final m = threads[conversationId]?.items.where((m) => m.id == messageId).firstOrNull;
    if (m != null) {
      final tallies = {for (final t in m.pollVotes ?? <MapEntry<int, List<String>>>[]) t.key: t.value.where((u) => u != me).toList()};
      for (final o in options) {
        tallies.putIfAbsent(o, () => []).add(me);
      }
      m.pollVotes = tallies.entries.where((e) => e.value.isNotEmpty).map((e) => MapEntry(e.key, e.value)).toList();
      _changed();
    }
    await api.put('/chat/messages/$messageId/vote', {'options': options});
  }

  Future<void> editText(String conversationId, String messageId, String text) async {
    final body = {'v': 1, 'text': text};
    final result = await sealAndPost(conversationId, body, (sealed) => api.patch('/chat/messages/$messageId', sealed.toJson()));
    _upsert(conversationId, ChatMessage.fromWire(result['message'] as Json)..body = body);
  }

  Future<void> deleteMessage(String conversationId, String messageId, String scope) async {
    await api.delete('/chat/messages/$messageId?scope=$scope');
    if (scope == 'me') {
      threads[conversationId]?.items.removeWhere((m) => m.id == messageId);
      _changed();
    } else {
      await _refreshMessage(conversationId, messageId);
    }
  }

  Future<void> react(String conversationId, String messageId, String? emoji) async {
    final m = threads[conversationId]?.items.where((m) => m.id == messageId).firstOrNull;
    if (m != null) {
      final reactions = m.reactions.map((r) => Reaction(r.emoji, r.userIds.where((u) => u != me).toList())).where((r) => r.userIds.isNotEmpty).toList();
      if (emoji != null) {
        final existing = reactions.where((r) => r.emoji == emoji).firstOrNull;
        if (existing != null) {
          existing.userIds.add(me);
        } else {
          reactions.add(Reaction(emoji, [me]));
        }
      }
      m.reactions = reactions;
      _changed();
    }
    await api.put('/chat/messages/$messageId/reaction', {'emoji': emoji});
  }

  Future<void> star(String conversationId, String messageId, bool starred) async {
    await api.put('/chat/messages/$messageId/star', {'starred': starred});
    await _refreshMessage(conversationId, messageId);
  }

  Future<void> pin(String conversationId, String messageId, bool pinned) async {
    await api.put('/chat/messages/$messageId/pin', {'pinned': pinned, 'seconds': 604800});
    await reload(conversationId);
  }

  Future<void> _refreshMessage(String conversationId, String messageId) async {
    try {
      final result = await api.get('/chat/messages/$messageId');
      final decrypted = await _decrypt([result['message'] as Json]);
      _upsert(conversationId, decrypted.first);
    } on ApiError catch (error) {
      if (error.status == 404) {
        threads[conversationId]?.items.removeWhere((m) => m.id == messageId);
        _changed();
      }
    }
  }

  final _fetched = <String, ChatMessage?>{};

  /// A single message (for reply previews outside the loaded page).
  Future<ChatMessage?> fetchMessage(String messageId) async {
    if (_fetched.containsKey(messageId)) return _fetched[messageId];
    try {
      final result = await api.get('/chat/messages/$messageId');
      return _fetched[messageId] = (await _decrypt([result['message'] as Json])).first;
    } catch (_) {
      return null;
    }
  }

  final _requested = <String>{};

  /// Fetches a quoted message once, then redraws.
  void requestMessage(String messageId) {
    if (!_requested.add(messageId)) return;
    fetchMessage(messageId).then((m) {
      if (m != null) _changed();
    });
  }

  ChatMessage? findMessage(String conversationId, String messageId) => threads[conversationId]?.items.where((m) => m.id == messageId).firstOrNull ?? _fetched[messageId];

  // ───────── Create and manage ─────────

  Future<String> startDirect(String userId) async {
    final result = await api.post('/chat/conversations/direct', {'userId': userId});
    await _storeSummaries([result['conversation'] as Json]);
    return result['conversation']['id'] as String;
  }

  Future<String> createGroup(String name, List<String> memberIds) async {
    final result = await api.post('/chat/groups', {'name': name, 'description': '', 'memberIds': memberIds});
    await _storeSummaries([result['conversation'] as Json]);
    return result['conversation']['id'] as String;
  }

  Future<void> updateSettings(String conversationId, Json settings) async {
    final result = await api.patch('/chat/conversations/$conversationId/settings', settings);
    await _storeSummaries([result['conversation'] as Json]);
  }

  /// Removes a chat from this device (deleted, or gone).
  void _forget(String conversationId) {
    conversations.remove(conversationId);
    threads.remove(conversationId);
    if (activeId == conversationId) activeId = null;
    _changed();
  }

  /// "Clear chat": hides all messages up to now, for me only.
  Future<void> clearChat(String conversationId) async {
    await api.post('/chat/conversations/$conversationId/clear');
    threads[conversationId]?.items.clear();
    conversations[conversationId]?.last = null;
    _changed();
    await loadOlder(conversationId, initial: true);
  }

  /// "Delete chat": clears it for me and removes it from my list until someone writes again.
  Future<void> deleteConversation(String conversationId) async {
    await api.delete('/chat/conversations/$conversationId');
    _forget(conversationId);
  }

  Future<void> setDisappearing(String conversationId, int? seconds) async {
    await api.put('/chat/conversations/$conversationId/disappearing', {'seconds': seconds});
    await reload(conversationId);
  }

  Future<void> updateGroup(String conversationId, Json changes) async {
    await api.patch('/chat/groups/$conversationId', changes);
    await reload(conversationId);
  }

  Future<void> addMembers(String conversationId, List<String> userIds) async {
    await api.post('/chat/groups/$conversationId/members', {'userIds': userIds});
    await reload(conversationId);
  }

  Future<void> setRole(String conversationId, String userId, String role) async {
    await api.put('/chat/groups/$conversationId/members/$userId/role', {'role': role});
    await reload(conversationId);
  }

  /// Removes a member; with my own id this is "Exit group".
  Future<void> removeMember(String conversationId, String userId) async {
    await api.delete('/chat/groups/$conversationId/members/$userId');
    await reload(conversationId);
  }

  Future<String> inviteLink(String conversationId) async {
    final result = await api.post('/chat/groups/$conversationId/invite-link');
    return result['code'] as String;
  }

  Future<void> setBlocked(String userId, bool blocked) async {
    if (blocked) {
      await api.put('/users/me/blocks/$userId');
    } else {
      await api.delete('/users/me/blocks/$userId');
    }
    await refreshProfile(userId);
  }

  Future<void> report(String userId, String reason, String note, bool block) async {
    await api.post('/users/$userId/report', {'reason': reason, 'note': note, 'block': block});
    if (block) await refreshProfile(userId);
  }

  /// Who read and who received one of my messages.
  Future<({List<String> readBy, List<String> deliveredTo})> messageInfo(String messageId) async {
    final result = await api.get('/chat/messages/$messageId/info');
    final readBy = List<String>.from(result['readBy'] as List);
    final deliveredTo = List<String>.from(result['deliveredTo'] as List);
    await loadProfiles([...readBy, ...deliveredTo]);
    return (readBy: readBy, deliveredTo: deliveredTo);
  }

  /// Safety number with the other person's first device, or null when they have no keys yet.
  Future<String?> safetyNumber(String userId) async {
    final mine = session.keys?.publicKey;
    final result = await api.get('/auth/users/$userId/device-keys');
    final devices = (result['devices'] as List).cast<Json>();
    if (mine == null || devices.isEmpty) return null;
    return Crypto.instance.safetyNumber(mine, devices.first['identityKey'] as String);
  }

  // ───────── Live updates ─────────

  void _watchPresence() {
    if (realtime.socket?.connected != true) return;
    final peers = conversations.values.map((c) => c.peerId).whereType<String>().take(300).toList();
    if (peers.isEmpty) return;
    realtime.emitAck('presence:watch', peers, (states) {
      if (states is! List) return;
      for (final s in states) {
        online[s['userId'] as String] = s['online'] == true;
      }
      _changed();
    });
  }

  Timer? _typingTimer;
  void setTyping(String conversationId, bool active) {
    realtime.emit('typing', {'conversationId': conversationId, 'active': active});
    _typingTimer?.cancel();
    if (active) _typingTimer = Timer(const Duration(seconds: 4), () => realtime.emit('typing', {'conversationId': conversationId, 'active': false}));
  }

  List<String> typingIn(String conversationId) => (typing[conversationId] ?? {}).keys.toList();

  /// Other features (calls, status) listen to live events through this.
  final _extra = <String, List<void Function(Json)>>{};

  /// Listens to a live event; returns a function that stops listening.
  void Function() on(String event, void Function(Json) handler) {
    final list = _extra[event];
    if (list == null) {
      _extra[event] = [handler];
      realtime.socket?.on(event, (data) => _dispatch(event, data));
    } else {
      list.add(handler);
    }
    return () => _extra[event]?.remove(handler);
  }

  void _dispatch(String event, dynamic data) {
    for (final h in [...?_extra[event]]) {
      h(_asJson(data));
    }
  }

  static Json _asJson(dynamic data) => data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};

  void _bindRealtime() {
    final socket = realtime.connect();
    for (final event in _extra.keys) {
      socket.on(event, (d) => _dispatch(event, d));
    }
    socket.on('connect', (_) {
      _watchPresence();
      loadConversations().then((_) {
        if (activeId != null) _loadNewer(activeId!);
      }).catchError((_) {});
    });

    socket.on('chat:message', (raw) async {
      final data = _asJson(raw);
      final conversationId = data['conversationId'] as String;
      final senderId = data['senderId'] as String;
      final messageId = data['messageId'] as String;
      try {
        if (!conversations.containsKey(conversationId)) {
          await reload(conversationId);
        } else if (threads[conversationId]?.loaded == true) {
          await _loadNewer(conversationId);
        } else {
          final message = await fetchMessage(messageId);
          final summary = conversations[conversationId];
          if (message != null && summary != null) {
            summary.last = message;
            if (senderId != me) summary.json['unreadCount'] = summary.unreadCount + 1;
            if (summary.mutedUntil == null) summary.json['archived'] = false;
          }
        }
      } catch (_) {}
      if (senderId != me) {
        final summary = conversations[conversationId];
        if (summary != null && activeId != conversationId && threads[conversationId]?.loaded == true) summary.json['unreadCount'] = summary.unreadCount + 1;
        _acknowledgeDelivery(conversationId);
        markRead(conversationId);
        typing[conversationId]?.remove(senderId);
      }
      _changed();
    });

    socket.on('chat:message-updated', (raw) {
      final data = _asJson(raw);
      final conversationId = data['conversationId'] as String;
      final messageId = data['messageId'] as String;
      if (data['change'] == 'expired') {
        threads[conversationId]?.items.removeWhere((m) => m.id == messageId);
        _changed();
        return;
      }
      if (threads[conversationId]?.items.any((m) => m.id == messageId) == true) {
        _refreshMessage(conversationId, messageId);
      } else if (conversations[conversationId]?.last?.id == messageId) {
        reload(conversationId);
      }
    });

    socket.on('chat:receipt', (raw) async {
      final data = _asJson(raw);
      if (data['userId'] == me) return;
      final conversationId = data['conversationId'] as String;
      try {
        final result = await api.get('/chat/conversations/$conversationId/receipts');
        receipts[conversationId] = Receipts.fromJson(result['receipts'] as Json?);
        _changed();
      } catch (_) {}
    });

    socket.on('chat:conversation', (raw) {
      final data = _asJson(raw);
      final conversationId = data['conversationId'] as String;
      _deviceCache.remove(conversationId);
      if (data['change'] == 'deleted') return _forget(conversationId);
      reload(conversationId).then((_) {
        if (threads[conversationId]?.loaded == true) _loadNewer(conversationId);
      });
    });

    socket.on('typing', (raw) {
      final data = _asJson(raw);
      final people = typing.putIfAbsent(data['conversationId'] as String, () => {});
      if (data['active'] == true) {
        people[data['userId'] as String] = DateTime.now().millisecondsSinceEpoch + 6000;
      } else {
        people.remove(data['userId']);
      }
      _changed();
    });

    socket.on('presence', (raw) {
      final data = _asJson(raw);
      final userId = data['userId'] as String;
      online[userId] = data['online'] == true;
      final seen = data['lastSeenAt'] as String?;
      if (seen != null && profiles[userId] != null) profiles[userId]!.json['lastSeenAt'] = seen;
      _changed();
    });

    socket.on('session:device-revoked', (raw) {
      if (_asJson(raw)['deviceId'] == session.deviceId) session.deviceRevoked();
    });

    socket.on('chat:history-synced', (_) async {
      try {
        final selected = activeId;
        threads.removeWhere((id, thread) => id != selected && thread.items.any((message) => message.unreadable != null));
        final current = threads[selected];
        if (current != null) {
          final locked = current.items.where((message) => message.unreadable != null).take(25);
          final restored = await Future.wait(locked.map((message) => fetchMessage(message.id)));
          final byId = {for (final message in restored.whereType<ChatMessage>()) if (message.unreadable == null) message.id: message};
          current.items = current.items.map((message) => message.unreadable != null ? byId[message.id] ?? message : message).toList();
          _changed();
        }
        await loadConversations();
      } catch (_) {}
    });

    // Keep the socket's token fresh alongside the HTTP session.
    _timers.add(Timer.periodic(const Duration(minutes: 10), (_) async {
      if (await api.refresh?.call() == true) realtime.renewToken();
    }));

    _timers.add(Timer.periodic(const Duration(seconds: 15), (_) {
      if (appVisible && realtime.state.value != Connection.connected) _syncAfterReconnect();
    }));

    // Expire stale typing indicators.
    _timers.add(Timer.periodic(const Duration(seconds: 1), (_) {
      final now = DateTime.now().millisecondsSinceEpoch;
      var changed = false;
      for (final people in typing.values) {
        final before = people.length;
        people.removeWhere((_, until) => until < now);
        if (people.length != before) changed = true;
      }
      if (changed) _changed();
    }));
  }

  /// Called when the app returns to the foreground.
  void resumed() {
    appVisible = true;
    _syncAfterReconnect();
    if (activeId != null) markRead(activeId!);
  }

  Future<void> _syncAfterReconnect() async {
    await loadConversations();
    final conversationId = activeId;
    if (conversationId == null || _disposed) return;
    try {
      await _loadNewer(conversationId);
    } catch (_) {}
  }
}

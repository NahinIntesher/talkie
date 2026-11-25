import 'dart:async';

import 'package:flutter/foundation.dart';

import '../chat/chat.dart';
import '../chat/media.dart';
import '../chat/models.dart';
import '../core/api.dart';
import '../core/crypto.dart';

class StatusItem {
  StatusItem(this.json, this.body);
  final Json json;
  final Json? body;
  String get id => json['id'] as String;
  String get ownerId => json['ownerId'] as String;
  String get kind => json['kind'] as String;
  bool get viewed => json['viewed'] == true;
  set viewed(bool v) => json['viewed'] = v;
  int get viewCount => (json['viewCount'] as num?)?.toInt() ?? 0;
  DateTime get time => DateTime.parse(json['createdAt'] as String).toLocal();
}

class StatusGroup {
  StatusGroup(this.ownerId, this.items);
  final String ownerId;
  final List<StatusItem> items;
  bool get allViewed => items.every((i) => i.viewed);
  DateTime get latest => items.last.time;
}

const statusBackgrounds = [0xFF5B5BF7, 0xFF8B5CF6, 0xFFDB2777, 0xFF0EA5E9, 0xFF059669, 0xFFD97706, 0xFFDC2626, 0xFF0F172A];

/// Status updates that disappear after 24 hours, end-to-end encrypted for the people allowed to see them
/// (a port of the web's lib/chat/status.ts).
class Statuses extends ChangeNotifier {
  Statuses(this.chat) {
    chat.on('status:update', (_) {
      _debounce?.cancel();
      _debounce = Timer(const Duration(milliseconds: 300), () => load().catchError((_) {}));
    });
    load().catchError((_) {});
  }

  final Chat chat;
  bool loaded = false;
  List<StatusItem> mine = [];
  List<StatusGroup> groups = [];
  List<String> muted = [];
  Timer? _debounce;
  final _viewedSent = <String>{};

  Future<List<StatusItem>> _decrypt(List<Json> list) async {
    final keys = chat.session.keys;
    final known = await chat.keysFor(list.map((s) => s['senderDeviceId'] as String));
    return list.map((s) {
      Json? body;
      final sender = known[s['senderDeviceId']];
      if (keys != null && s['sealedKey'] != null && sender != null) {
        try {
          body = Crypto.instance.open(ciphertext: s['ciphertext'] as String, nonce: s['nonce'] as String, sealedKey: s['sealedKey'] as String, senderIdentityKey: sender, receiver: keys);
        } catch (_) {}
      }
      return StatusItem(s, body);
    }).toList();
  }

  Future<void> load() async {
    final feed = await api.get('/chat/status/feed');
    final results = await Future.wait([_decrypt((feed['mine'] as List).cast<Json>()), _decrypt((feed['others'] as List).cast<Json>())]);
    mine = results[0];
    final byOwner = <String, List<StatusItem>>{};
    for (final item in results[1].where((s) => s.body != null)) {
      byOwner.putIfAbsent(item.ownerId, () => []).add(item);
    }
    groups = byOwner.entries.map((e) => StatusGroup(e.key, e.value)).toList()..sort((a, b) => b.latest.compareTo(a.latest));
    muted = List<String>.from(feed['mutedOwnerIds'] as List? ?? []);
    chat.loadProfiles(groups.map((g) => g.ownerId));
    loaded = true;
    notifyListeners();
  }

  /// Who sees my status, following my Status privacy choice.
  Future<List<String>> _audience() async {
    final results = await Future.wait([api.get('/users/me'), api.get('/users/me/contacts')]);
    final setting = (results[0]['privacy'] as Map?)?['status'];
    if (setting == 'nobody') return [];
    final people = <String>{for (final c in results[1]['contacts'] as List) c['id'] as String};
    if (setting == 'everyone') {
      for (final c in chat.conversations.values) {
        if (c.peerId != null) people.add(c.peerId!);
      }
    }
    return people.toList();
  }

  Future<void> _post(String kind, Json body, [String? mediaId]) async {
    final keys = chat.session.keys;
    if (keys == null) throw StateError('Device keys are not ready');
    final people = await _audience();
    final result = await api.post('/chat/status/devices', {'userIds': people});
    final devices = (result['devices'] as List).map((d) => Recipient.fromJson(d as Json)).toList();
    chat.rememberKeys(devices);
    final sealed = Crypto.instance.seal(body, keys, devices);
    await api.post('/chat/status', {'kind': kind, ...sealed.toJson(), 'audience': people, 'mediaId': ?mediaId});
    await load();
  }

  Future<void> postText(String text, int background) => _post('text', {'v': 1, 'text': text, 'background': '#${(background & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}', 'font': 0});

  Future<void> postMedia(Uint8List bytes, {required bool video, required String name, required String mime, Json extra = const {}, String caption = ''}) async {
    final uploaded = await Media.uploadEncrypted(bytes, 'status');
    final attachment = {'mime': mime, 'name': name, 'size': bytes.length, ...extra, 'mediaId': uploaded.mediaId, 'key': uploaded.key, 'header': uploaded.header};
    await _post(video ? 'video' : 'image', {'v': 1, if (caption.isNotEmpty) 'text': caption, 'attachment': attachment}, uploaded.mediaId);
  }

  void markViewed(StatusItem item) {
    if (item.viewed || item.ownerId == chat.me || !_viewedSent.add(item.id)) return;
    item.viewed = true;
    notifyListeners();
    api.post('/chat/status/${item.id}/view').catchError((_) => _viewedSent.remove(item.id));
  }

  Future<void> react(String id, String reaction) => api.post('/chat/status/$id/view', {'reaction': reaction});

  Future<List<Json>> viewers(String id) async {
    final r = await api.get('/chat/status/$id/viewers');
    final list = (r['viewers'] as List).cast<Json>();
    chat.loadProfiles(list.map((v) => v['userId'] as String));
    return list;
  }

  Future<void> delete(String id) async {
    await api.delete('/chat/status/$id');
    await load();
  }
}

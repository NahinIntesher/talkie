import '../core/api.dart';
import '../core/crypto.dart';
import '../core/session.dart';
import 'chat.dart';
import 'models.dart';

String? historyTransferCode(Session session) {
  final id = session.deviceId;
  final key = session.keys?.publicKey;
  return id == null || key == null ? null : '$id.$key';
}

String historyApprovalCode(String identityKey) => Crypto.instance.safetyNumber(identityKey, identityKey).replaceAll(' ', '').substring(0, 12);

Future<({int added, int unreadable})> recoverHistory(Chat chat, String code, bool setup) async {
  final pair = Crypto.instance.recoveryPair(code);
  final result = setup ? await api.put('/chat/history/backup', {'identityKey': pair.publicKey}) : await api.get('/chat/history/backup');
  final backup = result['backup'];
  if (backup == null || backup['identityKey'] != pair.publicKey) throw const FormatException('Recovery key does not match');
  final target = historyTransferCode(chat.session);
  if (target == null) throw StateError('Device is still connecting');
  final saved = await transferHistory(chat, "${backup['deviceId']}.${backup['identityKey']}", purpose: 'backup');
  final restored = await transferHistory(chat, target, purpose: 'restore', readWith: pair);
  await chat.loadConversations();
  return (added: restored.added, unreadable: saved.unreadable + restored.unreadable);
}

Future<({int added, int unreadable})> transferHistory(Chat chat, String code, {String? purpose, DeviceKeyPair? readWith}) async {
  final session = chat.session;
  final sourceId = session.deviceId;
  final source = session.keys;
  final match = RegExp(r'^([1-9]\d{0,19})\.([A-Za-z0-9_-]{43})$').firstMatch(code.trim());
  if (match == null || source == null || sourceId == null || purpose == null && match[1] == sourceId) throw const FormatException('Invalid device code');
  final recipient = Recipient(deviceId: match[1]!, identityKey: match[2]!);
  final target = {'deviceId': recipient.deviceId, 'identityKey': recipient.identityKey};
  final crypto = Crypto.instance;
  String? before;
  var added = 0;
  var unreadable = 0;
  do {
    if (session.deviceId != sourceId) throw StateError('Source device changed');
    final query = Uri(queryParameters: {...target, 'purpose': ?purpose, 'before': ?before}).query;
    final page = await api.get('/chat/history/transfer?$query') as Json;
    final entries = (page['keys'] as List).cast<Json>();
    final senders = await chat.keysFor(entries.map((item) => item['keySenderDeviceId'] as String));
    final keys = <Json>[];
    for (final item in entries) {
      final sender = senders[item['keySenderDeviceId']];
      try {
        if (sender == null) throw StateError('Missing sender key');
        final secret = crypto.openSecret(item['sealedKey'] as String, sender, readWith ?? source);
        keys.add({
          'messageId': item['messageId'],
          'nonce': item['nonce'],
          'sealedKey': crypto.sealSecret(secret, source, [recipient]).single.sealedKey,
        });
      } catch (_) {
        unreadable++;
      }
    }
    if (keys.isNotEmpty) {
      final result = await api.post('/chat/history/transfer', {'target': target, 'purpose': ?purpose, 'keys': keys}) as Json;
      added += result['added'] as int;
    }
    before = page['nextBefore'] as String?;
  } while (before != null);
  if (purpose == null) await api.post('/chat/history/requests/complete', {...target, 'transferred': added > 0});
  return (added: added, unreadable: unreadable);
}

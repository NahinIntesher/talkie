import 'dart:async';
import 'dart:convert';
import 'dart:isolate';
import 'dart:ui';

import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../chat/chat.dart';
import 'crypto.dart';
import 'session.dart';
import 'api.dart';

const replyPort = 'talkie.notificationReplies';
const _storage = FlutterSecureStorage();
const _prefix = 'talkie.inline.';

Future<void> deliverReplies(Chat chat) async {
  final device = chat.session.deviceId;
  if (device == null) return;
  final entries = await _storage.readAll();
  for (final e in entries.entries.where(
    (e) => e.key.startsWith('$_prefix$device.'),
  )) {
    final item = jsonDecode(e.value) as Map<String, dynamic>;
    if (item['userId'] != chat.me || device != chat.session.deviceId) continue;
    try {
      await chat.sendText(
        item['conversationId'] as String,
        item['text'] as String,
        requestId: e.key.split('.').last,
      );
      await _storage.delete(key: e.key);
    } on ApiError catch (error) {
      if ([400, 403, 404, 410, 422].contains(error.status)) {
        final bn = item['locale'] != 'en';
        await FlutterLocalNotificationsPlugin().show(
          id: item['conversationId'].hashCode & 0x7fffffff,
          title: 'Talkie',
          body: bn
              ? 'উত্তর পাঠানো যায়নি। চ্যাট খুলে দেখুন।'
              : 'Reply could not be sent. Open the chat.',
          payload: jsonEncode({
            'deviceId': device,
            'userId': chat.me,
            'conversationId': item['conversationId'],
          }),
          notificationDetails: NotificationDetails(
            android: AndroidNotificationDetails(
              'messages',
              bn ? 'মেসেজ' : 'Messages',
              icon: 'ic_stat_talkie',
            ),
          ),
        );
        await _storage.delete(key: e.key);
      }
    }
  }
}

@pragma('vm:entry-point')
void notificationReply(NotificationResponse response) async {
  WidgetsFlutterBinding.ensureInitialized();
  if (IsolateNameServer.lookupPortByName(replyPort) == null) DartPluginRegistrant.ensureInitialized();
  final text = response.input?.trim();
  if (response.actionId != 'reply' ||
      text == null ||
      text.isEmpty ||
      response.payload == null) {
    return;
  }
  final item = jsonDecode(response.payload!) as Map<String, dynamic>;
  final stored = await _storage.read(key: 'talkie.device');
  if (stored == null || jsonDecode(stored)['deviceId'] != item['deviceId']) {
    return;
  }
  final crypto = await Crypto.init();
  await _storage.write(
    key: '$_prefix${item['deviceId']}.${crypto.clientMessageId()}',
    value: jsonEncode({...item, 'text': text}),
  );
  final active = IsolateNameServer.lookupPortByName(replyPort);
  if (active != null) {
    active.send(true);
    return;
  }
  final session = Session();
  try {
    await session.restore();
    if (session.status == SessionStatus.signedIn &&
        session.deviceId == item['deviceId']) {
      await deliverReplies(Chat(session));
    }
  } finally {
    session.dispose();
  }
}

class ReplyListener {
  final port = ReceivePort();
  bool sending = false;
  bool pending = false;
  void start(Chat chat) {
    IsolateNameServer.removePortNameMapping(replyPort);
    IsolateNameServer.registerPortWithName(port.sendPort, replyPort);
    port.listen((_) => flush(chat));
    flush(chat);
  }

  Future<void> flush(Chat chat) async {
    pending = true;
    if (sending) return;
    sending = true;
    try {
      while (pending) {
        pending = false;
        await deliverReplies(chat);
      }
    } catch (_) {
      /* Retry the encrypted outbox on resume. */
    } finally {
      sending = false;
    }
  }

  void close() {
    IsolateNameServer.removePortNameMapping(replyPort);
    port.close();
  }
}

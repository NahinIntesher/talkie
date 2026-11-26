import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'api.dart';

/// Push notifications through Firebase Cloud Messaging.
///
/// The server sends "notification" messages (title + body + data). Android shows them by itself while the app is in
/// the background; in the foreground the live connection already updates the screen, so nothing extra is shown.
/// Message text is never in a notification (it is end-to-end encrypted): only who wrote and what kind of message.
///
/// Without `android/app/google-services.json` Firebase is not set up and everything here quietly does nothing.
class Push {
  Push._();
  static final Push instance = Push._();

  bool _ready = false;
  StreamSubscription<String>? _refresh;

  /// The chat to open after the person tapped a message notification.
  final ValueNotifier<String?> openConversation = ValueNotifier(null);

  bool get available => _ready;

  /// Called once at start-up, before the first screen.
  Future<void> init({required bool bangla}) async {
    try {
      await Firebase.initializeApp();
    } catch (error) {
      debugPrint('Talkie push: Firebase is not configured ($error)');
      return;
    }
    _ready = true;
    // Channels the server's notifications use (people can tune them separately in Android settings).
    final android = FlutterLocalNotificationsPlugin().resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    await android?.createNotificationChannel(AndroidNotificationChannel(
      'messages',
      bangla ? 'মেসেজ' : 'Messages',
      importance: Importance.high,
    ));
    await android?.createNotificationChannel(AndroidNotificationChannel(
      'calls',
      bangla ? 'কল' : 'Calls',
      importance: Importance.max,
      audioAttributesUsage: AudioAttributesUsage.notificationRingtone,
    ));
    FirebaseMessaging.onMessageOpenedApp.listen(_opened);
    final initial = await FirebaseMessaging.instance.getInitialMessage();
    if (initial != null) _opened(initial);
  }

  void _opened(RemoteMessage message) {
    // Calls: opening the app is enough, the call screen comes from the live connection.
    if (message.data['type'] == 'message') openConversation.value = message.data['conversationId'] as String?;
  }

  /// After sign-in: ask for permission and tell the server where to reach this device.
  Future<void> register() async {
    if (!_ready) return;
    try {
      final settings = await FirebaseMessaging.instance.requestPermission();
      if (settings.authorizationStatus == AuthorizationStatus.denied) return;
      // onRegistered gives the device token now and again whenever Firebase rotates it.
      _refresh ??= FirebaseMessaging.instance.onRegistered.listen((token) => _send(token));
      await FirebaseMessaging.instance.register();
    } catch (error) {
      debugPrint('Talkie push: could not register ($error)');
    }
  }

  Future<void> _send(String token) => api.put('/notify/push-token', {'provider': 'fcm', 'token': token}).then((_) {}, onError: (_) {});

  /// Before sign-out: this device should get nothing for this account any more.
  Future<void> unregister() async {
    if (!_ready) return;
    await _refresh?.cancel();
    _refresh = null;
    try {
      await api.delete('/notify/push-token');
    } catch (_) {}
    try {
      await FirebaseMessaging.instance.unregister();
    } catch (_) {}
  }
}

final push = Push.instance;

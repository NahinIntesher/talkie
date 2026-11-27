import 'dart:async';
import 'dart:convert';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api.dart';
import 'notification_reply.dart';

@pragma('vm:entry-point')
Future<void> backgroundMessage(RemoteMessage message) async {
  if (message.data['type'] != 'message' || message.notification != null) return;
  await Firebase.initializeApp();
  await Push.instance._local(message.data['locale'] != 'en');
  await Push.instance._showMessage(message, null);
}

/// Push notifications through Firebase Cloud Messaging.
///
/// Android shows FCM notifications in the background. In the foreground, show message banners for other chats.
/// Message text is never in a notification (it is end-to-end encrypted): only who wrote and what kind of message.
///
/// Without `android/app/google-services.json` Firebase is not set up and everything here quietly does nothing.
class Push {
  Push._();
  static final Push instance = Push._();

  bool _ready = false;
  bool _registering = false;
  int _session = 0;
  StreamSubscription<String>? _refresh;
  StreamSubscription<RemoteMessage>? _foreground;
  final _notifications = FlutterLocalNotificationsPlugin();
  static const _storage = FlutterSecureStorage();
  static const _permissionAsked = 'talkie.pushPermissionAsked';
  late AndroidNotificationChannel _messages;
  String? _unsentToken;

  /// The chat to open after the person tapped a message notification.
  final ValueNotifier<String?> openConversation = ValueNotifier(null);

  bool get available => _ready;

  /// Called once at start-up, before the first screen.
  Future<void> init({required bool bangla}) async {
    try {
      await Firebase.initializeApp();
      FirebaseMessaging.onBackgroundMessage(backgroundMessage);
      await _configureNotifications(bangla);
    } catch (error) {
      debugPrint('Talkie push: could not initialize ($error)');
    }
  }

  Future<void> _local(bool bangla) async {
    _messages = AndroidNotificationChannel(
      'messages',
      bangla ? 'মেসেজ' : 'Messages',
      importance: Importance.high,
    );
    await _notifications.initialize(
      settings: const InitializationSettings(android: AndroidInitializationSettings('ic_stat_talkie')),
      onDidReceiveNotificationResponse: (response) {
        if (response.actionId == 'reply') { notificationReply(response); return; }
        _openPayload(response.payload);
      },
      onDidReceiveBackgroundNotificationResponse: notificationReply,
    );
  }

  Future<void> _openPayload(String? payload) async {
    if (payload == null) return;
    if (payload.startsWith('{')) {
      final item = jsonDecode(payload);
      final stored = await _storage.read(key: 'talkie.device');
      if (stored == null || item['deviceId'] != null && jsonDecode(stored)['deviceId'] != item['deviceId']) return;
      openConversation.value = item['conversationId'] as String?;
    } else { openConversation.value = payload; }
  }

  Future<void> _configureNotifications(bool bangla) async {
    await _local(bangla);
    final localLaunch = await _notifications.getNotificationAppLaunchDetails();
    if (localLaunch?.didNotificationLaunchApp == true) _openPayload(localLaunch?.notificationResponse?.payload);
    final android = _notifications.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    await android?.createNotificationChannel(_messages);
    await android?.createNotificationChannel(AndroidNotificationChannel(
      'calls',
      bangla ? 'কল' : 'Calls',
      importance: Importance.max,
      audioAttributesUsage: AudioAttributesUsage.notificationRingtone,
    ));
    FirebaseMessaging.onMessageOpenedApp.listen(_opened);
    final initial = await FirebaseMessaging.instance.getInitialMessage();
    if (initial != null) _opened(initial);
    _ready = true;
  }

  void _opened(RemoteMessage message) {
    // Calls: opening the app is enough, the call screen comes from the live connection.
    if (message.data['type'] == 'message') unawaited(_openPayload(jsonEncode(message.data)));
  }

  /// After sign-in: ask for permission and tell the server where to reach this device.
  Future<void> register({required String? Function() openChat, bool requestPermission = true}) async {
    if (!_ready || _registering) return;
    if (_refresh != null) {
      if (_unsentToken case final token?) await _send(token);
      return;
    }
    _registering = true;
    final session = _session;
    try {
      final fcm = FirebaseMessaging.instance;
      var settings = await fcm.getNotificationSettings();
      if (settings.authorizationStatus != AuthorizationStatus.authorized && requestPermission && await _storage.read(key: _permissionAsked) == null) {
        if (session != _session) return;
        settings = await fcm.requestPermission();
        await _storage.write(key: _permissionAsked, value: '1');
      }
      if (session != _session || settings.authorizationStatus != AuthorizationStatus.authorized) return;
      // Android sends a Firebase Installation ID here. FCM HTTP v1 also accepts it in the token field.
      _refresh = fcm.onRegistered.listen((installationId) => _send(installationId));
      await fcm.register();
      if (session != _session) return;
      _foreground = FirebaseMessaging.onMessage.listen((message) => _showMessage(message, openChat()));
    } catch (error) {
      await _refresh?.cancel();
      _refresh = null;
      debugPrint('Talkie push: could not register ($error)');
    } finally {
      _registering = false;
    }
  }

  Future<void> _showMessage(RemoteMessage message, String? activeChat) async {
    final id = message.data['conversationId'];
    if (message.data['type'] != 'message' || id is! String || id == activeChat) return;
    final device = message.data['deviceId'];
    if (device != null) {
      final saved = await _storage.read(key: 'talkie.device');
      if (saved == null || jsonDecode(saved)['deviceId'] != device) return;
    }
    final reply = message.data['locale'] == 'en' ? 'Reply' : 'উত্তর দিন';
    try {
      await _notifications.show(
        id: id.hashCode & 0x7fffffff,
        title: message.notification?.title ?? message.data['title'] as String? ?? 'Talkie',
        body: message.notification?.body ?? message.data['body'] as String?,
        payload: jsonEncode({'conversationId': id, 'userId': message.data['userId'], 'deviceId': device, 'locale': message.data['locale']}),
        notificationDetails: NotificationDetails(android: AndroidNotificationDetails(
          _messages.id, _messages.name, importance: Importance.high, priority: Priority.high, tag: id,
          category: AndroidNotificationCategory.message,
          actions: [if (device != null) AndroidNotificationAction('reply', reply, inputs: [AndroidNotificationActionInput(label: reply)])],
        )),
      );
    } catch (error) {
      debugPrint('Talkie push: could not show a message notification ($error)');
    }
  }

  Future<void> _send(String token) async {
    _unsentToken = token;
    try {
      await api.put('/notify/push-token', {'provider': 'fcm', 'token': token, 'inlineReply': true});
      if (_unsentToken == token) _unsentToken = null;
    } catch (_) { /* Retry on resume. */ }
  }

  /// Before sign-out: this device should get nothing for this account any more.
  Future<void> unregister({bool server = true}) async {
    if (!_ready) return;
    _session++;
    _unsentToken = null;
    await _refresh?.cancel();
    _refresh = null;
    await _foreground?.cancel();
    _foreground = null;
    try {
      await _notifications.cancelAll();
    } catch (_) {}
    if (server) {
      try {
        await api.delete('/notify/push-token');
      } catch (_) {}
    }
    try {
      await FirebaseMessaging.instance.unregister();
    } catch (_) {}
  }
}

final push = Push.instance;

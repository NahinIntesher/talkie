import 'dart:async';
import 'dart:convert';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api.dart';
import 'chat_bubbles.dart';
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
  bool _localReady = false;
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
      await _configureLocalNotifications(bangla);
      await Firebase.initializeApp();
      FirebaseMessaging.onBackgroundMessage(backgroundMessage);
      FirebaseMessaging.onMessageOpenedApp.listen(_opened);
      final initial = await FirebaseMessaging.instance.getInitialMessage();
      if (initial != null) _opened(initial);
      _ready = true;
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

  Future<void> _configureLocalNotifications(bool bangla) async {
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
    _localReady = true;
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
    if (message.data['type'] != 'message' || id is! String || !validBubbleId(id) || id == activeChat) return;
    final device = message.data['deviceId'];
    if (device != null) {
      final saved = await _storage.read(key: 'talkie.device');
      if (saved == null || jsonDecode(saved)['deviceId'] != device) return;
    }
    try {
      await _postChat(
        conversation: id,
        device: device as String?,
        user: message.data['userId'] as String?,
        title: message.notification?.title ?? message.data['title'] as String? ?? 'Talkie',
        body: message.notification?.body ?? message.data['body'] as String?,
        locale: message.data['locale'] as String?,
      );
    } catch (error) {
      debugPrint('Talkie push: could not show a message notification ($error)');
    }
  }

  Future<bool> openBubble({required String conversation, required String device, required String user, required String title, required String locale}) async {
    if (!_localReady || !validBubbleId(conversation)) return false;
    return _postChat(conversation: conversation, device: device, user: user, title: title,
      body: locale == 'en' ? 'Open chat' : 'চ্যাট খুলুন', locale: locale, expand: true);
  }

  Future<bool> _postChat({required String conversation, required String? device, required String? user,
    required String title, required String? body, required String? locale, bool expand = false}) async {
    if (title.trim().isEmpty) title = 'Talkie';
    final state = await bubbleStatus(device);
    final bubble = state.enabled && state.supported;
    var id = 0;
    for (final digit in conversation.codeUnits) {
      id = (31 * id + digit) & 0x7fffffff;
    }
    final reply = locale == 'en' ? 'Reply' : 'উত্তর দিন';
    await _notifications.show(
      id: id, title: title, body: body,
      payload: jsonEncode({'conversationId': conversation, 'userId': user, 'deviceId': device, 'locale': locale}),
      notificationDetails: NotificationDetails(android: AndroidNotificationDetails(
        _messages.id, _messages.name, importance: Importance.high, priority: Priority.high, tag: conversation,
        category: AndroidNotificationCategory.message,
        visibility: NotificationVisibility.private,
        silent: expand,
        styleInformation: bubble ? MessagingStyleInformation(
          Person(name: locale == 'en' ? 'You' : 'আপনি'),
          messages: [Message(body ?? '', DateTime.now(), Person(name: title))],
        ) : null,
        actions: [if (device != null) AndroidNotificationAction('reply', reply, cancelNotification: !bubble, inputs: [AndroidNotificationActionInput(label: reply)])],
      )),
    );
    if (!bubble) return false;
    final metadata = {
      'notificationId': id, 'conversation': conversation, 'device': device, 'title': title, 'expand': expand,
    };
    // Android enqueues notify() asynchronously, so the first lookup may precede the system post.
    for (final pause in [Duration.zero, const Duration(milliseconds: 120), const Duration(milliseconds: 350)]) {
      if (pause != Duration.zero) await Future<void>.delayed(pause);
      if (await bubbleChannel.invokeMethod<bool>('decorate', metadata).catchError((Object _) => false) == true) return true;
    }
    return false;
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

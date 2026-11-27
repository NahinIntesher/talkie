import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api.dart';

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

  /// The chat to open after the person tapped a message notification.
  final ValueNotifier<String?> openConversation = ValueNotifier(null);

  bool get available => _ready;

  /// Called once at start-up, before the first screen.
  Future<void> init({required bool bangla}) async {
    try {
      await Firebase.initializeApp();
      await _configureNotifications(bangla);
    } catch (error) {
      debugPrint('Talkie push: could not initialize ($error)');
    }
  }

  Future<void> _configureNotifications(bool bangla) async {
    _messages = AndroidNotificationChannel(
      'messages',
      bangla ? 'মেসেজ' : 'Messages',
      importance: Importance.high,
    );
    await _notifications.initialize(
      settings: const InitializationSettings(android: AndroidInitializationSettings('ic_stat_talkie')),
      onDidReceiveNotificationResponse: (response) => openConversation.value = response.payload,
    );
    final localLaunch = await _notifications.getNotificationAppLaunchDetails();
    if (localLaunch?.didNotificationLaunchApp == true) openConversation.value = localLaunch?.notificationResponse?.payload;
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
    if (message.data['type'] == 'message') openConversation.value = message.data['conversationId'] as String?;
  }

  /// After sign-in: ask for permission and tell the server where to reach this device.
  Future<void> register({required String? Function() openChat, bool requestPermission = true}) async {
    if (!_ready || _registering || _refresh != null) return;
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
      // onRegistered gives the device token now and again whenever Firebase rotates it.
      _refresh = fcm.onRegistered.listen((token) => _send(token));
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
    final notification = message.notification;
    if (message.data['type'] != 'message' || id is! String || id == activeChat || notification == null) return;
    try {
      await _notifications.show(
        id: id.hashCode & 0x7fffffff,
        title: notification.title,
        body: notification.body,
        payload: id,
        notificationDetails: NotificationDetails(android: AndroidNotificationDetails(
          _messages.id, _messages.name, importance: Importance.high, priority: Priority.high,
        )),
      );
    } catch (error) {
      debugPrint('Talkie push: could not show a message notification ($error)');
    }
  }

  Future<void> _send(String token) => api.put('/notify/push-token', {'provider': 'fcm', 'token': token}).then((_) {}, onError: (_) {});

  /// Before sign-out: this device should get nothing for this account any more.
  Future<void> unregister({bool server = true}) async {
    if (!_ready) return;
    _session++;
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

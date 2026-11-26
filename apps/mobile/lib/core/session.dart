import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api.dart';
import 'crypto.dart';
import 'push.dart';

enum SessionStatus { loading, signedOut, signedIn }

/// Who is signed in on this phone. The refresh token and this device's private key live in Android's
/// encrypted storage (Keystore-backed); the access token only in memory.
class Session extends ChangeNotifier {
  Session() {
    api.refresh = _refresh;
    api.onSignedOut = () => _clear(notify: true);
  }

  static const _storage = FlutterSecureStorage();
  static const _refreshKey = 'talkie.refresh';
  static const _deviceKey = 'talkie.device';

  SessionStatus status = SessionStatus.loading;
  Map<String, dynamic>? user;
  String? deviceId;
  DeviceKeyPair? keys;
  DeviceKeyPair? _pending;
  Future<bool>? _refreshing;

  String get userId => user?['id'] as String? ?? '';

  Future<void> restore() async {
    final stored = await _storage.read(key: _deviceKey);
    if (stored != null) {
      final json = jsonDecode(stored) as Map<String, dynamic>;
      deviceId = json['deviceId'] as String?;
      keys = DeviceKeyPair.fromJson(json['keys'] as Map<String, dynamic>);
    }
    if (await _refresh()) {
      try {
        await loadMe();
        status = SessionStatus.signedIn;
      } catch (_) {
        status = SessionStatus.signedOut;
      }
    } else {
      status = SessionStatus.signedOut;
    }
    notifyListeners();
  }

  Future<void> loadMe() async {
    final results = await Future.wait([api.get('/users/me'), api.get('/auth/account')]);
    user = {...(results[0]['profile'] as Map<String, dynamic>), 'email': results[1]['email'], 'role': results[1]['role']};
    deviceId = results[1]['deviceId'] as String;
    if (keys == null) {
      // This phone lost its keys (reinstall): make new ones and publish the public half.
      keys = Crypto.instance.generateDeviceKeys();
      await api.put('/auth/devices/current/identity-key', {'identityKey': keys!.publicKey});
      await _saveDevice();
    }
  }

  Future<bool> _refresh() {
    return _refreshing ??= () async {
      try {
        final token = await _storage.read(key: _refreshKey);
        if (token == null) return false;
        final result = await api.post('/auth/refresh', {'refreshToken': token});
        await _applyTokens(result['tokens'] as Map<String, dynamic>);
        return true;
      } on ApiError catch (error) {
        if (error.status == 401 || error.status == 403) await _clear();
        return false;
      } finally {
        scheduleMicrotask(() => _refreshing = null);
      }
    }();
  }

  Future<void> _applyTokens(Map<String, dynamic> tokens) async {
    api.accessToken = tokens['accessToken'] as String;
    if (tokens['refreshToken'] != null) await _storage.write(key: _refreshKey, value: tokens['refreshToken'] as String);
  }

  Future<void> _saveDevice() => _storage.write(key: _deviceKey, value: jsonEncode({'deviceId': deviceId, 'keys': keys!.toJson()}));

  /// The device details sent when signing in. A fresh key pair is made for every new sign-in.
  Map<String, dynamic> deviceInfo() {
    _pending = Crypto.instance.generateDeviceKeys();
    return {'name': 'Android phone', 'platform': 'android', 'identityKey': _pending!.publicKey};
  }

  /// Called with the result of a successful code check or sign-up.
  Future<void> signedIn(Map<String, dynamic> result) async {
    await _applyTokens(result['tokens'] as Map<String, dynamic>);
    user = result['user'] as Map<String, dynamic>;
    deviceId = result['deviceId'] as String;
    keys = _pending;
    _pending = null;
    await _saveDevice();
    status = SessionStatus.signedIn;
    notifyListeners();
  }

  void updateUser(Map<String, dynamic> patch) {
    user = {...?user, ...patch};
    notifyListeners();
  }

  Future<void> signOut() async {
    await push.unregister();
    try {
      await api.post('/auth/logout');
    } catch (_) {}
    await _clear(notify: true);
  }

  Future<void> _clear({bool notify = false}) async {
    api.accessToken = null;
    user = null;
    keys = null;
    deviceId = null;
    await _storage.delete(key: _refreshKey);
    await _storage.delete(key: _deviceKey);
    status = SessionStatus.signedOut;
    if (notify) notifyListeners();
  }
}

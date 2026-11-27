import 'dart:async';
import 'dart:convert';
import 'dart:isolate';
import 'dart:ui';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api.dart';
import 'crypto.dart';
import 'push.dart';

enum SessionStatus { loading, reconnecting, signedOut, signedIn }

/// Who is signed in on this phone. The refresh token and this device's private key live in Android's
/// encrypted storage (Keystore-backed); the access token only in memory.
class Session extends ChangeNotifier {
  Session() {
    api.refresh = _refresh;
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
  String? _deviceName;
  int _generation = 0;

  String get userId => user?['id'] as String? ?? '';

  Future<void> restore() async {
    status = SessionStatus.loading;
    notifyListeners();
    try {
      if (await _storage.read(key: _refreshKey) == null) {
        status = SessionStatus.signedOut;
        return;
      }
      final stored = await _storage.read(key: _deviceKey);
      if (stored != null) {
        final json = jsonDecode(stored) as Map<String, dynamic>;
        deviceId = json['deviceId'] as String?;
        keys = DeviceKeyPair.fromJson(json['keys'] as Map<String, dynamic>);
        user = json['user'] as Map<String, dynamic>?;
      }
      if (await _refresh()) {
        await loadMe();
        status = SessionStatus.signedIn;
      } else if (status == SessionStatus.loading) {
        status = user == null ? SessionStatus.reconnecting : SessionStatus.signedIn;
      }
    } catch (_) {
      if (status == SessionStatus.loading) status = user == null ? SessionStatus.reconnecting : SessionStatus.signedIn;
    } finally {
      notifyListeners();
    }
  }

  Future<void> loadMe() async {
    final results = await Future.wait([api.get('/users/me'), api.get('/auth/account')]);
    final currentDevice = results[1]['deviceId'] as String;
    if (deviceId != null && currentDevice != deviceId) throw StateError('The stored keys belong to another device');
    if (keys == null) {
      // This phone lost its keys (reinstall): make new ones and publish the public half.
      final candidate = Crypto.instance.generateDeviceKeys();
      await api.put('/auth/devices/current/identity-key', {'identityKey': candidate.publicKey});
      keys = candidate;
    }
    deviceId = currentDevice;
    user = {...(results[0]['profile'] as Map<String, dynamic>), 'email': results[1]['email'], 'role': results[1]['role']};
    await _saveDevice();
  }

  Future<bool> _refresh() {
    return _refreshing ??= () async {
      final generation = _generation;
      // The notification action engine and the visible app share secure storage in the same Android process.
      const lock = 'talkie.auth.refresh';
      final owner = ReceivePort();
      var acquired = false;
      try {
        final deadline = DateTime.now().add(const Duration(seconds: 28));
        while (!(acquired = IsolateNameServer.registerPortWithName(owner.sendPort, lock))) {
          if (DateTime.now().isAfter(deadline) || generation != _generation) return false;
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
        final stored = await _storage.read(key: _refreshKey);
        if (stored == null || generation != _generation) return false;
        final record = stored.startsWith('{') ? jsonDecode(stored) as Map<String, dynamic> : {'token': stored};
        final attempt = record['attempt'] as String? ?? Crypto.instance.random(16).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
        if (record['attempt'] == null) await _storage.write(key: _refreshKey, value: jsonEncode({...record, 'attempt': attempt}));
        if (generation != _generation) return false;
        final result = await api.post('/auth/refresh', {'refreshToken': record['token'], 'attempt': attempt});
        if (generation != _generation) return false;
        await _applyTokens(result['tokens'] as Map<String, dynamic>);
        return true;
      } on ApiError catch (error) {
        if (generation == _generation && (error.code == 'session_revoked' || error.code == 'unauthorized' || error.code == 'forbidden')) await _clear(notify: true);
        return false;
      } catch (_) {
        return false;
      } finally {
        if (acquired) IsolateNameServer.removePortNameMapping(lock);
        owner.close();
        scheduleMicrotask(() => _refreshing = null);
      }
    }();
  }

  Future<void> _applyTokens(Map<String, dynamic> tokens) async {
    if (tokens['refreshToken'] != null) await _storage.write(key: _refreshKey, value: tokens['refreshToken'] as String);
    api.accessToken = tokens['accessToken'] as String;
  }

  Future<void> _saveDevice() => _storage.write(key: _deviceKey, value: jsonEncode({'deviceId': deviceId, 'keys': keys!.toJson(), 'user': user}));

  /// The device details sent when signing in. A fresh key pair is made for every new sign-in.
  Future<Map<String, dynamic>> deviceInfo() async {
    if (_deviceName == null) {
      try {
        final android = await DeviceInfoPlugin().androidInfo;
        final model = '${android.manufacturer} ${android.model}'.trim();
        final label = '$model · Android ${android.version.release}';
        if (model.isNotEmpty && label.length <= 80) _deviceName = label;
      } catch (_) {}
    }
    _pending = Crypto.instance.generateDeviceKeys();
    return {'name': _deviceName ?? 'Android phone', 'platform': 'android', 'identityKey': _pending!.publicKey};
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
    try {
      await api.post('/auth/logout');
    } on ApiError {
      if (status != SessionStatus.signedOut) rethrow;
    }
    await deviceRevoked();
  }

  Future<void> deviceRevoked() async {
    await _clear(notify: true);
    await push.unregister(server: false);
  }

  Future<void> _clear({bool notify = false}) async {
    _generation++;
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

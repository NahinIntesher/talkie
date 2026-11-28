import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'config.dart';

class ApiError implements Exception {
  ApiError(this.status, this.code, this.message, [this.details]);
  final int status;
  final String code;
  final String message;
  final Map<String, dynamic>? details;
  @override
  String toString() => message;
}

/// JSON API client. Holds the short-lived access token; when a call is refused as expired it asks
/// [refresh] once for a new token and repeats the call.
class Api {
  Api._();
  static final Api instance = Api._();

  final http.Client _client = http.Client();
  String? accessToken;
  Future<bool> Function()? refresh;

  Map<String, String> get _headers => {
        'x-talkie-client': 'mobile',
        'x-talkie-device': 'Android',
        if (accessToken != null) 'authorization': 'Bearer $accessToken',
      };

  Future<dynamic> get(String path) => _send('GET', path);
  Future<dynamic> post(String path, [Object? body]) => _send('POST', path, body ?? const {});
  Future<dynamic> put(String path, [Object? body]) => _send('PUT', path, body ?? const {});
  Future<dynamic> patch(String path, [Object? body]) => _send('PATCH', path, body ?? const {});
  Future<dynamic> delete(String path) => _send('DELETE', path);

  Future<dynamic> _send(String method, String path, [Object? body, bool retried = false]) async {
    final abort = Completer<void>();
    final request = http.AbortableRequest(method, Uri.parse(Config.api(path)), abortTrigger: abort.future)..headers.addAll(_headers);
    // The shared-hosting HTTP/1.1 gateway has returned extra responses on reused connections.
    request.persistentConnection = false;
    request.headers['accept'] = 'application/json';
    if (body != null) {
      request.headers['content-type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    http.Response response;
    final timer = Timer(const Duration(seconds: 25), abort.complete);
    try {
      response = await _client.send(request).then(http.Response.fromStream);
    } catch (_) {
      throw ApiError(0, 'network', 'network');
    } finally {
      timer.cancel();
    }
    final text = utf8.decode(response.bodyBytes, allowMalformed: true);
    final isHtml = response.headers['content-type']?.contains('text/html') ?? false;
    if ((response.statusCode == 403 && RegExp(r'^\s*\{\s*"message"\s*:\s*"Access denied by Imunify360 bot-protection\.').hasMatch(text)) ||
        (isHtml && text.contains('Please wait while your request is being verified'))) {
      throw ApiError(response.statusCode, 'hosting_verification', 'Hosting verification blocked this request. Please try again later.');
    }
    if (response.statusCode == 401 && !retried && !path.startsWith('/auth/otp') && !path.startsWith('/auth/refresh') && refresh != null) {
      if (await refresh!()) return _send(method, path, body, true);
    }
    final dynamic data;
    try {
      data = text.isEmpty ? <String, dynamic>{} : jsonDecode(text);
    } on FormatException {
      throw ApiError(response.statusCode, 'invalid_response', 'Talkie could not read the server response. Try again.');
    }
    if (response.statusCode >= 400) {
      final error = (data is Map ? data['error'] : null) as Map<String, dynamic>? ?? {};
      throw ApiError(response.statusCode, error['code'] as String? ?? 'internal', error['message'] as String? ?? 'Error', error['details'] as Map<String, dynamic>?);
    }
    return data;
  }

  /// Uploads one binary part of a file.
  Future<void> putBytes(String path, Uint8List bytes) async {
    for (var attempt = 0; ; attempt++) {
      final response = await _client.put(Uri.parse(Config.api(path)), headers: {..._headers, 'content-type': 'application/octet-stream'}, body: bytes);
      if (response.statusCode < 300) return;
      if (response.statusCode == 401 && refresh != null && await refresh!()) continue;
      if (attempt >= 3 || (response.statusCode >= 400 && response.statusCode < 500)) throw ApiError(response.statusCode, 'upload', 'Upload failed');
      await Future<void>.delayed(Duration(milliseconds: 800 * (1 << attempt)));
    }
  }

  /// Downloads raw bytes (encrypted media).
  Future<Uint8List> getBytes(String path) async {
    var response = await _client.get(Uri.parse(Config.api(path)), headers: _headers);
    if (response.statusCode == 401 && refresh != null && await refresh!()) response = await _client.get(Uri.parse(Config.api(path)), headers: _headers);
    if (response.statusCode >= 300) throw ApiError(response.statusCode, 'download', 'Download failed');
    return response.bodyBytes;
  }
}

final api = Api.instance;

/// For reads and writes that carry an idempotency key.
Future<T> retryTemporary<T>(Future<T> Function() request) async {
  try {
    return await request();
  } on ApiError catch (error) {
    if (error.code == 'hosting_verification' ||
        (error.status != 0 && ![502, 503, 504].contains(error.status))) {
      rethrow;
    }
    await Future<void>.delayed(const Duration(milliseconds: 450));
    return request();
  }
}

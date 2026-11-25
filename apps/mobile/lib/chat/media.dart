import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:path_provider/path_provider.dart';

import '../core/api.dart';
import '../core/crypto.dart';
import 'models.dart';

/// Encrypted media: files are encrypted on the phone, uploaded in parts, and decrypted after download.
class Media {
  Media._();

  /// Encrypts and uploads; returns the reference fields to put inside the message.
  static Future<({String mediaId, String key, String header})> uploadEncrypted(Uint8List bytes, String purpose, {void Function(double)? onProgress}) async {
    final encrypted = await Crypto.instance.encryptFile(bytes);
    final created = await api.post('/media/uploads', {'purpose': purpose, 'byteSize': encrypted.data.length, 'contentType': 'application/octet-stream'});
    final mediaId = created['mediaId'] as String;
    await _putParts(mediaId, encrypted.data, (created['partSize'] as num).toInt(), onProgress);
    await api.post('/media/uploads/$mediaId/complete');
    final file = await _cacheFile(mediaId);
    await file.writeAsBytes(bytes, flush: true);
    return (mediaId: mediaId, key: encrypted.key, header: encrypted.header);
  }

  /// Profile and group photos (the server re-encodes them; not end-to-end encrypted).
  static Future<String> uploadPhoto(Uint8List bytes, String purpose, String contentType) async {
    final created = await api.post('/media/uploads', {'purpose': purpose, 'byteSize': bytes.length, 'contentType': contentType});
    final mediaId = created['mediaId'] as String;
    await _putParts(mediaId, bytes, (created['partSize'] as num).toInt(), null);
    await api.post('/media/uploads/$mediaId/complete');
    return mediaId;
  }

  static Future<void> _putParts(String mediaId, Uint8List data, int partSize, void Function(double)? onProgress) async {
    var index = 0;
    for (var offset = 0; offset < data.length; offset += partSize, index++) {
      final end = (offset + partSize).clamp(0, data.length);
      await api.putBytes('/media/uploads/$mediaId/parts/$index', Uint8List.sublistView(data, offset, end));
      onProgress?.call(end / data.length);
    }
  }

  static final _jobs = <String, Future<File>>{};

  static Future<File> _cacheFile(String mediaId) async {
    final dir = Directory('${(await getTemporaryDirectory()).path}/media');
    if (!dir.existsSync()) dir.createSync(recursive: true);
    return File('${dir.path}/$mediaId');
  }

  /// The decrypted file on disk (downloaded once, then kept in the app's cache folder).
  static Future<File> open(Json ref) {
    final mediaId = ref['mediaId'] as String;
    return _jobs[mediaId] ??= () async {
      final file = await _cacheFile(mediaId);
      if (file.existsSync() && file.lengthSync() > 0) return file;
      final data = await api.getBytes('/media/files/$mediaId');
      final plain = await Crypto.instance.decryptFile(data, ref['key'] as String, ref['header'] as String);
      await file.writeAsBytes(plain, flush: true);
      return file;
    }()
      ..catchError((Object _) {
        _jobs.remove(mediaId);
        return File('');
      });
  }

  /// Keeps the original file name and extension so other apps can open it.
  static Future<File> openNamed(Json ref) async {
    final file = await open(ref);
    final name = (ref['name'] as String? ?? 'file').replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
    final named = File('${file.parent.path}/${ref['mediaId']}-$name');
    if (!named.existsSync()) await file.copy(named.path);
    return named;
  }

  /// A tiny preview (data URL) and the size of an image.
  static Future<({int width, int height, String thumb})> describeImage(Uint8List bytes) async {
    final full = await ui.instantiateImageCodec(bytes);
    final frame = await full.getNextFrame();
    final width = frame.image.width, height = frame.image.height;
    frame.image.dispose();
    final small = await ui.instantiateImageCodec(bytes, targetWidth: width >= height ? 32 : null, targetHeight: height > width ? 32 : null);
    final smallFrame = await small.getNextFrame();
    final png = await smallFrame.image.toByteData(format: ui.ImageByteFormat.png);
    smallFrame.image.dispose();
    return (width: width, height: height, thumb: 'data:image/png;base64,${base64Encode(png!.buffer.asUint8List())}');
  }

  static Uint8List? thumbBytes(String? dataUrl) {
    if (dataUrl == null || !dataUrl.contains(',')) return null;
    try {
      return base64Decode(dataUrl.substring(dataUrl.indexOf(',') + 1));
    } catch (_) {
      return null;
    }
  }
}

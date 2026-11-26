import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:sodium_libs/sodium_libs.dart';

/// Talkie end-to-end encryption (v1), byte-for-byte the same as packages/e2ee on the web:
/// * a device owns an X25519 key pair (crypto_box); only the public key leaves the phone;
/// * each message body is encrypted once with XChaCha20-Poly1305 under a fresh key K;
/// * K is sealed for every recipient device with crypto_box_easy: nonce(24) ‖ box(K);
/// * files use secretstream XChaCha20-Poly1305 in 64 KiB chunks;
/// * everything travels as base64url without padding.
class Crypto {
  Crypto._(this.sodium);
  final Sodium sodium;

  static Crypto? _instance;
  static Crypto get instance => _instance!;

  static Future<Crypto> init() async {
    _instance ??= Crypto._(await SodiumInit.init());
    return _instance!;
  }

  // ───────── Encoding ─────────

  static String b64(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');
  static Uint8List unb64(String text) => base64Url.decode(base64Url.normalize(text));

  Uint8List random(int length) => sodium.randombytes.buf(length);

  // ───────── Device keys ─────────

  DeviceKeyPair generateDeviceKeys() {
    final pair = sodium.crypto.box.keyPair();
    final result = DeviceKeyPair(publicKey: b64(pair.publicKey), secretKey: b64(pair.secretKey.extractBytes()));
    pair.secretKey.dispose();
    return result;
  }

  // ───────── Messages ─────────

  /// Encrypts [body] once and seals its key for every recipient device.
  Sealed seal(Map<String, dynamic> body, DeviceKeyPair sender, List<Recipient> recipients) {
    final aead = sodium.crypto.aeadXChaCha20Poly1305IETF;
    final key = aead.keygen();
    final nonce = random(aead.nonceBytes);
    final plaintext = Uint8List.fromList(utf8.encode(jsonEncode({...body, 'v': 1})));
    final ciphertext = aead.encrypt(message: plaintext, nonce: nonce, key: key);
    final keys = _sealFor(key.extractBytes(), sender, recipients);
    key.dispose();
    return Sealed(ciphertext: b64(ciphertext), nonce: b64(nonce), keys: keys);
  }

  /// Opens a message with this device's key pair and the sending device's public key.
  Map<String, dynamic> open({required String ciphertext, required String nonce, required String sealedKey, required String senderIdentityKey, required DeviceKeyPair receiver}) {
    final key = _openSealed(sealedKey, senderIdentityKey, receiver);
    final secure = SecureKey.fromList(sodium, key);
    try {
      final plain = sodium.crypto.aeadXChaCha20Poly1305IETF.decrypt(cipherText: unb64(ciphertext), nonce: unb64(nonce), key: secure);
      final body = jsonDecode(utf8.decode(plain)) as Map<String, dynamic>;
      if (body['v'] != 1) throw const FormatException('Unsupported message version');
      return body;
    } finally {
      secure.dispose();
    }
  }

  List<SealedKey> _sealFor(Uint8List secret, DeviceKeyPair sender, List<Recipient> recipients) {
    final box = sodium.crypto.box;
    final secretKey = SecureKey.fromList(sodium, unb64(sender.secretKey));
    final unique = <String, Recipient>{for (final r in recipients) r.deviceId: r};
    final result = unique.values.map((recipient) {
      final nonce = random(box.nonceBytes);
      final boxed = box.easy(message: secret, nonce: nonce, publicKey: unb64(recipient.identityKey), secretKey: secretKey);
      return SealedKey(deviceId: recipient.deviceId, sealedKey: b64([...nonce, ...boxed]));
    }).toList();
    secretKey.dispose();
    return result;
  }

  Uint8List _openSealed(String sealedKey, String senderIdentityKey, DeviceKeyPair receiver) {
    final box = sodium.crypto.box;
    final sealed = unb64(sealedKey);
    final secretKey = SecureKey.fromList(sodium, unb64(receiver.secretKey));
    try {
      return box.openEasy(
        cipherText: sealed.sublist(box.nonceBytes),
        nonce: sealed.sublist(0, box.nonceBytes),
        publicKey: unb64(senderIdentityKey),
        secretKey: secretKey,
      );
    } finally {
      secretKey.dispose();
    }
  }

  // ───────── Call keys ─────────

  String newCallKey() => b64(random(32));
  List<SealedKey> sealSecret(String secret, DeviceKeyPair sender, List<Recipient> recipients) => _sealFor(unb64(secret), sender, recipients);
  String openSecret(String sealedKey, String senderIdentityKey, DeviceKeyPair receiver) => b64(_openSealed(sealedKey, senderIdentityKey, receiver));

  // ───────── Files ─────────

  static const fileChunk = 64 * 1024;
  static const chunkOverhead = 17;
  static int encryptedSize(int plainSize) => max(1, (plainSize / fileChunk).ceil()) * chunkOverhead + plainSize;

  /// Encrypts a file held in memory; returns the bytes to upload plus the key and header for the message.
  Future<EncryptedFile> encryptFile(Uint8List bytes) async {
    final stream = sodium.crypto.secretStream;
    final key = stream.keygen();
    final chunks = <Uint8List>[];
    for (var offset = 0; offset < bytes.length || offset == 0; offset += fileChunk) {
      chunks.add(bytes.sublist(offset, min(offset + fileChunk, bytes.length)));
      if (offset + fileChunk >= bytes.length) break;
    }
    final output = await stream
        .pushEx(
          messageStream: Stream.fromIterable(
            chunks.asMap().entries.map((e) => SecretStreamPlainMessage(e.value, tag: e.key == chunks.length - 1 ? SecretStreamMessageTag.finalPush : SecretStreamMessageTag.message)),
          ),
          key: key,
        )
        .toList();
    // The first element is the 24-byte stream header; it travels inside the encrypted message, not the file.
    final header = output.first.message;
    final body = BytesBuilder(copy: false);
    for (final part in output.skip(1)) {
      body.add(part.message);
    }
    final result = EncryptedFile(data: body.takeBytes(), key: b64(key.extractBytes()), header: b64(header));
    key.dispose();
    return result;
  }

  /// Decrypts a downloaded file; throws if anything was changed or cut short.
  Future<Uint8List> decryptFile(Uint8List data, String key, String header) async {
    final stream = sodium.crypto.secretStream;
    final secure = SecureKey.fromList(sodium, unb64(key));
    final size = fileChunk + chunkOverhead;
    final parts = <SecretStreamCipherMessage>[SecretStreamCipherMessage(unb64(header))];
    for (var offset = 0; offset < data.length; offset += size) {
      parts.add(SecretStreamCipherMessage(data.sublist(offset, min(offset + size, data.length))));
    }
    try {
      final plain = await stream.pullEx(cipherStream: Stream.fromIterable(parts), key: secure).toList();
      if (plain.isEmpty || plain.last.tag != SecretStreamMessageTag.finalPush) throw const FormatException('The file is incomplete.');
      final out = BytesBuilder(copy: false);
      for (final part in plain) {
        out.add(part.message);
      }
      return out.takeBytes();
    } finally {
      secure.dispose();
    }
  }

  /// 26-character id for idempotent sends (same alphabet as the web).
  String clientMessageId() {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghijkmnopqrstuvwxyz';
    final time = DateTime.now().millisecondsSinceEpoch.toRadixString(36).padLeft(10, '0');
    final bytes = random(16);
    return (time + bytes.map((b) => alphabet[b % alphabet.length]).join()).substring(0, 26);
  }
}

class DeviceKeyPair {
  const DeviceKeyPair({required this.publicKey, required this.secretKey});
  final String publicKey;
  final String secretKey;
  Map<String, String> toJson() => {'publicKey': publicKey, 'secretKey': secretKey};
  factory DeviceKeyPair.fromJson(Map<String, dynamic> json) => DeviceKeyPair(publicKey: json['publicKey'] as String, secretKey: json['secretKey'] as String);
}

class Recipient {
  const Recipient({required this.deviceId, required this.identityKey});
  final String deviceId;
  final String identityKey;
  factory Recipient.fromJson(Map<String, dynamic> json) => Recipient(deviceId: json['deviceId'] as String, identityKey: json['identityKey'] as String);
}

class SealedKey {
  const SealedKey({required this.deviceId, required this.sealedKey});
  final String deviceId;
  final String sealedKey;
  Map<String, String> toJson() => {'deviceId': deviceId, 'sealedKey': sealedKey};
}

class Sealed {
  const Sealed({required this.ciphertext, required this.nonce, required this.keys});
  final String ciphertext;
  final String nonce;
  final List<SealedKey> keys;
  Map<String, dynamic> toJson() => {'ciphertext': ciphertext, 'nonce': nonce, 'keys': keys.map((k) => k.toJson()).toList()};
}

class EncryptedFile {
  const EncryptedFile({required this.data, required this.key, required this.header});
  final Uint8List data;
  final String key;
  final String header;
}

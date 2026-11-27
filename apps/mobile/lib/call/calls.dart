import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:permission_handler/permission_handler.dart';

import '../chat/chat.dart';
import '../chat/models.dart';
import '../core/api.dart';
import '../core/crypto.dart';
import '../core/realtime.dart';

enum CallPhase { outgoing, connecting, active, reconnecting, ended }

/// One-to-one and group calls (a port of the web's lib/call/engine.ts). Media goes through LiveKit with
/// end-to-end encryption: the call key is made on the caller's device and sealed for every invited device.
class Calls extends ChangeNotifier {
  Calls(this.chat, {required this.inMeeting}) {
    chat.on('call:incoming', (d) => _incoming(d['callId'] as String));
    chat.on('call:update', (d) => _update(d['callId'] as String));
    chat.on('call:ended', (d) => _ended(d['callId'] as String, d['outcome'] as String? ?? 'ended'));
    unawaited(checkIncoming());
    _incomingPoll = Timer.periodic(const Duration(seconds: 5), (_) {
      if (chat.appVisible && realtime.state.value != Connection.connected) unawaited(checkIncoming());
    });
    realtime.state.addListener(_connectionChanged);
  }

  final Chat chat;
  final bool Function() inMeeting;
  Json? info;
  Json? incoming;
  CallPhase? phase;
  Room? room;
  EventsListener<RoomEvent>? _listener;
  bool micOn = true;
  bool camOn = false;
  bool speakerOn = true;
  bool frontCamera = true;
  String? endReason;
  DateTime? startedAt;
  Timer? _buzz;
  Timer? _incomingPoll;
  bool _starting = false;
  bool _answering = false;
  bool _checkingIncoming = false;
  bool _disposed = false;
  bool minimized = false;
  Json? recoverable;
  void showCall(bool small) {
    minimized = small;
    _changed();
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _stopRing();
    _incomingPoll?.cancel();
    realtime.state.removeListener(_connectionChanged);
    _listener?.dispose();
    final current = room;
    if (current != null) unawaited(current.dispose());
    super.dispose();
  }

  void _connectionChanged() {
    if (realtime.state.value == Connection.connected) unawaited(checkIncoming());
  }

  Future<void> checkIncoming() async {
    if (_disposed || _checkingIncoming || _starting || _answering || phase != null) return;
    _checkingIncoming = true;
    try {
      final r = await api.get('/meet/calls/incoming');
      if (_disposed || phase != null || _starting || _answering) return;
      final calls = (r['calls'] as List).cast<Json>();
      if (calls.isNotEmpty && incoming?['id'] != calls.first['id']) _ring(calls.first);
      if (calls.isEmpty && incoming != null) {
        incoming = null;
        _stopRing();
        _changed();
      }
      if (calls.isEmpty) {
        final saved = (await api.get('/meet/calls/current'))['call'] as Json?;
        if (!_disposed && phase == null && !_starting && !_answering && saved?['id'] != recoverable?['id']) {
          recoverable = saved;
          if (saved != null) chat.loadProfiles((saved['participants'] as List).cast<Json>().map((p) => p['userId'] as String));
          _changed();
        }
      }
    } catch (_) {
    } finally {
      _checkingIncoming = false;
    }
  }

  void _ringBuzz() {
    _buzz?.cancel();
    HapticFeedback.heavyImpact();
    SystemSound.play(SystemSoundType.alert);
    _buzz = Timer.periodic(const Duration(milliseconds: 1600), (_) {
      HapticFeedback.heavyImpact();
      SystemSound.play(SystemSoundType.alert);
    });
  }

  void _stopRing() {
    _buzz?.cancel();
    _buzz = null;
  }

  Future<String> _keyFor(Json call) async {
    final keys = chat.session.keys;
    final sealed = call['sealedKey'] as String?;
    final sender = call['keySenderDeviceId'] as String?;
    if (sealed == null || sender == null || keys == null) throw StateError('This device cannot open the call.');
    final senderKey = await chat.publicKeyOf(sender);
    if (senderKey == null) throw StateError('This device cannot open the call.');
    return Crypto.instance.openSecret(sealed, senderKey, keys);
  }

  Future<bool> _permissions(bool video) async {
    final asked = await [Permission.microphone, if (video) Permission.camera].request();
    return asked[Permission.microphone]?.isGranted ?? false;
  }

  Future<Room> _connect(Json grant, String callKey, bool video) async {
    final keyProvider = await BaseKeyProvider.create();
    await keyProvider.setSharedKey(callKey);
    final r = Room(
      roomOptions: RoomOptions(
        adaptiveStream: true,
        dynacast: true,
        encryption: E2EEOptions(keyProvider: keyProvider),
        defaultCameraCaptureOptions: const CameraCaptureOptions(params: VideoParametersPresets.h720_169),
        defaultAudioCaptureOptions: const AudioCaptureOptions(echoCancellation: true, noiseSuppression: true, autoGainControl: true),
      ),
    );
    _listener = r.createListener()
      ..on<ParticipantConnectedEvent>((_) {
        _stopRing();
        if (phase != CallPhase.active) {
          phase = CallPhase.active;
          startedAt ??= DateTime.now();
        }
        _changed();
      })
      ..on<RoomReconnectingEvent>((_) {
        phase = CallPhase.reconnecting;
        _changed();
      })
      ..on<RoomReconnectedEvent>((_) {
        phase = CallPhase.active;
        _changed();
      })
      ..on<RoomDisconnectedEvent>((_) {
        if (identical(room, r) && phase != null && phase != CallPhase.ended) {
          recoverable = info;
          info = null;
          phase = null;
          room = null;
          _listener?.dispose();
          _listener = null;
          unawaited(r.dispose());
          _changed();
          unawaited(checkIncoming());
        }
      })
      ..on<RoomEvent>((_) => _changed());
    try {
      await r.connect(grant['url'] as String, grant['token'] as String);
    } catch (_) {
      _listener?.dispose();
      _listener = null;
      await r.dispose();
      rethrow;
    }
    // The call is live once connected; the microphone and camera start alongside.
    unawaited(() async {
      try {
        await r.localParticipant?.setMicrophoneEnabled(true);
      } catch (_) {
        micOn = false;
      }
      if (video) {
        try {
          await r.localParticipant?.setCameraEnabled(true);
        } catch (_) {
          camOn = false;
        }
      }
      try {
        await AudioManager.instance.setSpeakerOutputPreferred(speakerOn);
      } catch (_) {}
      _changed();
    }());
    if (r.remoteParticipants.isNotEmpty) _stopRing();
    return r;
  }

  String _friendly(Object error) {
    debugPrint('Talkie call failed: $error');
    if (error is ApiError && error.status == 0) return 'Connection unavailable. Try calling again.';
    return error is ApiError ? error.message : 'The call could not connect.';
  }

  /// A call this phone joined on the server but could not connect to: leave it so nobody stays "on a call".
  Future<void> _abandon(String callId) async {
    _listener?.dispose();
    _listener = null;
    final r = room;
    room = null;
    await r?.disconnect();
    await api.post('/meet/calls/$callId/leave').catchError((_) => null);
  }

  // ───────── Outgoing ─────────

  Future<String?> start(String conversationId, bool video) async {
    if (inMeeting()) return 'Leave your meeting before starting a call.';
    if (phase != null) { showCall(false); return null; }
    if (_starting || _answering) return null;
    if (recoverable != null) return resume();
    final keys = chat.session.keys;
    if (keys == null) return 'Your encryption keys are not ready yet.';
    _starting = true;
    try {
      if (!await _permissions(video)) return 'Allow the microphone to call.';
      final callKey = Crypto.instance.newCallKey();
      Future<dynamic> startWith(List<Recipient> devices) => api.post('/meet/calls', {
          'conversationId': conversationId,
          'media': video ? 'video' : 'audio',
          'keys': Crypto.instance.sealSecret(callKey, keys, [...devices, Recipient(deviceId: chat.session.deviceId!, identityKey: keys.publicKey)]).map((k) => k.toJson()).toList(),
        });
      dynamic result;
      final devices = await chat.devicesOf(conversationId);
      try {
        result = await startWith(devices);
      } on ApiError catch (error) {
        final updated = error.details?['devices'];
        if (error.code != 'devices_changed' || updated is! List) rethrow;
        result = await startWith(updated.cast<Json>().map(Recipient.fromJson).toList());
      }
      final call = result['call'] as Json;
      final grant = result['grant'] as Json?;
      chat.loadProfiles(((call['participants'] as List).cast<Json>()).map((p) => p['userId'] as String));
      info = call;
      minimized = false;
      micOn = true;
      camOn = video;
      speakerOn = video;
      phase = CallPhase.outgoing;
      endReason = null;
      startedAt = null;
      _changed();
      if (call['state'] == 'busy' || grant == null) {
        _finish('busy');
        return null;
      }
      final joinedExisting = call['state'] == 'active';
      final connected = await _connect(grant, joinedExisting ? await _keyFor(call) : callKey, video);
      if (!await _keepConnected(connected, call['id'] as String)) return null;
      if (joinedExisting || connected.remoteParticipants.isNotEmpty) {
        phase = CallPhase.active;
        startedAt = DateTime.now();
      }
      _changed();
      return null;
    } catch (error) {
      _stopRing();
      final joined = info?['id'] as String?;
      info = null;
      phase = null;
      _changed();
      if (joined != null) unawaited(_abandon(joined));
      if (error is ApiError && error.details?['currentCallId'] is String) {
        final existing = await api.get('/meet/calls/${error.details!['currentCallId']}').catchError((_) => null);
        if (existing != null) {
          recoverable = existing['call'] as Json;
          _changed();
          return null;
        }
      }
      // A lost response can hide a call that the server already created.
      if (joined == null && error is ApiError && (error.status == 0 || error.status >= 500)) {
        final current = await api.get('/meet/calls/current').catchError((_) => null);
        final saved = current?['call'] as Json?;
        if (!_disposed && saved?['conversationId'] == conversationId) {
          recoverable = saved;
          _changed();
          return null;
        }
      }
      return _friendly(error);
    } finally {
      _starting = false;
    }
  }

  // ───────── Incoming ─────────

  Future<String?> resume() async {
    if (inMeeting()) return 'Leave your meeting before rejoining the call.';
    final call = recoverable;
    if (call == null || _starting || _answering || phase != null) return null;
    _starting = true;
    try {
      if (!await _permissions(false)) return 'Allow the microphone to rejoin.';
      final key = await _keyFor(call);
      final r = await api.post('/meet/calls/${call['id']}/resume');
      info = r['call'] as Json;
      recoverable = null;
      minimized = false;
      micOn = true;
      camOn = false;
      speakerOn = call['media'] == 'video';
      phase = CallPhase.connecting;
      startedAt = DateTime.tryParse(info?['answeredAt'] as String? ?? '');
      _changed();
      final connected = await _connect(r['grant'] as Json, key, false);
      if (await _keepConnected(connected, call['id'] as String)) {
        phase = startedAt != null || connected.remoteParticipants.isNotEmpty ? CallPhase.active : CallPhase.outgoing;
        _changed();
      }
      return null;
    } catch (error) {
      info = null;
      phase = null;
      recoverable = error is ApiError && (error.status == 404 || error.status == 409) ? null : call;
      _changed();
      return _friendly(error);
    } finally { _starting = false; }
  }

  Future<void> _incoming(String callId) async {
    if (phase != null || _starting || _answering || incoming?['id'] == callId) return;
    try {
      final r = await api.get('/meet/calls/$callId');
      final call = r['call'] as Json;
      final participants = (call['participants'] as List).cast<Json>();
      final ringing = participants.any((p) => p['userId'] == chat.me && p['state'] == 'ringing');
      if (!_disposed && phase == null && !_starting && !_answering && ringing && incoming?['id'] != callId) _ring(call);
    } catch (_) {}
  }

  void _ring(Json call) {
    chat.loadProfiles([call['initiatorId'] as String]);
    incoming = call;
    _ringBuzz();
    _changed();
  }

  Future<String?> accept(bool video) async {
    if (inMeeting()) return 'Leave your meeting before answering.';
    final call = incoming;
    if (call == null || _answering || _starting || phase != null) return null;
    _answering = true;
    _stopRing();
    incoming = null;
    _changed();
    try {
      if (!await _permissions(video)) {
        await decline(call);
        return 'Allow the microphone to answer.';
      }
      final callKey = await _keyFor(call);
      final result = await api.post('/meet/calls/${call['id']}/accept');
      info = result['call'] as Json;
      minimized = false;
      startedAt = null;
      micOn = true;
      camOn = video;
      speakerOn = video;
      phase = CallPhase.connecting;
      endReason = null;
      _changed();
      final connected = await _connect(result['grant'] as Json, callKey, video);
      if (!await _keepConnected(connected, call['id'] as String)) return null;
      phase = CallPhase.active;
      startedAt = DateTime.now();
      _changed();
      return null;
    } catch (error) {
      final joined = info?['id'] as String?;
      info = null;
      phase = null;
      _changed();
      if (joined != null) _abandon(joined);
      return _friendly(error);
    } finally {
      _answering = false;
    }
  }

  Future<bool> _keepConnected(Room connected, String callId) async {
    if (_disposed || info?['id'] != callId || phase == null || phase == CallPhase.ended) {
      await connected.dispose();
      return false;
    }
    room = connected;
    return true;
  }

  Future<void> decline([Json? call]) async {
    final target = call ?? incoming;
    _stopRing();
    incoming = null;
    _changed();
    if (target != null) await api.post('/meet/calls/${target['id']}/decline').catchError((_) => null);
  }

  // ───────── During the call ─────────

  Future<void> toggleMic() async {
    if (room?.localParticipant == null) return;
    final next = !micOn;
    try {
      await room?.localParticipant?.setMicrophoneEnabled(next);
      micOn = next;
    } catch (_) {}
    _changed();
  }

  Future<void> toggleCamera() async {
    final next = !camOn;
    if (next && !(await Permission.camera.request()).isGranted) return;
    try {
      await room?.localParticipant?.setCameraEnabled(next);
      camOn = next;
    } catch (_) {
      camOn = false;
    }
    _changed();
  }

  Future<void> toggleSpeaker() async {
    speakerOn = !speakerOn;
    try {
      await AudioManager.instance.setSpeakerOutputPreferred(speakerOn);
    } catch (_) {}
    _changed();
  }

  Future<void> flipCamera() async {
    final track = room?.localParticipant?.videoTrackPublications.firstOrNull?.track;
    if (track is! LocalVideoTrack) return;
    frontCamera = !frontCamera;
    try {
      await track.setCameraPosition(frontCamera ? CameraPosition.front : CameraPosition.back);
    } catch (_) {}
    _changed();
  }

  void _finish(String reason) {
    _stopRing();
    _listener?.dispose();
    _listener = null;
    final r = room;
    room = null;
    if (r != null) unawaited(r.dispose());
    if (phase == null) return;
    phase = CallPhase.ended;
    endReason = reason;
    _changed();
    Timer(const Duration(milliseconds: 1800), () {
      if (phase == CallPhase.ended) {
        phase = null;
        info = null;
        _changed();
      }
    });
  }

  Future<void> hangUp([String reason = 'ended']) async {
    final current = info ?? recoverable;
    if (current == null) return;
    recoverable = null;
    _changed();
    _finish(reason);
    await api.post('/meet/calls/${current['id']}/leave').catchError((_) => null);
  }

  // ───────── Live signals ─────────

  Future<void> _update(String callId) async {
    if (incoming?['id'] == callId) { await checkIncoming(); return; }
    if (info?['id'] != callId) return;
    try {
      final r = await api.get('/meet/calls/$callId');
      if (_disposed || info?['id'] != callId || phase == CallPhase.ended) return;
      info = r['call'] as Json;
      chat.loadProfiles(((info!['participants'] as List).cast<Json>()).map((p) => p['userId'] as String));
      _changed();
    } catch (_) {}
  }

  void _ended(String callId, String outcome) {
    if (recoverable?['id'] == callId) { recoverable = null; _changed(); }
    if (incoming?['id'] == callId) {
      _stopRing();
      incoming = null;
      _changed();
    }
    if (info?['id'] == callId && phase != CallPhase.ended) _finish(outcome);
  }
}

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:permission_handler/permission_handler.dart';

import '../chat/chat.dart';
import '../chat/models.dart';
import '../core/api.dart';

enum MeetPhase { loading, lobby, joining, waiting, inRoom, ended, denied, removed, missing }

/// One Meet-style meeting on this phone (a compact port of the web's lib/meet/engine.ts).
class Meeting extends ChangeNotifier {
  Meeting(this.chat, this.code) {
    _handlers = {
      'meeting:admission': (d) => _admission(d),
      'meeting:update': (d) => _update(d),
    };
    _off = [for (final e in _handlers.entries) chat.on(e.key, e.value)];
    load();
  }

  final Chat chat;
  final String code;
  late final Map<String, void Function(Json)> _handlers;
  late final List<void Function()> _off;
  MeetPhase phase = MeetPhase.loading;
  Json? meeting;
  List<Json> participants = [];
  List<Json> messages = [];
  Room? room;
  EventsListener<RoomEvent>? _listener;
  bool micOn = true;
  bool camOn = true;
  bool handRaised = false;
  bool frontCamera = true;
  String? notice;
  String? error;
  bool _disposed = false;
  final floating = <({String emoji, int at})>[];

  String _path([String suffix = '']) => '/meet/meetings/$code$suffix';
  bool get isHost => meeting?['myRole'] == 'host' || meeting?['myRole'] == 'cohost';
  List<Json> get waiting => participants.where((p) => p['admission'] == 'waiting').toList();

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    for (final off in _off) {
      off();
    }
    _listener?.dispose();
    room?.disconnect();
    super.dispose();
  }

  void _notice(String text) {
    notice = text;
    _changed();
    Timer(const Duration(seconds: 4), () {
      if (notice == text) {
        notice = null;
        _changed();
      }
    });
  }

  Future<void> load() async {
    try {
      final r = await api.get(_path());
      meeting = r['meeting'] as Json;
      phase = meeting!['status'] == 'cancelled' ? MeetPhase.ended : MeetPhase.lobby;
      chat.loadProfiles([meeting!['hostId'] as String]);
    } catch (_) {
      phase = MeetPhase.missing;
    }
    _changed();
  }

  Future<void> join() async {
    if (micOn && !(await Permission.microphone.request()).isGranted) micOn = false;
    if (camOn && !(await Permission.camera.request()).isGranted) camOn = false;
    phase = MeetPhase.joining;
    error = null;
    _changed();
    try {
      final r = await api.post(_path('/join'));
      switch (r['state']) {
        case 'denied':
          phase = MeetPhase.denied;
        case 'waiting':
          phase = MeetPhase.waiting;
        default:
          await _enter(r['grant'] as Json);
      }
    } catch (e) {
      phase = MeetPhase.lobby;
      error = '$e';
    }
    _changed();
  }

  Future<void> _enter(Json grant) async {
    final r = Room(
      roomOptions: const RoomOptions(
        adaptiveStream: true,
        dynacast: true,
        defaultAudioCaptureOptions: AudioCaptureOptions(echoCancellation: true, noiseSuppression: true, autoGainControl: true),
        defaultCameraCaptureOptions: CameraCaptureOptions(params: VideoParametersPresets.h720_169),
      ),
    );
    _listener = r.createListener()
      ..on<DataReceivedEvent>((e) {
        try {
          final data = jsonDecode(utf8.decode(e.data)) as Map<String, dynamic>;
          if (e.topic == 'reaction' && data['emoji'] != null) _float(data['emoji'] as String);
          if (e.topic == 'talkie' && data['type'] == 'muted-by-host') {
            micOn = false;
            _notice('muted');
          }
          if (e.topic == 'talkie' && data['type'] == 'video-stopped-by-host') {
            camOn = false;
            _notice('camera-off');
          }
          if (e.topic == 'talkie' && data['type'] == 'host-message' && data['text'] != null) _notice('${data['text']}');
        } catch (_) {}
      })
      ..on<RoomDisconnectedEvent>((_) {
        if (phase == MeetPhase.inRoom && room == r) {
          phase = MeetPhase.ended;
          _changed();
        }
      })
      ..on<RoomEvent>((_) => _changed());
    await r.connect(grant['url'] as String, grant['token'] as String);
    room = r;
    phase = MeetPhase.inRoom;
    _changed();
    unawaited(() async {
      if (micOn) {
        try {
          await r.localParticipant?.setMicrophoneEnabled(true);
        } catch (_) {
          micOn = false;
        }
      }
      if (camOn) {
        try {
          await r.localParticipant?.setCameraEnabled(true);
        } catch (_) {
          camOn = false;
        }
      }
      try {
        await AudioManager.instance.setSpeakerOutputPreferred(true);
      } catch (_) {}
      _changed();
    }());
    await refreshAll();
  }

  void _float(String emoji) {
    floating.add((emoji: emoji, at: DateTime.now().millisecondsSinceEpoch));
    _changed();
    Timer(const Duration(seconds: 3), () {
      floating.removeWhere((f) => DateTime.now().millisecondsSinceEpoch - f.at > 2800);
      _changed();
    });
  }

  Future<void> refreshAll() => Future.wait([refreshMeeting(), refreshParticipants(), refreshChat()]).catchError((_) => <void>[]);

  Future<void> refreshMeeting() async {
    meeting = (await api.get(_path()))['meeting'] as Json;
    _changed();
  }

  Future<void> refreshParticipants() async {
    participants = ((await api.get(_path('/participants')))['participants'] as List).cast<Json>();
    chat.loadProfiles(participants.map((p) => p['userId'] as String));
    final me = participants.where((p) => p['userId'] == chat.me && p['admission'] == 'admitted').firstOrNull;
    handRaised = me?['handRaisedAt'] != null;
    _changed();
  }

  Future<void> refreshChat() async {
    messages = ((await api.get(_path('/chat')))['messages'] as List).cast<Json>();
    chat.loadProfiles(messages.map((m) => m['userId'] as String));
    _changed();
  }

  Future<void> _admission(Json d) async {
    if (d['code'] != code) return;
    final state = d['state'];
    if (state == 'admitted' && phase == MeetPhase.waiting) {
      final r = await api.post(_path('/token'));
      await _enter(r['grant'] as Json);
    } else if (state == 'denied') {
      phase = MeetPhase.denied;
    } else if (state == 'removed') {
      room?.disconnect();
      room = null;
      phase = MeetPhase.removed;
    }
    _changed();
  }

  void _update(Json d) {
    if (d['code'] != code || phase != MeetPhase.inRoom) return;
    final change = d['change'];
    if (change == 'ended') {
      room?.disconnect();
      room = null;
      phase = MeetPhase.ended;
      _changed();
      return;
    }
    if (change == 'chat') refreshChat().catchError((_) {});
    if (const ['knock', 'joined', 'left', 'participants', 'hands', 'roles'].contains(change)) refreshParticipants().catchError((_) {});
    if (const ['settings', 'roles', 'recording'].contains(change)) refreshMeeting().catchError((_) {});
    if (change == 'knock' && isHost) _notice('knock');
  }

  // ───────── Controls ─────────

  Future<void> toggleMic() async {
    final next = !micOn;
    if (next && !(await Permission.microphone.request()).isGranted) return;
    try {
      await room?.localParticipant?.setMicrophoneEnabled(next);
      micOn = next;
    } catch (_) {}
    _changed();
  }

  Future<void> toggleCam() async {
    final next = !camOn;
    if (next && !(await Permission.camera.request()).isGranted) return;
    try {
      await room?.localParticipant?.setCameraEnabled(next);
      camOn = next;
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

  Future<void> raiseHand() async {
    handRaised = !handRaised;
    _changed();
    await api.post(_path('/hand'), {'raised': handRaised}).catchError((_) => null);
  }

  Future<void> react(String emoji) async {
    _float(emoji);
    await room?.localParticipant?.publishData(utf8.encode(jsonEncode({'type': 'reaction', 'emoji': emoji})), topic: 'reaction');
  }

  Future<void> sendChat(String body) async {
    await api.post(_path('/chat'), {'body': body});
    await refreshChat();
  }

  Future<void> admit(String participantId, bool yes) async {
    await api.post(_path('/participants/$participantId/${yes ? 'admit' : 'deny'}'));
    await refreshParticipants();
  }

  Future<void> leave() async {
    _listener?.dispose();
    _listener = null;
    room?.disconnect();
    room = null;
    phase = MeetPhase.ended;
    _changed();
    await api.post(_path('/leave')).catchError((_) => null);
  }

  Future<void> endForAll() async {
    await api.post(_path('/end'));
    await leave();
  }
}

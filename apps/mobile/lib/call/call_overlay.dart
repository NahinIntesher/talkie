import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import '../chat/chat.dart';
import '../chat/models.dart';
import '../core/prefs.dart';
import '../meet/meet_screen.dart';
import '../meet/meeting.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'calls.dart';

/// Sits above every screen: the incoming-call card and the full-screen call.
class CallOverlay extends StatefulWidget {
  const CallOverlay({super.key, required this.child, required this.navigator});
  final Widget child;
  final GlobalKey<NavigatorState> navigator;
  static const native = MethodChannel('talkie/ongoing');
  @override
  State<CallOverlay> createState() => _CallOverlayState();
}

class _CallOverlayState extends State<CallOverlay> with WidgetsBindingObserver {
  Route<void>? route;
  Map<String, dynamic>? notice;
  bool pip = false;
  String? pendingOpen;
  bool get android =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (android) {
      unawaited(
        CallOverlay.native.invokeMethod<String>('takeOpen').then((id) {
          if (mounted && id != null) setState(() => pendingOpen = id);
        }),
      );
      CallOverlay.native.setMethodCallHandler((event) async {
        if (!mounted) return;
        if (event.method == 'pip') {
          setState(() => pip = event.arguments == true);
          return;
        }
        final calls = context.read<Calls>();
        final hub = context.read<MeetingHub>();
        final m = hub.current;
        if (event.arguments == 'call:${calls.info?['id']}' &&
            calls.info != null) {
          if (event.method == 'open') calls.showCall(false);
          if (event.method == 'end') await calls.hangUp();
          if (event.method == 'mute') await calls.toggleMic();
        } else if (m != null && event.arguments == 'meet:${m.code}') {
          if (event.method == 'open' && widget.navigator.currentState != null) {
            unawaited(hub.open(widget.navigator.currentState!, m.code));
          }
          if (event.method == 'end') await m.leave();
          if (event.method == 'mute') await m.toggleMic();
        }
      });
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && mounted) {
      setState(() => notice = null);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (android) {
      CallOverlay.native.setMethodCallHandler(null);
      unawaited(CallOverlay.native.invokeMethod<void>('stop'));
    }
    super.dispose();
  }

  void synchronize(Calls calls, MeetingHub hub, Map<String, dynamic>? next) {
    final nav = widget.navigator.currentState;
    if (nav == null) return;
    if (pendingOpen != null &&
        calls.recoverable != null &&
        pendingOpen == 'call:${calls.recoverable!['id']}') {
      pendingOpen = null;
      unawaited(calls.resume());
    }
    if (calls.phase != null && !calls.minimized && route == null) {
      final page = MaterialPageRoute<void>(builder: (_) => const _CallScreen());
      route = page;
      unawaited(
        nav.push(page).then((_) {
          if (!mounted || route != page) return;
          route = null;
          if (calls.phase != null) calls.showCall(true);
        }),
      );
    } else if ((calls.phase == null || calls.minimized) && route != null) {
      final old = route!;
      route = null;
      if (old.isActive) nav.removeRoute(old);
    }
    if (android && !mapEquals(notice, next)) {
      notice = next;
      unawaited(
        CallOverlay.native
            .invokeMethod<void>(next == null ? 'stop' : 'update', next)
            .catchError((Object error) {
              if (mounted && identical(notice, next)) notice = null;
              debugPrint('Ongoing call notification: $error');
            }),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final calls = context.watch<Calls>();
    final hub = context.watch<MeetingHub>();
    final chat = context.watch<Chat>();
    final prefs = context.watch<Prefs>();
    final t = prefs.t;
    final call = calls.info ?? calls.recoverable;
    final m = hub.current;
    final meeting = m?.phase == MeetPhase.inRoom;
    final active =
        calls.info != null &&
        calls.phase != null &&
        calls.phase != CallPhase.ended;
    final restore = calls.recoverable != null && calls.phase == null;
    final name = call != null
        ? _peerName(chat, call)
        : ((m?.meeting?['title'] as String?)?.isNotEmpty == true
              ? m!.meeting!['title'] as String
              : m?.code ?? '');
    final mic = active ? calls.micOn : m?.micOn == true;
    final video = active ? (call!['media'] == 'video' || calls.camOn) : meeting;
    final status = active
        ? switch (calls.phase) {
            CallPhase.outgoing => t('রিং হচ্ছে…', 'Ringing…'),
            CallPhase.reconnecting => t('আবার সংযোগ হচ্ছে…', 'Reconnecting…'),
            CallPhase.connecting => t('সংযোগ হচ্ছে…', 'Connecting…'),
            _ => t('চলমান কল', 'Ongoing call'),
          }
        : meeting
        ? t('চলমান মিটিং', 'In a meeting')
        : t('আবার যোগ দিন', 'Rejoin call');
    final since = active ? calls.startedAt : m?.startedAt;
    final data = active || meeting
        ? <String, dynamic>{
            'id': active ? 'call:${call!['id']}' : 'meet:${m!.code}',
            'title': name.isEmpty || name == '…' ? 'Talkie' : name,
            'status': status,
            'channel': t('চলমান কল', 'Ongoing calls'),
            'since': since?.millisecondsSinceEpoch ?? 0,
            'camera': active ? calls.camOn : m!.camOn,
            'video': video,
            'pip': video && (active ? !calls.minimized : hub.visible),
            'muteLabel': mic ? t('মিউট', 'Mute') : t('আনমিউট', 'Unmute'),
          }
        : null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) synchronize(calls, hub, data);
    });
    final small =
        !pip &&
        (active && calls.minimized || restore || meeting && !hub.visible);
    return Stack(
      children: [
        Column(
          children: [
            if (small)
              Material(
                color: const Color(0xff12483d),
                child: SafeArea(
                  bottom: false,
                  child: ListTile(
                    dense: true,
                    textColor: Colors.white,
                    iconColor: Colors.white,
                    leading: Icon(video ? Icons.videocam : Icons.call),
                    title: Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.bold),
                    ),
                    subtitle: since == null || restore
                        ? Text(status)
                        : StreamBuilder<int>(
                            stream: Stream.periodic(
                              const Duration(seconds: 1),
                              (i) => i,
                            ),
                            builder: (_, _) => Text(
                              '$status · ${digits(duration(DateTime.now().difference(since).inMilliseconds), prefs)}',
                            ),
                          ),
                    onTap: () async {
                      if (restore) {
                        final error = await calls.resume();
                        if (error != null && context.mounted) {
                          ScaffoldMessenger.maybeOf(context)
                              ?.showSnackBar(SnackBar(content: Text(error)));
                        }
                      } else if (active) {
                        calls.showCall(false);
                      } else if (m != null) {
                        await hub.open(widget.navigator.currentState!, m.code);
                      }
                    },
                    trailing: IconButton(
                      tooltip: t('বেরিয়ে যান', 'Hang up'),
                      icon: const Icon(Icons.call_end),
                      onPressed: () => meeting ? m!.leave() : calls.hangUp(),
                    ),
                  ),
                ),
              ),
            Expanded(child: widget.child),
          ],
        ),
        if (calls.incoming != null && calls.phase == null)
          const Positioned(left: 0, right: 0, top: 0, child: _IncomingCard()),
        if (pip)
          Positioned.fill(
            child: _Picture(room: active ? calls.room : m?.room, name: name),
          ),
      ],
    );
  }
}

class _Picture extends StatelessWidget {
  const _Picture({required this.room, required this.name});
  final Room? room;
  final String name;
  @override
  Widget build(BuildContext context) {
    final track = room?.remoteParticipants.values
        .expand((p) => p.videoTrackPublications)
        .where((p) => p.subscribed && !p.muted && p.track != null)
        .firstOrNull
        ?.track;
    return Material(
      color: const Color(0xff131828),
      child: track != null
          ? VideoTrackRenderer(track, fit: VideoViewFit.contain)
          : Center(child: Avatar(name: name, size: 44)),
    );
  }
}

String _peerName(Chat chat, Json call) {
  final me = chat.me;
  final others = ((call['participants'] as List).cast<Json>())
      .map((p) => p['userId'] as String)
      .where((id) => id != me)
      .toList();
  final conversation = chat.conversations[call['conversationId']];
  if (conversation != null && conversation.isGroup) {
    return chat.titleOf(conversation);
  }
  return others.isEmpty ? '…' : chat.nameOf(others.first);
}

String? _peerAvatar(Chat chat, Json call) {
  final conversation = chat.conversations[call['conversationId']];
  if (conversation != null) return chat.avatarOf(conversation);
  return chat.profiles[call['initiatorId']]?.avatarUrl;
}

class _IncomingCard extends StatelessWidget {
  const _IncomingCard();

  @override
  Widget build(BuildContext context) {
    final calls = context.watch<Calls>();
    final chat = context.watch<Chat>();
    final t = context.watch<Prefs>().t;
    final p = context.palette;
    final call = calls.incoming!;
    final video = call['media'] == 'video';
    final name = chat.nameOf(call['initiatorId'] as String);
    return SafeArea(
      child:
          Material(
            color: Colors.transparent,
            child: Container(
              margin: const EdgeInsets.all(12),
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: const Color(0xFF141829),
                borderRadius: BorderRadius.circular(26),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.35),
                    blurRadius: 30,
                    offset: const Offset(0, 12),
                  ),
                ],
              ),
              child: Row(
                children: [
                  Avatar(
                    name: name,
                    url: chat.profiles[call['initiatorId']]?.avatarUrl,
                    size: 52,
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _peerName(chat, call),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.w800,
                            fontSize: 17,
                          ),
                        ),
                        Row(
                          children: [
                            Icon(
                              video ? LucideIcons.video : LucideIcons.phone,
                              size: 14,
                              color: Colors.white60,
                            ),
                            const SizedBox(width: 6),
                            Text(
                              video
                                  ? t('ভিডিও কল', 'Video call')
                                  : t('ভয়েস কল', 'Voice call'),
                              style: const TextStyle(
                                color: Colors.white60,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  _RoundButton(
                    icon: LucideIcons.phoneOff,
                    color: p.danger,
                    onTap: () => calls.decline(),
                  ),
                  const SizedBox(width: 10),
                  _RoundButton(
                        icon: video ? LucideIcons.video : LucideIcons.phone,
                        color: p.success,
                        onTap: () async {
                          final error = await calls.accept(video);
                          if (error != null && context.mounted) {
                            showMessage(context, error, error: true);
                          }
                        },
                      )
                      .animate(onPlay: (c) => c.repeat(reverse: true))
                      .scale(
                        begin: const Offset(1, 1),
                        end: const Offset(1.1, 1.1),
                        duration: 700.ms,
                      ),
                ],
              ),
            ),
          ).animate().slideY(
            begin: -1,
            end: 0,
            duration: 350.ms,
            curve: Curves.easeOutCubic,
          ),
    );
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({
    required this.icon,
    required this.color,
    required this.onTap,
    this.size = 52,
    this.iconColor = Colors.white,
  });
  final IconData icon;
  final Color color;
  final VoidCallback onTap;
  final double size;
  final Color iconColor;
  @override
  Widget build(BuildContext context) {
    return Material(
      color: color,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: SizedBox(
          width: size,
          height: size,
          child: Icon(icon, color: iconColor, size: size * 0.42),
        ),
      ),
    );
  }
}

class _CallScreen extends StatefulWidget {
  const _CallScreen();
  @override
  State<_CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<_CallScreen> {
  Timer? tick;

  @override
  void initState() {
    super.initState();
    tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final calls = context.watch<Calls>();
    final chat = context.watch<Chat>();
    final prefs = context.watch<Prefs>();
    final t = prefs.t;
    final p = context.palette;
    final call = calls.info;
    if (call == null || calls.phase == null) return const SizedBox.shrink();
    final room = calls.room;
    final remotes = room?.remoteParticipants.values.toList() ?? [];
    final remoteVideo = remotes
        .expand((r) => r.videoTrackPublications)
        .where((pub) => pub.subscribed && !pub.muted && pub.track != null)
        .map((pub) => pub.track as VideoTrack)
        .toList();
    final localPub = room?.localParticipant?.videoTrackPublications.firstOrNull;
    final localVideo =
        calls.camOn && localPub?.track != null && !localPub!.muted
        ? localPub.track as VideoTrack
        : null;

    final status = switch (calls.phase!) {
      CallPhase.outgoing => t('রিং হচ্ছে…', 'Ringing…'),
      CallPhase.connecting => t('সংযোগ হচ্ছে…', 'Connecting…'),
      CallPhase.reconnecting => t('আবার সংযোগ হচ্ছে…', 'Reconnecting…'),
      CallPhase.ended => switch (calls.endReason) {
        'busy' => t('ব্যস্ত', 'Busy'),
        'declined' => t('প্রত্যাখ্যাত', 'Declined'),
        'missed' || 'no_answer' => t('উত্তর নেই', 'No answer'),
        _ => t('কল শেষ', 'Call ended'),
      },
      CallPhase.active =>
        calls.startedAt == null
            ? ''
            : digits(
                duration(
                  DateTime.now().difference(calls.startedAt!).inMilliseconds,
                ),
                prefs,
              ),
    };

    return Material(
      color: const Color(0xFF0B0E1A),
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (remoteVideo.isEmpty)
            DecoratedBox(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  center: const Alignment(0, -0.4),
                  radius: 1.1,
                  colors: [
                    p.brand.withValues(alpha: 0.45),
                    const Color(0xFF0B0E1A),
                  ],
                ),
              ),
            )
          else if (remoteVideo.length == 1)
            VideoTrackRenderer(remoteVideo.first, fit: VideoViewFit.cover)
          else
            GridView.count(
              crossAxisCount: 2,
              childAspectRatio: 0.75,
              padding: EdgeInsets.zero,
              children: [
                for (final v in remoteVideo)
                  VideoTrackRenderer(v, fit: VideoViewFit.cover),
              ],
            ),
          SafeArea(
            child: Column(
              children: [
                const SizedBox(height: 24),
                if (remoteVideo.isEmpty) ...[
                  Avatar(
                        name: _peerName(chat, call),
                        url: _peerAvatar(chat, call),
                        size: 116,
                      )
                      .animate(
                        onPlay: (c) => calls.phase == CallPhase.outgoing
                            ? c.repeat(reverse: true)
                            : null,
                      )
                      .scale(
                        begin: const Offset(1, 1),
                        end: const Offset(1.06, 1.06),
                        duration: 900.ms,
                      ),
                  const SizedBox(height: 20),
                ],
                Text(
                  _peerName(chat, call),
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 26,
                    fontWeight: FontWeight.w800,
                    shadows: [Shadow(blurRadius: 12)],
                  ),
                ),
                const SizedBox(height: 6),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const Icon(
                      LucideIcons.lock,
                      size: 13,
                      color: Colors.white60,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      status,
                      style: const TextStyle(
                        color: Colors.white70,
                        fontWeight: FontWeight.w700,
                        fontSize: 15,
                        shadows: [Shadow(blurRadius: 10)],
                      ),
                    ),
                  ],
                ),
                const Spacer(),
                Container(
                  margin: const EdgeInsets.fromLTRB(16, 0, 16, 20),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 14,
                  ),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(32),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                    children: [
                      _RoundButton(
                        icon: calls.speakerOn
                            ? LucideIcons.volume2
                            : LucideIcons.ear,
                        color: calls.speakerOn ? Colors.white : Colors.white12,
                        iconColor: calls.speakerOn
                            ? Colors.black
                            : Colors.white,
                        onTap: calls.toggleSpeaker,
                      ),
                      _RoundButton(
                        icon: calls.camOn
                            ? LucideIcons.video
                            : LucideIcons.videoOff,
                        color: calls.camOn ? Colors.white : Colors.white12,
                        iconColor: calls.camOn ? Colors.black : Colors.white,
                        onTap: calls.toggleCamera,
                      ),
                      _RoundButton(
                        icon: calls.micOn
                            ? LucideIcons.mic
                            : LucideIcons.micOff,
                        color: calls.micOn ? Colors.white12 : Colors.white,
                        iconColor: calls.micOn ? Colors.white : Colors.black,
                        onTap: calls.toggleMic,
                      ),
                      _RoundButton(
                        icon: LucideIcons.phoneOff,
                        color: p.danger,
                        size: 60,
                        onTap: () => calls.hangUp(),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          SafeArea(
            child: Align(
              alignment: Alignment.topLeft,
              child: IconButton.filledTonal(
                tooltip: t('চ্যাটে ফিরুন', 'Return to chats'),
                icon: const Icon(Icons.keyboard_arrow_down),
                onPressed: () => Navigator.pop(context),
              ),
            ),
          ),
          if (localVideo != null)
            Positioned(
              right: 16,
              top: MediaQuery.paddingOf(context).top + 16,
              child: GestureDetector(
                onTap: calls.flipCamera,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(18),
                  child: SizedBox(
                    width: 104,
                    height: 150,
                    child: VideoTrackRenderer(
                      localVideo,
                      fit: VideoViewFit.cover,
                      mirrorMode: calls.frontCamera
                          ? VideoViewMirrorMode.mirror
                          : VideoViewMirrorMode.off,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    ).animate().fadeIn(duration: 250.ms);
  }
}

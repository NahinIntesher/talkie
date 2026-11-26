import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:livekit_client/livekit_client.dart' hide ConnectionState;
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import '../chat/chat.dart';
import '../chat/models.dart';
import '../core/api.dart';
import '../core/config.dart';
import '../core/prefs.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'meeting.dart';

/// The Meet tab: start a meeting, join with a code, and see upcoming meetings.
class MeetScreen extends StatefulWidget {
  const MeetScreen({super.key});
  @override
  State<MeetScreen> createState() => _MeetScreenState();
}

class _MeetScreenState extends State<MeetScreen> {
  final code = TextEditingController();
  List<Json> meetings = [];
  bool busy = false;

  @override
  void initState() {
    super.initState();
    load();
  }

  @override
  void dispose() {
    code.dispose();
    super.dispose();
  }

  Future<void> load() async {
    try {
      final r = await api.get('/meet/meetings');
      if (mounted) setState(() => meetings = (r['meetings'] as List).cast<Json>().where((m) => m['status'] == 'scheduled' || m['status'] == 'live').toList());
    } catch (_) {}
  }

  void open(String meetingCode) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => MeetingRoom(code: meetingCode))).then((_) => load());

  Future<void> startNow() async {
    setState(() => busy = true);
    try {
      final r = await api.post('/meet/meetings', {'title': '', 'access': 'trusted'});
      open(r['meeting']['code'] as String);
    } catch (err) {
      if (mounted) showMessage(context, '$err', error: true);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  void joinCode() {
    final raw = code.text.trim();
    if (raw.isEmpty) return;
    final meetingCode = raw.contains('/') ? raw.split('/').where((s) => s.isNotEmpty).last : raw;
    open(meetingCode.toLowerCase());
  }

  @override
  Widget build(BuildContext context) {
    final prefs = context.watch<Prefs>();
    final t = prefs.t;
    final p = context.palette;
    return Scaffold(
      appBar: AppBar(title: Text(t('মিট', 'Meet')), titleSpacing: 20),
      body: RefreshIndicator(
        onRefresh: load,
        child: ListView(padding: const EdgeInsets.all(20), children: [
          GradientButton(label: t('নতুন মিটিং', 'New meeting'), icon: LucideIcons.video, loading: busy, onPressed: startNow),
          const SizedBox(height: 14),
          Row(children: [
            Expanded(
              child: TextField(
                controller: code,
                autocorrect: false,
                textInputAction: TextInputAction.go,
                onSubmitted: (_) => joinCode(),
                onChanged: (_) => setState(() {}),
                decoration: InputDecoration(hintText: t('কোড বা লিংক', 'Code or link'), prefixIcon: const Icon(LucideIcons.keyboard, size: 20)),
              ),
            ),
            const SizedBox(width: 10),
            TextButton(
              onPressed: code.text.trim().isEmpty ? null : joinCode,
              style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16)),
              child: Text(t('যোগ দিন', 'Join'), style: const TextStyle(fontWeight: FontWeight.w800)),
            ),
          ]),
          if (meetings.isNotEmpty) ...[
            const SizedBox(height: 24),
            for (final m in meetings)
              Container(
                margin: const EdgeInsets.only(bottom: 10),
                decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(18), border: Border.all(color: p.border)),
                child: ListTile(
                  leading: CircleAvatar(backgroundColor: m['status'] == 'live' ? p.success.withValues(alpha: 0.15) : p.brandSoft, child: Icon(LucideIcons.video, color: m['status'] == 'live' ? p.success : p.brand, size: 20)),
                  title: Text((m['title'] as String?)?.isNotEmpty == true ? m['title'] as String : m['code'] as String, style: const TextStyle(fontWeight: FontWeight.w800)),
                  subtitle: Text(
                    m['status'] == 'live'
                        ? t('চলছে', 'Live now')
                        : m['scheduledStartAt'] != null
                            ? '${listTime(DateTime.parse(m['scheduledStartAt'] as String).toLocal(), prefs)} ${clock(DateTime.parse(m['scheduledStartAt'] as String).toLocal(), prefs)}'
                            : m['code'] as String,
                    style: TextStyle(color: m['status'] == 'live' ? p.success : p.subtle, fontWeight: FontWeight.w700),
                  ),
                  trailing: Icon(LucideIcons.chevronRight, color: p.subtle),
                  onTap: () => open(m['code'] as String),
                ),
              ),
          ],
        ]),
      ),
    );
  }
}

class MeetingRoom extends StatelessWidget {
  const MeetingRoom({super.key, required this.code});
  final String code;
  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(create: (c) => Meeting(c.read<Chat>(), code), child: const _Room());
  }
}

class _Room extends StatelessWidget {
  const _Room();

  @override
  Widget build(BuildContext context) {
    final m = context.watch<Meeting>();
    final t = context.watch<Prefs>().t;
    final dark = Theme.of(context).copyWith(brightness: Brightness.dark);
    final title = (m.meeting?['title'] as String?)?.isNotEmpty == true ? m.meeting!['title'] as String : m.code;
    Widget center(IconData icon, String text, {Widget? action}) => Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, color: Colors.white70, size: 48),
            const SizedBox(height: 16),
            Text(text, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800)),
            if (action != null) ...[const SizedBox(height: 24), action],
          ]),
        );
    Widget body;
    switch (m.phase) {
      case MeetPhase.loading:
      case MeetPhase.joining:
        body = const Center(child: CircularProgressIndicator(color: Colors.white));
      case MeetPhase.missing:
        body = center(LucideIcons.searchX, t('মিটিং পাওয়া যায়নি', 'Meeting not found'));
      case MeetPhase.waiting:
        body = center(LucideIcons.hourglass, t('হোস্ট আপনাকে ঢুকতে দেবেন', 'Waiting for the host to let you in'));
      case MeetPhase.denied:
        body = center(LucideIcons.ban, t('যোগ দেওয়ার অনুমতি পাননি', 'You were not let in'));
      case MeetPhase.removed:
        body = center(LucideIcons.userX, t('আপনাকে সরিয়ে দেওয়া হয়েছে', 'You were removed'));
      case MeetPhase.ended:
        body = center(LucideIcons.phoneOff, t('মিটিং শেষ', 'Meeting ended'), action: FilledButton(onPressed: () => Navigator.of(context).pop(), child: Text(t('ফিরে যান', 'Back'))));
      case MeetPhase.lobby:
        body = _Lobby(title: title);
      case MeetPhase.inRoom:
        body = const _InRoom();
    }
    return Theme(
      data: dark,
      child: PopScope(
        canPop: m.phase != MeetPhase.inRoom,
        onPopInvokedWithResult: (popped, _) {
          if (!popped) m.leave().then((_) => context.mounted ? Navigator.of(context).pop() : null);
        },
        child: Scaffold(
          backgroundColor: const Color(0xFF0B0E1A),
          appBar: m.phase == MeetPhase.inRoom
              ? null
              : AppBar(backgroundColor: Colors.transparent, foregroundColor: Colors.white, title: Text(title, style: const TextStyle(color: Colors.white))),
          body: body,
        ),
      ),
    );
  }
}

class _Lobby extends StatelessWidget {
  const _Lobby({required this.title});
  final String title;
  @override
  Widget build(BuildContext context) {
    final m = context.watch<Meeting>();
    final t = context.read<Prefs>().t;
    final link = '${Config.origin}/meet/${m.code}';
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(children: [
          const Spacer(),
          Container(
            width: 120,
            height: 120,
            decoration: BoxDecoration(gradient: context.palette.gradient, shape: BoxShape.circle),
            child: const Icon(LucideIcons.video, color: Palette.onBrand, size: 48),
          ).animate().scale(duration: 400.ms, curve: Curves.easeOutBack),
          const SizedBox(height: 24),
          InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: () {
              Clipboard.setData(ClipboardData(text: link));
              showMessage(context, t('লিংক কপি হয়েছে', 'Link copied'));
            },
            child: Padding(
              padding: const EdgeInsets.all(10),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Text(m.code, style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800, letterSpacing: 1)),
                const SizedBox(width: 10),
                const Icon(LucideIcons.copy, color: Colors.white70, size: 18),
              ]),
            ),
          ),
          const SizedBox(height: 28),
          Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            _Toggle(on: m.micOn, onIcon: LucideIcons.mic, offIcon: LucideIcons.micOff, onTap: () => m.micOn = !m.micOn),
            const SizedBox(width: 18),
            _Toggle(on: m.camOn, onIcon: LucideIcons.video, offIcon: LucideIcons.videoOff, onTap: () => m.camOn = !m.camOn),
          ]),
          if (m.error != null) Padding(padding: const EdgeInsets.only(top: 16), child: Text(m.error!, style: TextStyle(color: context.palette.danger))),
          const Spacer(),
          GradientButton(label: t('এখনই যোগ দিন', 'Join now'), icon: LucideIcons.arrowRight, onPressed: m.join),
        ]),
      ),
    );
  }
}

class _Toggle extends StatefulWidget {
  const _Toggle({required this.on, required this.onIcon, required this.offIcon, required this.onTap});
  final bool on;
  final IconData onIcon;
  final IconData offIcon;
  final VoidCallback onTap;
  @override
  State<_Toggle> createState() => _ToggleState();
}

class _ToggleState extends State<_Toggle> {
  @override
  Widget build(BuildContext context) {
    return Material(
      color: widget.on ? Colors.white12 : context.palette.danger,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: () => setState(widget.onTap),
        child: SizedBox(width: 60, height: 60, child: Icon(widget.on ? widget.onIcon : widget.offIcon, color: Colors.white)),
      ),
    );
  }
}

class _InRoom extends StatelessWidget {
  const _InRoom();

  @override
  Widget build(BuildContext context) {
    final m = context.watch<Meeting>();
    final chat = context.watch<Chat>();
    final prefs = context.read<Prefs>();
    final t = prefs.t;
    final p = context.palette;
    final room = m.room!;
    final people = <Participant>[if (room.localParticipant != null) room.localParticipant!, ...room.remoteParticipants.values];
    final screen = room.remoteParticipants.values
        .expand((r) => r.videoTrackPublications)
        .where((pub) => pub.source == TrackSource.screenShareVideo && pub.subscribed && pub.track != null)
        .firstOrNull;
    // Tiles fill the screen: one column for up to two people (stacked, like Meet on a phone), then a grid.
    final columns = people.length <= 2 ? 1 : (people.length <= 6 ? 2 : 3);
    final rows = (people.length / columns).ceil().clamp(1, 4);
    final waiting = m.waiting;

    return SafeArea(
      child: Stack(children: [
        Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
            child: Row(children: [
              Expanded(
                child: Text(
                  (m.meeting?['title'] as String?)?.isNotEmpty == true ? m.meeting!['title'] as String : m.code,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 17),
                ),
              ),
              IconButton(icon: const Icon(LucideIcons.switchCamera, color: Colors.white), onPressed: m.flipCamera),
              IconButton(
                icon: Badge(isLabelVisible: waiting.isNotEmpty && m.isHost, label: Text(digits('${waiting.length}', prefs)), child: const Icon(LucideIcons.users, color: Colors.white)),
                onPressed: () => _people(context, m),
              ),
              IconButton(icon: const Icon(LucideIcons.messageSquareText, color: Colors.white), onPressed: () => _chat(context, m)),
            ]),
          ),
          Expanded(
            child: screen != null
                ? Padding(padding: const EdgeInsets.all(8), child: VideoTrackRenderer(screen.track as VideoTrack, fit: VideoViewFit.contain))
                : LayoutBuilder(
                    builder: (context, box) => GridView.count(
                    crossAxisCount: columns,
                    padding: const EdgeInsets.all(8),
                    mainAxisSpacing: 8,
                    crossAxisSpacing: 8,
                    childAspectRatio: ((box.maxWidth - 16 - 8 * (columns - 1)) / columns) / ((box.maxHeight - 16 - 8 * (rows - 1)) / rows),
                    children: [for (final person in people) _Tile(participant: person, name: person is LocalParticipant ? t('আপনি', 'You') : chat.nameOf(person.identity), avatarName: person is LocalParticipant ? (chat.session.user?['displayName'] as String? ?? '') : chat.nameOf(person.identity), mirror: person is LocalParticipant && m.frontCamera)],
                  ),
                  ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 6, 12, 14),
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
              _Control(icon: m.micOn ? LucideIcons.mic : LucideIcons.micOff, active: m.micOn, onTap: m.toggleMic),
              _Control(icon: m.camOn ? LucideIcons.video : LucideIcons.videoOff, active: m.camOn, onTap: m.toggleCam),
              _Control(icon: LucideIcons.hand, active: !m.handRaised, highlight: m.handRaised, onTap: m.raiseHand),
              _Control(icon: LucideIcons.smilePlus, active: true, onTap: () => _reactions(context, m)),
              _Control(
                icon: LucideIcons.phoneOff,
                active: false,
                danger: true,
                onTap: () async {
                  final navigator = Navigator.of(context);
                  if (m.isHost) {
                    final choice = await showModalBottomSheet<String>(
                      context: context,
                      builder: (sheet) => SafeArea(
                        child: Column(mainAxisSize: MainAxisSize.min, children: [
                          ListTile(leading: const Icon(LucideIcons.logOut), title: Text(t('বেরিয়ে যান', 'Leave')), onTap: () => Navigator.pop(sheet, 'leave')),
                          ListTile(leading: Icon(LucideIcons.phoneOff, color: p.danger), title: Text(t('সবার জন্য শেষ করুন', 'End for everyone'), style: TextStyle(color: p.danger)), onTap: () => Navigator.pop(sheet, 'end')),
                        ]),
                      ),
                    );
                    if (choice == 'end') await m.endForAll();
                    if (choice == 'leave') await m.leave();
                    if (choice == null) return;
                  } else {
                    await m.leave();
                  }
                  navigator.pop();
                },
              ),
            ]),
          ),
        ]),
        for (final (i, f) in m.floating.indexed)
          Positioned(
            key: ValueKey(f.at),
            left: 40.0 + (i * 53 % 220),
            bottom: 110,
            child: Text(f.emoji, style: const TextStyle(fontSize: 40)).animate().moveY(begin: 0, end: -320, duration: 2600.ms).fadeOut(delay: 1800.ms, duration: 800.ms),
          ),
        if (m.notice != null)
          Positioned(
            top: 64,
            left: 24,
            right: 24,
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16)),
              child: Text(
                switch (m.notice) {
                  'muted' => t('হোস্ট আপনাকে মিউট করেছেন', 'The host muted you'),
                  'camera-off' => t('হোস্ট আপনার ক্যামেরা বন্ধ করেছেন', 'The host turned off your camera'),
                  'knock' => t('কেউ যোগ দিতে চাইছেন', 'Someone wants to join'),
                  _ => m.notice!,
                },
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.black, fontWeight: FontWeight.w700),
              ),
            ).animate().fadeIn().slideY(begin: -0.3, end: 0),
          ),
      ]),
    );
  }

  void _reactions(BuildContext context, Meeting m) {
    showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
            for (final e in ['💖', '👍', '🎉', '👏', '😂', '😮', '🤔'])
              IconButton(
                onPressed: () {
                  Navigator.pop(sheet);
                  m.react(e);
                },
                icon: Text(e, style: const TextStyle(fontSize: 30)),
              ),
          ]),
        ),
      ),
    );
  }

  void _people(BuildContext context, Meeting m) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheet) => ChangeNotifierProvider.value(
        value: m,
        child: Consumer<Meeting>(
          builder: (sheet, m, _) {
            final chat = sheet.watch<Chat>();
            final t = sheet.read<Prefs>().t;
            final p = sheet.palette;
            final admitted = m.participants.where((x) => x['admission'] == 'admitted').toList();
            return SafeArea(
              child: ConstrainedBox(
                constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(sheet).height * 0.7),
                child: ListView(shrinkWrap: true, children: [
                  if (m.isHost && m.waiting.isNotEmpty) ...[
                    Padding(padding: const EdgeInsets.fromLTRB(20, 0, 20, 6), child: Text(t('অপেক্ষায়', 'Waiting'), style: TextStyle(fontWeight: FontWeight.w800, color: p.subtle))),
                    for (final w in m.waiting)
                      ListTile(
                        leading: Avatar(name: chat.nameOf(w['userId'] as String), url: chat.profiles[w['userId']]?.avatarUrl, size: 40),
                        title: Text(chat.nameOf(w['userId'] as String), style: const TextStyle(fontWeight: FontWeight.w700)),
                        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                          IconButton(icon: Icon(LucideIcons.x, color: p.danger), onPressed: () => m.admit(w['id'] as String, false)),
                          IconButton(icon: Icon(LucideIcons.check, color: p.success), onPressed: () => m.admit(w['id'] as String, true)),
                        ]),
                      ),
                    const Divider(),
                  ],
                  for (final x in admitted)
                    ListTile(
                      leading: Avatar(name: x['userId'] == chat.me ? (chat.session.user?['displayName'] as String? ?? '') : chat.nameOf(x['userId'] as String), url: x['userId'] == chat.me ? (chat.session.user?['avatarUrl'] as String?) : chat.profiles[x['userId']]?.avatarUrl, size: 40),
                      title: Text(chat.nameOf(x['userId'] as String, you: t('আপনি', 'You')), style: const TextStyle(fontWeight: FontWeight.w700)),
                      subtitle: x['role'] == 'host' || x['role'] == 'cohost' ? Text(x['role'] == 'host' ? t('হোস্ট', 'Host') : t('কো-হোস্ট', 'Co-host')) : null,
                      trailing: x['handRaisedAt'] != null ? const Text('✋', style: TextStyle(fontSize: 22)) : null,
                    ),
                ]),
              ),
            );
          },
        ),
      ),
    );
  }

  void _chat(BuildContext context, Meeting m) {
    final input = TextEditingController();
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheet) => ChangeNotifierProvider.value(
        value: m,
        child: Consumer<Meeting>(
          builder: (sheet, m, _) {
            final chat = sheet.watch<Chat>();
            final prefs = sheet.read<Prefs>();
            final p = sheet.palette;
            return Padding(
              padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(sheet).bottom),
              child: SizedBox(
                height: MediaQuery.sizeOf(sheet).height * 0.6,
                child: Column(children: [
                  Expanded(
                    child: ListView.builder(
                      reverse: true,
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      itemCount: m.messages.length,
                      itemBuilder: (_, i) {
                        final line = m.messages[m.messages.length - 1 - i];
                        return Padding(
                          padding: const EdgeInsets.symmetric(vertical: 6),
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Row(children: [
                              Text(chat.nameOf(line['userId'] as String, you: prefs.t('আপনি', 'You')), style: TextStyle(fontWeight: FontWeight.w800, color: p.brand)),
                              const SizedBox(width: 8),
                              Text(clock(DateTime.parse(line['createdAt'] as String).toLocal(), prefs), style: TextStyle(fontSize: 12, color: p.subtle)),
                            ]),
                            Text(line['body'] as String),
                          ]),
                        );
                      },
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: TextField(
                      controller: input,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (v) {
                        if (v.trim().isEmpty) return;
                        m.sendChat(v.trim()).catchError((_) {});
                        input.clear();
                      },
                      decoration: InputDecoration(hintText: prefs.t('বার্তা', 'Message'), suffixIcon: const Icon(LucideIcons.sendHorizontal)),
                    ),
                  ),
                ]),
              ),
            );
          },
        ),
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({required this.participant, required this.name, required this.avatarName, required this.mirror});
  final Participant participant;
  final String name;
  final String avatarName;
  final bool mirror;

  @override
  Widget build(BuildContext context) {
    final pub = participant.videoTrackPublications.where((pub) => pub.source == TrackSource.camera).firstOrNull;
    final track = pub != null && !pub.muted && pub.track != null && (participant is LocalParticipant || pub.subscribed) ? pub.track as VideoTrack : null;
    final speaking = participant.isSpeaking;
    final muted = !participant.isMicrophoneEnabled();
    return AnimatedContainer(
      duration: const Duration(milliseconds: 200),
      decoration: BoxDecoration(
        color: const Color(0xFF1A1F33),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: speaking ? context.palette.brand2 : Colors.transparent, width: 3),
      ),
      clipBehavior: Clip.antiAlias,
      child: Stack(fit: StackFit.expand, children: [
        if (track != null)
          VideoTrackRenderer(track, fit: VideoViewFit.cover, mirrorMode: mirror ? VideoViewMirrorMode.mirror : VideoViewMirrorMode.off)
        else
          Center(child: Avatar(name: avatarName, size: 76)),
        Positioned(
          left: 8,
          bottom: 8,
          right: 8,
          child: Row(children: [
            if (muted) const Padding(padding: EdgeInsets.only(right: 4), child: Icon(LucideIcons.micOff, size: 14, color: Colors.white)),
            Flexible(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(color: Colors.black45, borderRadius: BorderRadius.circular(9)),
                child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 12.5, fontWeight: FontWeight.w700)),
              ),
            ),
          ]),
        ),
      ]),
    );
  }
}

class _Control extends StatelessWidget {
  const _Control({required this.icon, required this.active, required this.onTap, this.danger = false, this.highlight = false});
  final IconData icon;
  final bool active;
  final bool danger;
  final bool highlight;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final color = danger ? p.danger : (highlight ? Palette.fill[1] : (active ? Colors.white12 : Colors.white));
    return Material(
      color: color,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: SizedBox(width: 54, height: 54, child: Icon(icon, color: highlight ? Palette.onBrand : (!active && !danger ? Colors.black : Colors.white), size: 22)),
      ),
    );
  }
}

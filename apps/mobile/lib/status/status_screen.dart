import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mime/mime.dart';
import 'package:provider/provider.dart';
import 'package:video_player/video_player.dart';

import '../chat/chat.dart';
import '../chat/media.dart';
import '../core/prefs.dart';
import '../core/session.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'status.dart';

class StatusScreen extends StatelessWidget {
  const StatusScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final statuses = context.watch<Statuses>();
    final chat = context.watch<Chat>();
    final prefs = context.watch<Prefs>();
    final session = context.watch<Session>();
    final p = context.palette;
    final t = prefs.t;
    final recent = statuses.groups.where((g) => !g.allViewed && !statuses.muted.contains(g.ownerId)).toList();
    final viewed = statuses.groups.where((g) => g.allViewed && !statuses.muted.contains(g.ownerId)).toList();
    final name = session.user?['displayName'] as String? ?? '';

    Widget row(StatusGroup g) => ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          leading: _Ring(segments: g.items.length, seen: g.allViewed, child: Avatar(name: chat.nameOf(g.ownerId), url: chat.profiles[g.ownerId]?.avatarUrl, size: 48)),
          title: Text(chat.nameOf(g.ownerId), style: const TextStyle(fontWeight: FontWeight.w800)),
          subtitle: Text(listTime(g.latest, prefs), style: TextStyle(color: p.subtle, fontWeight: FontWeight.w600)),
          onTap: () => Navigator.of(context).push(MaterialPageRoute(fullscreenDialog: true, builder: (_) => StatusViewer(items: g.items))),
        );

    return Scaffold(
      appBar: AppBar(title: Text(t('স্ট্যাটাস', 'Status')), titleSpacing: 20),
      floatingActionButton: Column(mainAxisSize: MainAxisSize.min, children: [
        FloatingActionButton.small(
          heroTag: 'text-status',
          backgroundColor: p.surface3,
          foregroundColor: p.text,
          onPressed: () => Navigator.of(context).push(MaterialPageRoute(fullscreenDialog: true, builder: (_) => const _TextComposer())),
          child: const Icon(LucideIcons.pencil),
        ),
        const SizedBox(height: 12),
        FloatingActionButton(
          heroTag: 'media-status',
          backgroundColor: Palette.fill[1],
          foregroundColor: Palette.onBrand,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
          onPressed: () => _pickMedia(context),
          child: const Icon(LucideIcons.camera),
        ),
      ]),
      body: RefreshIndicator(
        onRefresh: statuses.load,
        child: ListView(padding: const EdgeInsets.only(bottom: 120), children: [
          ListTile(
            contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            leading: statuses.mine.isEmpty
                ? Stack(clipBehavior: Clip.none, children: [
                    Avatar(name: name, url: session.user?['avatarUrl'] as String?, size: 52),
                    Positioned(
                      right: -2,
                      bottom: -2,
                      child: Container(
                        width: 22,
                        height: 22,
                        decoration: BoxDecoration(color: Palette.fill[1], shape: BoxShape.circle, border: Border.all(color: p.bg, width: 2.5)),
                        child: const Icon(LucideIcons.plus, size: 13, color: Palette.onBrand),
                      ),
                    ),
                  ])
                : _Ring(segments: statuses.mine.length, seen: true, child: Avatar(name: name, url: session.user?['avatarUrl'] as String?, size: 48)),
            title: Text(t('আমার স্ট্যাটাস', 'My status'), style: const TextStyle(fontWeight: FontWeight.w800)),
            subtitle: statuses.mine.isEmpty ? null : Text(listTime(statuses.mine.last.time, prefs), style: TextStyle(color: p.subtle, fontWeight: FontWeight.w600)),
            onTap: statuses.mine.isEmpty ? () => _pickMedia(context) : () => Navigator.of(context).push(MaterialPageRoute(fullscreenDialog: true, builder: (_) => StatusViewer(items: statuses.mine))),
          ),
          if (recent.isNotEmpty) _Header(t('সাম্প্রতিক', 'Recent')),
          ...recent.map(row),
          if (viewed.isNotEmpty) _Header(t('দেখা হয়েছে', 'Viewed')),
          ...viewed.map(row),
        ]),
      ),
    );
  }

  static Future<void> _pickMedia(BuildContext context) async {
    final statuses = context.read<Statuses>();
    final t = context.read<Prefs>().t;
    final picked = await ImagePicker().pickMedia(maxWidth: 2560, maxHeight: 2560, imageQuality: 86);
    if (picked == null) return;
    final mime = lookupMimeType(picked.path) ?? 'image/jpeg';
    final video = mime.startsWith('video/');
    final bytes = await picked.readAsBytes();
    if (!context.mounted) return;
    if (bytes.length > 64 * 1024 * 1024) return showMessage(context, t('সর্বোচ্চ ৬৪ MB', 'Up to 64 MB'), error: true);
    showMessage(context, t('পোস্ট হচ্ছে…', 'Posting…'));
    try {
      final extra = <String, dynamic>{};
      if (video) {
        final c = VideoPlayerController.file(File(picked.path));
        try {
          await c.initialize();
          extra.addAll({'width': c.value.size.width.round(), 'height': c.value.size.height.round(), 'durationMs': c.value.duration.inMilliseconds});
        } finally {
          c.dispose();
        }
      } else {
        final info = await Media.describeImage(bytes);
        extra.addAll({'width': info.width, 'height': info.height, 'thumb': info.thumb});
      }
      await statuses.postMedia(bytes, video: video, name: picked.name, mime: mime, extra: extra);
      if (context.mounted) showMessage(context, t('পোস্ট হয়েছে', 'Posted'));
    } catch (err) {
      if (context.mounted) showMessage(context, '$err', error: true);
    }
  }
}

class _Header extends StatelessWidget {
  const _Header(this.label);
  final String label;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 4),
        child: Text(label, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: context.palette.subtle)),
      );
}

/// The segmented ring around a status avatar.
class _Ring extends StatelessWidget {
  const _Ring({required this.segments, required this.seen, required this.child});
  final int segments;
  final bool seen;
  final Widget child;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return CustomPaint(
      painter: _RingPainter(segments, seen ? p.surface3 : p.brand, seen ? null : p.accent),
      child: Padding(padding: const EdgeInsets.all(4), child: child),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.segments, this.color, this.color2);
  final int segments;
  final Color color;
  final Color? color2;
  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.6
      ..strokeCap = StrokeCap.round;
    if (color2 != null) {
      paint.shader = SweepGradient(colors: [color, color2!, color]).createShader(rect);
    } else {
      paint.color = color;
    }
    final gap = segments > 1 ? 0.12 : 0.0;
    final sweep = (2 * 3.14159265) / segments;
    for (var i = 0; i < segments; i++) {
      canvas.drawArc(rect.deflate(1.3), -3.14159265 / 2 + i * sweep + gap / 2, sweep - gap, false, paint);
    }
  }

  @override
  bool shouldRepaint(_RingPainter old) => old.segments != segments || old.color != color;
}

class _TextComposer extends StatefulWidget {
  const _TextComposer();
  @override
  State<_TextComposer> createState() => _TextComposerState();
}

class _TextComposerState extends State<_TextComposer> {
  final text = TextEditingController();
  int background = 0;
  bool posting = false;

  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.read<Prefs>().t;
    return Scaffold(
      backgroundColor: Color(statusBackgrounds[background]),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        foregroundColor: Colors.white,
        actions: [IconButton(icon: const Icon(LucideIcons.palette), onPressed: () => setState(() => background = (background + 1) % statusBackgrounds.length))],
      ),
      floatingActionButton: FloatingActionButton(
        backgroundColor: Colors.white,
        foregroundColor: Color(statusBackgrounds[background]),
        onPressed: posting || text.text.trim().isEmpty
            ? null
            : () async {
                final navigator = Navigator.of(context);
                setState(() => posting = true);
                try {
                  await context.read<Statuses>().postText(text.text.trim(), statusBackgrounds[background]);
                  navigator.pop();
                } catch (err) {
                  if (context.mounted) showMessage(context, '$err', error: true);
                  setState(() => posting = false);
                }
              },
        child: posting ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5)) : const Icon(LucideIcons.sendHorizontal),
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: TextField(
            controller: text,
            autofocus: true,
            maxLines: null,
            maxLength: 700,
            textAlign: TextAlign.center,
            onChanged: (_) => setState(() {}),
            cursorColor: Colors.white,
            style: const TextStyle(color: Colors.white, fontSize: 30, fontWeight: FontWeight.w700, height: 1.3),
            decoration: InputDecoration(
              hintText: t('কিছু লিখুন', 'Type a status'),
              hintStyle: const TextStyle(color: Colors.white54),
              filled: false,
              counterText: '',
              border: InputBorder.none,
              focusedBorder: InputBorder.none,
            ),
          ),
        ),
      ),
    );
  }
}

/// Full-screen status player: tap right for next, left for previous, hold to pause.
class StatusViewer extends StatefulWidget {
  const StatusViewer({super.key, required this.items});
  final List<StatusItem> items;
  @override
  State<StatusViewer> createState() => _StatusViewerState();
}

class _StatusViewerState extends State<StatusViewer> with SingleTickerProviderStateMixin {
  late final AnimationController progress = AnimationController(vsync: this, duration: const Duration(seconds: 5))
    ..addStatusListener((s) {
      if (s == AnimationStatus.completed) next();
    });
  int index = 0;
  File? file;
  VideoPlayerController? video;
  bool loading = false;

  StatusItem get item => widget.items[index];

  @override
  void initState() {
    super.initState();
    show();
  }

  @override
  void dispose() {
    progress.dispose();
    video?.dispose();
    super.dispose();
  }

  Future<void> show() async {
    progress.stop();
    progress.value = 0;
    video?.dispose();
    video = null;
    file = null;
    context.read<Statuses>().markViewed(item);
    final attachment = item.body?['attachment'] as Map<String, dynamic>?;
    if (attachment == null) {
      progress.duration = const Duration(seconds: 5);
      progress.forward();
      setState(() {});
      return;
    }
    setState(() => loading = true);
    final shown = index;
    try {
      final f = await Media.open(attachment);
      if (!mounted || shown != index) return;
      if (item.kind == 'video') {
        final c = VideoPlayerController.file(f);
        await c.initialize();
        if (!mounted || shown != index) {
          await c.dispose();
          return;
        }
        video = c;
        progress.duration = c.value.duration.inMilliseconds > 0 ? c.value.duration : const Duration(seconds: 5);
        c.play();
      } else {
        file = f;
        progress.duration = const Duration(seconds: 5);
      }
      progress.forward();
    } catch (_) {
      progress.forward();
    }
    if (mounted) setState(() => loading = false);
  }

  void next() {
    if (index < widget.items.length - 1) {
      setState(() => index++);
      show();
    } else {
      Navigator.of(context).maybePop();
    }
  }

  void previous() {
    if (index > 0) {
      setState(() => index--);
      show();
    } else {
      progress.value = 0;
      progress.forward();
    }
  }

  void pause(bool paused) {
    if (paused) {
      progress.stop();
      video?.pause();
    } else {
      progress.forward();
      video?.play();
    }
  }

  Future<void> showViewers() async {
    pause(true);
    final statuses = context.read<Statuses>();
    final chat = context.read<Chat>();
    final prefs = context.read<Prefs>();
    final viewers = await statuses.viewers(item.id).catchError((_) => <Map<String, dynamic>>[]);
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: ListView(shrinkWrap: true, children: [
          Padding(padding: const EdgeInsets.fromLTRB(20, 0, 20, 8), child: Text('${prefs.t('দেখেছেন', 'Viewed by')} ${digits('${viewers.length}', prefs)}', style: Theme.of(sheet).textTheme.titleMedium)),
          for (final v in viewers)
            ListTile(
              leading: Avatar(name: chat.nameOf(v['userId'] as String), url: chat.profiles[v['userId']]?.avatarUrl, size: 42),
              title: Text(chat.nameOf(v['userId'] as String), style: const TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text(listTime(DateTime.parse(v['viewedAt'] as String).toLocal(), prefs)),
              trailing: v['reaction'] != null ? Text(v['reaction'] as String, style: const TextStyle(fontSize: 22)) : null,
            ),
        ]),
      ),
    );
    if (mounted) pause(false);
  }

  @override
  Widget build(BuildContext context) {
    final chat = context.watch<Chat>();
    final prefs = context.read<Prefs>();
    final mine = item.ownerId == chat.me;
    final body = item.body ?? {};
    final text = body['text'] as String? ?? '';
    final bgHex = (body['background'] as String? ?? '#5b5bf7').replaceFirst('#', '');
    final bg = Color(int.tryParse('FF$bgHex', radix: 16) ?? 0xFFD97706);
    final attachment = body['attachment'] as Map<String, dynamic>?;
    final thumb = Media.thumbBytes(attachment?['thumb'] as String?);

    return Scaffold(
      backgroundColor: attachment == null ? bg : Colors.black,
      body: GestureDetector(
        onTapUp: (d) => d.localPosition.dx < MediaQuery.sizeOf(context).width / 3 ? previous() : next(),
        onLongPressStart: (_) => pause(true),
        onLongPressEnd: (_) => pause(false),
        onVerticalDragEnd: (d) {
          if ((d.primaryVelocity ?? 0) > 300) Navigator.of(context).maybePop();
          if ((d.primaryVelocity ?? 0) < -300 && mine) showViewers();
        },
        child: Stack(fit: StackFit.expand, children: [
          if (attachment == null)
            Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Text(text, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 30, fontWeight: FontWeight.w700, height: 1.3)),
              ),
            )
          else ...[
            if (thumb != null && file == null && video == null) Image.memory(thumb, fit: BoxFit.contain, filterQuality: FilterQuality.low),
            if (file != null) Image.file(file!, fit: BoxFit.contain),
            if (video != null) Center(child: AspectRatio(aspectRatio: video!.value.aspectRatio, child: VideoPlayer(video!))),
            if (loading) const Center(child: CircularProgressIndicator(color: Colors.white)),
            if (text.isNotEmpty)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: Container(
                  padding: const EdgeInsets.fromLTRB(24, 40, 24, 90),
                  decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.transparent, Colors.black87])),
                  child: Text(text, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w600)),
                ),
              ),
          ],
          SafeArea(
            child: Column(children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
                child: Row(children: [
                  for (var i = 0; i < widget.items.length; i++)
                    Expanded(
                      child: Container(
                        height: 3,
                        margin: const EdgeInsets.symmetric(horizontal: 2),
                        decoration: BoxDecoration(color: Colors.white30, borderRadius: BorderRadius.circular(9)),
                        child: i < index
                            ? Container(decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(9)))
                            : i == index
                                ? AnimatedBuilder(
                                    animation: progress,
                                    builder: (_, _) => FractionallySizedBox(
                                      alignment: Alignment.centerLeft,
                                      widthFactor: progress.value,
                                      child: Container(decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(9))),
                                    ),
                                  )
                                : null,
                      ),
                    ),
                ]),
              ),
              ListTile(
                leading: Avatar(name: chat.nameOf(item.ownerId), url: chat.profiles[item.ownerId]?.avatarUrl, size: 40),
                title: Text(chat.nameOf(item.ownerId, you: prefs.t('আপনি', 'You')), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
                subtitle: Text(listTime(item.time, prefs), style: const TextStyle(color: Colors.white70, fontWeight: FontWeight.w600)),
                trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                  if (mine)
                    IconButton(
                      icon: const Icon(LucideIcons.trash2, color: Colors.white),
                      onPressed: () async {
                        final navigator = Navigator.of(context);
                        await context.read<Statuses>().delete(item.id);
                        navigator.maybePop();
                      },
                    ),
                  IconButton(icon: const Icon(LucideIcons.x, color: Colors.white), onPressed: () => Navigator.of(context).maybePop()),
                ]),
              ),
              const Spacer(),
              Padding(
                padding: const EdgeInsets.only(bottom: 20),
                child: mine
                    ? TextButton.icon(
                        onPressed: showViewers,
                        icon: const Icon(LucideIcons.eye, color: Colors.white),
                        label: Text(digits('${item.viewCount}', prefs), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800)),
                      )
                    : Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                        for (final e in ['❤️', '😂', '😮', '😢', '👏', '🔥'])
                          IconButton(
                            onPressed: () {
                              context.read<Statuses>().react(item.id, e).catchError((_) => null);
                              showMessage(context, e);
                            },
                            icon: Text(e, style: const TextStyle(fontSize: 26)),
                          ),
                      ]),
              ),
            ]),
          ),
        ]),
      ),
    );
  }
}

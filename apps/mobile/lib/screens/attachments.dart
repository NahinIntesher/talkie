import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:open_filex/open_filex.dart';
import 'package:provider/provider.dart';
import 'package:video_player/video_player.dart';

import '../chat/chat.dart';
import '../chat/media.dart';
import '../chat/models.dart';
import '../core/prefs.dart';
import '../ui/format.dart';
import '../ui/theme.dart';

class AttachmentView extends StatelessWidget {
  const AttachmentView({super.key, required this.message, required this.attachment, required this.mine});
  final ChatMessage message;
  final Json attachment;
  final bool mine;

  @override
  Widget build(BuildContext context) {
    final pending = (attachment['key'] as String? ?? '').isEmpty;
    switch (message.kind) {
      case 'image':
        return _Visual(attachment: attachment, pending: pending, video: false);
      case 'video':
        return _Visual(attachment: attachment, pending: pending, video: true);
      case 'voice':
        return _Voice(attachment: attachment, mine: mine, pending: pending);
      default:
        return _Document(attachment: attachment, mine: mine, pending: pending);
    }
  }
}

class _Visual extends StatefulWidget {
  const _Visual({required this.attachment, required this.pending, required this.video});
  final Json attachment;
  final bool pending;
  final bool video;
  @override
  State<_Visual> createState() => _VisualState();
}

class _VisualState extends State<_Visual> {
  File? file;
  bool failed = false;

  @override
  void initState() {
    super.initState();
    if (!widget.pending && !widget.video) _load();
  }

  @override
  void didUpdateWidget(_Visual old) {
    super.didUpdateWidget(old);
    if (old.pending && !widget.pending && !widget.video) _load();
  }

  Future<void> _load() async {
    try {
      final f = await Media.open(widget.attachment);
      if (mounted) setState(() => file = f);
    } catch (_) {
      if (mounted) setState(() => failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.attachment;
    final w = (a['width'] as num?)?.toDouble() ?? 1;
    final h = (a['height'] as num?)?.toDouble() ?? 1;
    final maxW = MediaQuery.sizeOf(context).width * 0.7;
    final ratio = (w / h).clamp(0.6, 1.8);
    final thumb = Media.thumbBytes(a['thumb'] as String?);
    return GestureDetector(
      onTap: widget.pending ? null : () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => MediaViewer(attachment: a, video: widget.video))),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(16),
        child: SizedBox(
          width: maxW,
          height: maxW / ratio,
          child: Stack(fit: StackFit.expand, children: [
            if (thumb != null) Image.memory(thumb, fit: BoxFit.cover, filterQuality: FilterQuality.low, gaplessPlayback: true) else Container(color: Colors.black26),
            if (file != null) Image.file(file!, fit: BoxFit.cover, gaplessPlayback: true),
            if (widget.video)
              Center(
                child: Container(
                  width: 54,
                  height: 54,
                  decoration: const BoxDecoration(color: Colors.black45, shape: BoxShape.circle),
                  child: const Icon(LucideIcons.play, color: Colors.white, size: 26),
                ),
              ),
            if (widget.video && a['durationMs'] != null)
              Positioned(
                left: 8,
                bottom: 8,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(9)),
                  child: Text(duration((a['durationMs'] as num).toInt()), style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w700)),
                ),
              ),
            if (!widget.video && file == null && !failed && !widget.pending) const Center(child: SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white))),
            if (failed) const Center(child: Icon(LucideIcons.imageOff, color: Colors.white70)),
          ]),
        ),
      ),
    );
  }
}

/// Full-screen photo or video.
class MediaViewer extends StatefulWidget {
  const MediaViewer({super.key, required this.attachment, required this.video});
  final Json attachment;
  final bool video;
  @override
  State<MediaViewer> createState() => _MediaViewerState();
}

class _MediaViewerState extends State<MediaViewer> {
  File? file;
  VideoPlayerController? player;
  bool failed = false;

  @override
  void initState() {
    super.initState();
    Media.open(widget.attachment).then((f) async {
      if (!mounted) return;
      if (widget.video) {
        final c = VideoPlayerController.file(f);
        await c.initialize();
        await c.play();
        if (!mounted) return c.dispose();
        setState(() => player = c);
      } else {
        setState(() => file = f);
      }
    }).catchError((Object _) {
      if (mounted) setState(() => failed = true);
    });
  }

  @override
  void dispose() {
    player?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = player;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(backgroundColor: Colors.black, foregroundColor: Colors.white),
      body: Center(
        child: failed
            ? const Icon(LucideIcons.imageOff, color: Colors.white54, size: 48)
            : file != null
                ? InteractiveViewer(maxScale: 5, child: Image.file(file!))
                : c != null
                    ? GestureDetector(
                        onTap: () => setState(() => c.value.isPlaying ? c.pause() : c.play()),
                        child: Stack(alignment: Alignment.center, children: [
                          AspectRatio(aspectRatio: c.value.aspectRatio, child: VideoPlayer(c)),
                          if (!c.value.isPlaying) const Icon(LucideIcons.play, color: Colors.white, size: 56),
                          Positioned(left: 0, right: 0, bottom: 0, child: VideoProgressIndicator(c, allowScrubbing: true, padding: const EdgeInsets.all(16))),
                        ]),
                      )
                    : const CircularProgressIndicator(color: Colors.white),
      ),
    );
  }
}

class _Voice extends StatefulWidget {
  const _Voice({required this.attachment, required this.mine, required this.pending});
  final Json attachment;
  final bool mine;
  final bool pending;
  @override
  State<_Voice> createState() => _VoiceState();
}

class _VoiceState extends State<_Voice> {
  final player = AudioPlayer();
  bool loading = false;
  bool ready = false;
  StreamSubscription<PlayerState>? sub;

  @override
  void initState() {
    super.initState();
    sub = player.playerStateStream.listen((s) {
      if (s.processingState == ProcessingState.completed) {
        player.pause();
        player.seek(Duration.zero);
      }
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    sub?.cancel();
    player.dispose();
    super.dispose();
  }

  Future<void> toggle() async {
    if (player.playing) return player.pause();
    if (!ready) {
      setState(() => loading = true);
      try {
        final file = await Media.open(widget.attachment);
        await player.setFilePath(file.path);
        ready = true;
      } catch (_) {
        if (mounted) setState(() => loading = false);
        return;
      }
      if (mounted) setState(() => loading = false);
    }
    player.play();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final fg = widget.mine ? Colors.white : p.brand;
    final dim = widget.mine ? Colors.white38 : p.surface3;
    final bars = ((widget.attachment['waveform'] as List?) ?? List.filled(48, 30)).map((v) => (v as num).toDouble()).toList();
    final total = (widget.attachment['durationMs'] as num?)?.toInt() ?? 0;
    return SizedBox(
      width: 230,
      child: Row(children: [
        GestureDetector(
          onTap: widget.pending ? null : toggle,
          child: Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(color: widget.mine ? Colors.white24 : p.brandSoft, shape: BoxShape.circle),
            child: loading
                ? Padding(padding: const EdgeInsets.all(11), child: CircularProgressIndicator(strokeWidth: 2, color: fg))
                : Icon(player.playing ? LucideIcons.pause : LucideIcons.play, color: fg, size: 20),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: StreamBuilder<Duration>(
            stream: player.positionStream,
            builder: (context, snap) {
              final pos = snap.data?.inMilliseconds ?? 0;
              final fraction = total == 0 ? 0.0 : pos / total;
              return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                SizedBox(
                  height: 28,
                  child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
                    for (var i = 0; i < bars.length; i += 2)
                      Expanded(
                        child: Container(
                          height: 4 + 22 * (bars[i] / 100).clamp(0, 1),
                          margin: const EdgeInsets.symmetric(horizontal: 0.8),
                          decoration: BoxDecoration(color: i / bars.length <= fraction && pos > 0 ? fg : dim, borderRadius: BorderRadius.circular(9)),
                        ),
                      ),
                  ]),
                ),
                Text(duration(pos > 0 ? pos : total), style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: widget.mine ? Colors.white70 : p.subtle)),
              ]);
            },
          ),
        ),
      ]),
    );
  }
}

class _Document extends StatefulWidget {
  const _Document({required this.attachment, required this.mine, required this.pending});
  final Json attachment;
  final bool mine;
  final bool pending;
  @override
  State<_Document> createState() => _DocumentState();
}

class _DocumentState extends State<_Document> {
  bool loading = false;

  Future<void> open() async {
    setState(() => loading = true);
    try {
      final file = await Media.openNamed(widget.attachment);
      await OpenFilex.open(file.path, type: widget.attachment['mime'] as String?);
    } catch (_) {
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final a = widget.attachment;
    final fg = widget.mine ? Colors.white : p.text;
    final name = a['name'] as String? ?? '';
    final ext = name.contains('.') ? name.split('.').last.toUpperCase() : '';
    return InkWell(
      onTap: widget.pending || loading ? null : open,
      borderRadius: BorderRadius.circular(14),
      child: Container(
        width: 240,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(color: widget.mine ? Colors.white.withValues(alpha: 0.14) : p.surface2, borderRadius: BorderRadius.circular(14)),
        child: Row(children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(color: widget.mine ? Colors.white24 : p.brandSoft, borderRadius: BorderRadius.circular(12)),
            child: loading ? Padding(padding: const EdgeInsets.all(12), child: CircularProgressIndicator(strokeWidth: 2, color: fg)) : Icon(LucideIcons.fileText, color: widget.mine ? Colors.white : p.brand),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: fg, fontWeight: FontWeight.w700)),
              Text([fileSize((a['size'] as num?)?.toInt() ?? 0), ext].where((s) => s.isNotEmpty).join(' · '), style: TextStyle(fontSize: 12, color: widget.mine ? Colors.white70 : p.subtle, fontWeight: FontWeight.w600)),
            ]),
          ),
        ]),
      ),
    );
  }
}

class PollView extends StatelessWidget {
  const PollView({super.key, required this.message, required this.mine});
  final ChatMessage message;
  final bool mine;

  @override
  Widget build(BuildContext context) {
    final chat = context.read<Chat>();
    final prefs = context.read<Prefs>();
    final p = context.palette;
    final poll = message.poll!;
    final options = List<String>.from(poll['options'] as List);
    final multiple = poll['multiple'] == true;
    final votes = {for (final v in message.pollVotes ?? <MapEntry<int, List<String>>>[]) v.key: v.value};
    final voters = votes.values.expand((u) => u).toSet().length;
    final mineSelected = votes.entries.where((e) => e.value.contains(chat.me)).map((e) => e.key).toSet();
    final fg = mine ? Colors.white : p.text;
    return SizedBox(
      width: 250,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(poll['question'] as String? ?? '', style: TextStyle(color: fg, fontWeight: FontWeight.w800, fontSize: 16)),
        const SizedBox(height: 8),
        for (var i = 0; i < options.length; i++)
          InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: message.local != null
                ? null
                : () {
                    final next = {...mineSelected};
                    if (next.contains(i)) {
                      next.remove(i);
                    } else {
                      if (!multiple) next.clear();
                      next.add(i);
                    }
                    chat.vote(message.conversationId, message.id, next.toList()).catchError((_) {});
                  },
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 5),
              child: Row(children: [
                Icon(mineSelected.contains(i) ? LucideIcons.circleCheck : LucideIcons.circle, size: 20, color: mine ? Colors.white : p.brand),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Expanded(child: Text(options[i], style: TextStyle(color: fg, fontWeight: FontWeight.w600))),
                      Text(digits('${votes[i]?.length ?? 0}', prefs), style: TextStyle(color: fg, fontWeight: FontWeight.w700)),
                    ]),
                    const SizedBox(height: 4),
                    LinearProgressIndicator(
                      value: voters == 0 ? 0 : (votes[i]?.length ?? 0) / voters,
                      minHeight: 5,
                      borderRadius: BorderRadius.circular(9),
                      color: mine ? Colors.white : p.brand,
                      backgroundColor: mine ? Colors.white24 : p.surface3,
                    ),
                  ]),
                ),
              ]),
            ),
          ),
      ]),
    );
  }
}

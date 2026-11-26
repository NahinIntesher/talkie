import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mime/mime.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import 'package:record/record.dart';
import 'package:video_player/video_player.dart';

import '../chat/chat.dart';
import '../chat/media.dart';
import '../chat/models.dart';
import '../core/prefs.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

class Composer extends StatefulWidget {
  const Composer({super.key, required this.conversationId, this.replyTo, this.editing, required this.onCancel});
  final String conversationId;
  final ChatMessage? replyTo;
  final ChatMessage? editing;
  final VoidCallback onCancel;
  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final text = TextEditingController();
  final focus = FocusNode();
  bool typing = false;
  final recorder = AudioRecorder();
  bool recording = false;
  DateTime? recordStart;
  final levels = <double>[];
  StreamSubscription<Amplitude>? ampSub;
  Timer? recordTick;

  Chat get chat => context.read<Chat>();
  String t(String bn, String en) => context.read<Prefs>().t(bn, en);

  @override
  void didUpdateWidget(Composer old) {
    super.didUpdateWidget(old);
    if (widget.editing != null && old.editing?.id != widget.editing!.id) {
      text.text = widget.editing!.text ?? '';
      focus.requestFocus();
    }
    if (widget.replyTo != null && old.replyTo?.id != widget.replyTo!.id) focus.requestFocus();
  }

  @override
  void dispose() {
    if (typing) chat.setTyping(widget.conversationId, false);
    ampSub?.cancel();
    recordTick?.cancel();
    recorder.dispose();
    text.dispose();
    focus.dispose();
    super.dispose();
  }

  void _onChanged(String value) {
    final active = value.trim().isNotEmpty;
    if (active != typing || active) {
      if (active != typing) chat.setTyping(widget.conversationId, active);
      typing = active;
    }
    setState(() {});
  }

  void _fail(Object err) {
    if (mounted) showMessage(context, err is Exception || err is Error ? t('পাঠানো যায়নি', 'Could not send') : '$err', error: true);
  }

  Future<void> send() async {
    final value = text.text.trim();
    if (value.isEmpty) return;
    HapticFeedback.selectionClick();
    final editing = widget.editing;
    final replyTo = widget.replyTo;
    text.clear();
    typing = false;
    chat.setTyping(widget.conversationId, false);
    widget.onCancel();
    setState(() {});
    try {
      if (editing != null) {
        await chat.editText(widget.conversationId, editing.id, value);
      } else {
        await chat.sendText(widget.conversationId, value, replyToId: replyTo?.id);
      }
    } catch (err) {
      _fail(err);
    }
  }

  /// Uploads a file (encrypted) and sends it.
  Future<void> sendFile(Uint8List bytes, {required String kind, required String name, required String mime, Json extra = const {}, String? caption}) async {
    final replyTo = widget.replyTo;
    widget.onCancel();
    final preview = {'mediaId': 'local-${DateTime.now().microsecondsSinceEpoch}', 'key': '', 'header': '', 'mime': mime, 'name': name, 'size': bytes.length, ...extra};
    try {
      await chat.sendWithUpload(
        widget.conversationId,
        kind,
        {'v': 1, if (caption != null && caption.isNotEmpty) 'text': caption, 'attachments': [preview]},
        (localId) async {
          chat.setProgress(localId, 0);
          final uploaded = await Media.uploadEncrypted(bytes, 'message', onProgress: (f) => chat.setProgress(localId, f));
          return (body: {'attachments': [{...preview, 'mediaId': uploaded.mediaId, 'key': uploaded.key, 'header': uploaded.header}]}, mediaIds: [uploaded.mediaId]);
        },
        replyToId: replyTo?.id,
      );
    } catch (err) {
      _fail(err);
    }
  }

  Future<void> pickMedia(ImageSource source, {bool video = false}) async {
    final picker = ImagePicker();
    final picked = video ? await picker.pickVideo(source: source) : await picker.pickImage(source: source, maxWidth: 2560, maxHeight: 2560, imageQuality: 86);
    if (picked == null) return;
    await _sendPicked(picked, video);
  }

  Future<void> pickGallery() async {
    final picked = await ImagePicker().pickMultipleMedia(maxWidth: 2560, maxHeight: 2560, imageQuality: 86, limit: 10);
    for (final file in picked) {
      final mime = lookupMimeType(file.path) ?? '';
      await _sendPicked(file, mime.startsWith('video/'));
    }
  }

  Future<void> _sendPicked(XFile picked, bool video) async {
    final bytes = await picked.readAsBytes();
    final name = picked.name;
    final mime = lookupMimeType(picked.path) ?? (video ? 'video/mp4' : 'image/jpeg');
    if (video) {
      final extra = <String, dynamic>{};
      final c = VideoPlayerController.file(File(picked.path));
      try {
        await c.initialize();
        extra.addAll({'width': c.value.size.width.round(), 'height': c.value.size.height.round(), 'durationMs': c.value.duration.inMilliseconds});
      } catch (_) {
      } finally {
        c.dispose();
      }
      await sendFile(bytes, kind: 'video', name: name, mime: mime, extra: extra);
    } else {
      final info = await Media.describeImage(bytes);
      await sendFile(bytes, kind: 'image', name: name, mime: mime, extra: {'width': info.width, 'height': info.height, 'thumb': info.thumb});
    }
  }

  Future<void> pickDocument() async {
    final result = await FilePicker.pickFiles();
    if (result.isEmpty) return;
    final file = result.first;
    final bytes = await file.xFile.readAsBytes();
    final mime = lookupMimeType(file.name) ?? 'application/octet-stream';
    await sendFile(bytes, kind: mime.startsWith('audio/') ? 'audio' : 'document', name: file.name, mime: mime);
  }

  Future<void> createPoll() async {
    final question = TextEditingController();
    final options = [TextEditingController(), TextEditingController()];
    var multiple = false;
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (sheet) => StatefulBuilder(
        builder: (sheet, setSheet) => Padding(
          padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.viewInsetsOf(sheet).bottom + 20),
          child: SingleChildScrollView(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(t('পোল', 'Poll'), style: Theme.of(sheet).textTheme.titleLarge),
              const SizedBox(height: 16),
              TextField(controller: question, autofocus: true, maxLength: 255, decoration: InputDecoration(hintText: t('প্রশ্ন', 'Question'), counterText: '')),
              const SizedBox(height: 10),
              for (var i = 0; i < options.length; i++)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: TextField(
                    controller: options[i],
                    maxLength: 100,
                    onChanged: (_) => setSheet(() {
                      if (i == options.length - 1 && options[i].text.isNotEmpty && options.length < 12) options.add(TextEditingController());
                    }),
                    decoration: InputDecoration(hintText: '${t('বিকল্প', 'Option')} ${digits('${i + 1}', context.read<Prefs>())}', counterText: ''),
                  ),
                ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: multiple,
                onChanged: (v) => setSheet(() => multiple = v),
                title: Text(t('একাধিক উত্তর', 'Multiple answers'), style: const TextStyle(fontWeight: FontWeight.w700)),
              ),
              const SizedBox(height: 8),
              GradientButton(label: t('পাঠান', 'Send'), onPressed: () => Navigator.pop(sheet, true)),
            ]),
          ),
        ),
      ),
    );
    final choices = options.map((o) => o.text.trim()).where((o) => o.isNotEmpty).toList();
    if (ok == true && question.text.trim().isNotEmpty && choices.length >= 2) {
      chat.sendPoll(widget.conversationId, question.text.trim(), choices, multiple).catchError(_fail);
    }
  }

  void attachMenu() {
    final p = context.palette;
    final items = [
      (LucideIcons.image, t('গ্যালারি', 'Gallery'), const Color(0xFFD97706), pickGallery),
      (LucideIcons.camera, t('ক্যামেরা', 'Camera'), const Color(0xFFEC4899), () => pickMedia(ImageSource.camera)),
      (LucideIcons.video, t('ভিডিও', 'Video'), const Color(0xFFF97316), () => pickMedia(ImageSource.camera, video: true)),
      (LucideIcons.fileText, t('ফাইল', 'Document'), const Color(0xFF0EA5E9), pickDocument),
      (LucideIcons.chartBar, t('পোল', 'Poll'), const Color(0xFF10B981), createPoll),
    ];
    showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Wrap(
            alignment: WrapAlignment.spaceEvenly,
            runSpacing: 16,
            children: [
              for (final (icon, label, color, action) in items)
                SizedBox(
                  width: 78,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(16),
                    onTap: () {
                      Navigator.pop(sheet);
                      action();
                    },
                    child: Column(children: [
                      Container(width: 56, height: 56, decoration: BoxDecoration(color: color.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(18)), child: Icon(icon, color: color)),
                      const SizedBox(height: 6),
                      Text(label, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: p.muted)),
                    ]),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  // ───────── Voice notes ─────────

  Future<void> startRecording() async {
    if (!await recorder.hasPermission()) return;
    final dir = await getTemporaryDirectory();
    final path = '${dir.path}/voice-${DateTime.now().millisecondsSinceEpoch}.m4a';
    await recorder.start(const RecordConfig(encoder: AudioEncoder.aacLc, bitRate: 64000, sampleRate: 44100, numChannels: 1), path: path);
    HapticFeedback.mediumImpact();
    levels.clear();
    ampSub = recorder.onAmplitudeChanged(const Duration(milliseconds: 100)).listen((a) => levels.add(((a.current + 60) / 60).clamp(0, 1) * 100));
    recordTick = Timer.periodic(const Duration(milliseconds: 200), (_) => setState(() {}));
    setState(() {
      recording = true;
      recordStart = DateTime.now();
    });
  }

  Future<void> stopRecording({required bool send}) async {
    if (!recording) return;
    final elapsed = DateTime.now().difference(recordStart!);
    final path = await recorder.stop();
    await ampSub?.cancel();
    recordTick?.cancel();
    setState(() => recording = false);
    if (!send || path == null || elapsed.inMilliseconds < 700) return;
    final bytes = await File(path).readAsBytes();
    // 48 bars, like the web.
    final waveform = List.generate(48, (i) {
      if (levels.isEmpty) return 20;
      final start = (i * levels.length / 48).floor();
      final end = max(start + 1, ((i + 1) * levels.length / 48).floor());
      final slice = levels.sublist(min(start, levels.length - 1), min(end, levels.length));
      return slice.reduce(max).round();
    });
    await sendFile(bytes, kind: 'voice', name: 'voice-note.m4a', mime: 'audio/mp4', extra: {'durationMs': elapsed.inMilliseconds, 'waveform': waveform});
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final chat = context.read<Chat>();
    final prefs = context.read<Prefs>();
    final hasText = text.text.trim().isNotEmpty;
    final quoted = widget.editing ?? widget.replyTo;
    return Container(
      color: p.surface,
      child: SafeArea(
        top: false,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (quoted != null)
            Container(
              margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
              decoration: BoxDecoration(color: p.brandSoft, borderRadius: BorderRadius.circular(14), border: Border(left: BorderSide(color: p.brand, width: 3))),
              child: Row(children: [
                Icon(widget.editing != null ? LucideIcons.pencil : LucideIcons.reply, size: 18, color: p.brand),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(widget.editing != null ? t('সম্পাদনা', 'Editing') : chat.nameOf(quoted.senderId, you: t('আপনি', 'You')), style: TextStyle(fontWeight: FontWeight.w800, color: p.brand, fontSize: 13)),
                    Text(preview(quoted, chat, prefs), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: p.muted, fontSize: 13)),
                  ]),
                ),
                IconButton(
                  icon: const Icon(LucideIcons.x, size: 18),
                  onPressed: () {
                    if (widget.editing != null) text.clear();
                    widget.onCancel();
                  },
                ),
              ]),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
            child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              Expanded(
                child: Container(
                  constraints: const BoxConstraints(minHeight: 48),
                  decoration: BoxDecoration(color: p.surface2, borderRadius: BorderRadius.circular(24)),
                  child: recording
                      ? Row(children: [
                          const SizedBox(width: 16),
                          Container(width: 10, height: 10, decoration: BoxDecoration(color: p.danger, shape: BoxShape.circle)),
                          const SizedBox(width: 10),
                          Text(duration(DateTime.now().difference(recordStart!).inMilliseconds), style: const TextStyle(fontWeight: FontWeight.w800, fontFeatures: [FontFeature.tabularFigures()])),
                          const Spacer(),
                          IconButton(icon: Icon(LucideIcons.trash2, color: p.danger), onPressed: () => stopRecording(send: false)),
                        ])
                      : Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                          if (widget.editing == null) IconButton(icon: Icon(LucideIcons.paperclip, color: p.muted), onPressed: attachMenu),
                          if (widget.editing != null) const SizedBox(width: 16),
                          Expanded(
                            child: TextField(
                              controller: text,
                              focusNode: focus,
                              minLines: 1,
                              maxLines: 6,
                              textCapitalization: TextCapitalization.sentences,
                              onChanged: _onChanged,
                              decoration: InputDecoration(
                                hintText: t('বার্তা', 'Message'),
                                filled: false,
                                border: InputBorder.none,
                                focusedBorder: InputBorder.none,
                                contentPadding: const EdgeInsets.symmetric(vertical: 13),
                              ),
                            ),
                          ),
                          if (!hasText && widget.editing == null) IconButton(icon: Icon(LucideIcons.camera, color: p.muted), onPressed: () => pickMedia(ImageSource.camera)),
                        ]),
                ),
              ),
              const SizedBox(width: 6),
              GestureDetector(
                onTap: hasText ? send : (recording ? () => stopRecording(send: true) : startRecording),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 180),
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(gradient: p.gradient, shape: BoxShape.circle, boxShadow: [BoxShadow(color: p.brand.withValues(alpha: 0.35), blurRadius: 14, offset: const Offset(0, 5))]),
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 160),
                    transitionBuilder: (c, a) => ScaleTransition(scale: a, child: c),
                    child: Icon(
                      hasText ? (widget.editing != null ? LucideIcons.check : LucideIcons.sendHorizontal) : (recording ? LucideIcons.sendHorizontal : LucideIcons.mic),
                      key: ValueKey('$hasText$recording'),
                      color: Palette.onBrand,
                      size: 22,
                    ),
                  ),
                ),
              ),
            ]),
          ),
        ]),
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../chat/chat.dart';
import '../chat/models.dart';
import '../core/prefs.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import 'attachments.dart';
import 'chats.dart';

class MessageBubble extends StatefulWidget {
  const MessageBubble({super.key, required this.message, required this.conversation, required this.firstOfRun, required this.lastOfRun, required this.onReply, required this.onLongPress});
  final ChatMessage message;
  final Conversation conversation;
  final bool firstOfRun;
  final bool lastOfRun;
  final VoidCallback onReply;
  final VoidCallback onLongPress;
  @override
  State<MessageBubble> createState() => _MessageBubbleState();
}

class _MessageBubbleState extends State<MessageBubble> {
  double drag = 0;

  @override
  Widget build(BuildContext context) {
    final chat = context.watch<Chat>();
    final prefs = context.read<Prefs>();
    final p = context.palette;
    final m = widget.message;
    final t = prefs.t;
    final mine = m.senderId == chat.me;
    final media = m.kind == 'image' || m.kind == 'video';
    final fg = mine ? p.bubbleOutText : p.text;
    final meta = mine ? p.bubbleOutText.withValues(alpha: 0.75) : p.subtle;
    const r = Radius.circular(20);
    const tight = Radius.circular(6);
    final radius = BorderRadius.only(
      topLeft: !mine && !widget.firstOfRun ? tight : r,
      topRight: mine && !widget.firstOfRun ? tight : r,
      bottomLeft: !mine && widget.lastOfRun ? tight : r,
      bottomRight: mine && widget.lastOfRun ? tight : r,
    );

    Widget content;
    if (m.deleted) {
      content = Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(LucideIcons.ban, size: 15, color: meta),
        const SizedBox(width: 6),
        Flexible(child: Text(t('বার্তাটি মুছে ফেলা হয়েছে', 'This message was deleted'), style: TextStyle(color: meta, fontStyle: FontStyle.italic))),
      ]);
    } else if (m.unreadable != null) {
      content = Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(LucideIcons.lock, size: 15, color: meta),
        const SizedBox(width: 6),
        Flexible(child: Text(t('বার্তাটি খোলা যায়নি', 'Message unavailable'), style: TextStyle(color: meta, fontStyle: FontStyle.italic))),
      ]);
    } else if (m.kind == 'call') {
      content = Row(mainAxisSize: MainAxisSize.min, children: [Icon(LucideIcons.phone, size: 16, color: fg), const SizedBox(width: 8), Text(t('কল', 'Call'), style: TextStyle(color: fg, fontWeight: FontWeight.w700))]);
    } else {
      content = Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        for (final a in m.attachments) Padding(padding: EdgeInsets.only(bottom: (m.text ?? '').isNotEmpty ? 6 : 0), child: AttachmentView(message: m, attachment: a, mine: mine)),
        if (m.poll != null) PollView(message: m, mine: mine),
        if ((m.text ?? '').isNotEmpty) Padding(padding: EdgeInsets.symmetric(horizontal: media ? 6 : 0), child: _LinkText(text: m.text!, color: fg)),
      ]);
    }

    final time = Row(mainAxisSize: MainAxisSize.min, children: [
      if (m.starred) Padding(padding: const EdgeInsets.only(right: 3), child: Icon(LucideIcons.star, size: 11, color: meta)),
      if (m.editedAt != null && !m.deleted) Text('${t('সম্পাদিত', 'edited')} · ', style: TextStyle(fontSize: 11, color: meta, fontWeight: FontWeight.w600)),
      Text(clock(m.time, prefs), style: TextStyle(fontSize: 11, color: meta, fontWeight: FontWeight.w600)),
      if (mine) ...[const SizedBox(width: 3), Ticks(message: m, receipts: chat.receipts[m.conversationId], size: 15, onBubble: true)],
    ]);

    final reply = m.replyToId != null && !m.deleted ? _ReplyQuote(conversationId: m.conversationId, messageId: m.replyToId!, mine: mine) : null;
    final progress = chat.uploads[m.id];

    final bubble = Container(
      constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.78),
      padding: media && (m.text ?? '').isEmpty ? const EdgeInsets.all(4) : EdgeInsets.fromLTRB(media ? 4 : 13, media ? 4 : 8, media ? 4 : 13, 7),
      decoration: BoxDecoration(
        color: mine ? null : p.surface,
        gradient: mine ? LinearGradient(colors: [p.bubbleOut, Color.lerp(p.bubbleOut, Colors.black, 0.06)!], begin: Alignment.topLeft, end: Alignment.bottomRight) : null,
        borderRadius: radius,
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 6, offset: const Offset(0, 2))],
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        if (widget.conversation.isGroup && !mine && widget.firstOfRun)
          Padding(padding: EdgeInsets.fromLTRB(media ? 6 : 0, media ? 4 : 0, 0, 3), child: Text(chat.nameOf(m.senderId), style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: p.brand))),
        if (m.forwardedCount > 0)
          Padding(
            padding: const EdgeInsets.only(bottom: 3),
            child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(LucideIcons.forward, size: 13, color: meta), const SizedBox(width: 4), Text(t('ফরওয়ার্ড করা', 'Forwarded'), style: TextStyle(fontSize: 12, fontStyle: FontStyle.italic, color: meta))]),
          ),
        ?reply,
        content,
        if (progress != null) Padding(padding: const EdgeInsets.only(top: 6), child: LinearProgressIndicator(value: progress, minHeight: 3, borderRadius: BorderRadius.circular(9), color: p.bubbleOutText, backgroundColor: p.bubbleOutText.withValues(alpha: 0.16))),
        Padding(padding: EdgeInsets.only(top: 2, right: media ? 6 : 0), child: Align(alignment: Alignment.centerRight, widthFactor: 1, child: time)),
      ]),
    );

    return GestureDetector(
      onLongPress: widget.onLongPress,
      onHorizontalDragUpdate: m.deleted || m.local != null ? null : (d) => setState(() => drag = (drag + d.delta.dx).clamp(0, 80)),
      onHorizontalDragEnd: (_) {
        if (drag > 56) widget.onReply();
        setState(() => drag = 0);
      },
      child: Padding(
        padding: EdgeInsets.only(top: widget.firstOfRun ? 6 : 1.5, bottom: m.reactions.isNotEmpty ? 14 : 0),
        child: Stack(clipBehavior: Clip.none, children: [
          if (drag > 0)
            Positioned(left: 4, top: 0, bottom: 0, child: Opacity(opacity: (drag / 56).clamp(0, 1), child: Icon(LucideIcons.reply, color: p.brand))),
          AnimatedContainer(
            duration: Duration(milliseconds: drag == 0 ? 200 : 0),
            transform: Matrix4.translationValues(drag, 0, 0),
            child: Align(
              alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
              child: Stack(clipBehavior: Clip.none, children: [
                bubble,
                if (m.reactions.isNotEmpty)
                  Positioned(
                    bottom: -14,
                    right: mine ? 10 : null,
                    left: mine ? null : 10,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(99), border: Border.all(color: p.wallpaper, width: 2)),
                      child: Text(
                        '${m.reactions.map((r) => r.emoji).take(3).join()}${m.reactions.fold<int>(0, (a, r) => a + r.userIds.length) > 1 ? ' ${m.reactions.fold<int>(0, (a, r) => a + r.userIds.length)}' : ''}',
                        style: TextStyle(fontSize: 13, color: p.muted, fontWeight: FontWeight.w700),
                      ),
                    ),
                  ),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}

class _ReplyQuote extends StatelessWidget {
  const _ReplyQuote({required this.conversationId, required this.messageId, required this.mine});
  final String conversationId;
  final String messageId;
  final bool mine;
  @override
  Widget build(BuildContext context) {
    final chat = context.watch<Chat>();
    final prefs = context.read<Prefs>();
    final p = context.palette;
    final quoted = chat.findMessage(conversationId, messageId);
    if (quoted == null) chat.requestMessage(messageId);
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.fromLTRB(10, 6, 10, 6),
      decoration: BoxDecoration(
        color: mine ? p.bubbleOutText.withValues(alpha: 0.16) : p.brandSoft,
        borderRadius: BorderRadius.circular(12),
        border: Border(left: BorderSide(color: mine ? p.bubbleOutText : p.brand, width: 3)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(quoted == null ? '…' : chat.nameOf(quoted.senderId, you: prefs.t('আপনি', 'You')), style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: mine ? p.bubbleOutText : p.brand)),
        Text(preview(quoted, chat, prefs), maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: mine ? p.bubbleOutText.withValues(alpha: 0.7) : p.muted)),
      ]),
    );
  }
}

/// Message text with tappable links.
class _LinkText extends StatelessWidget {
  const _LinkText({required this.text, required this.color});
  final String text;
  final Color color;
  static final _link = RegExp(r'(https?://[^\s]+)');

  @override
  Widget build(BuildContext context) {
    final emojiOnly = text.runes.length <= 3 && !RegExp(r'[A-Za-z0-9ঀ-৿]').hasMatch(text);
    final style = TextStyle(color: color, fontSize: emojiOnly ? 38 : 15.5, height: 1.35, fontWeight: FontWeight.w500);
    final spans = <InlineSpan>[];
    var last = 0;
    for (final match in _link.allMatches(text)) {
      if (match.start > last) spans.add(TextSpan(text: text.substring(last, match.start)));
      final url = match[0]!;
      spans.add(WidgetSpan(
        alignment: PlaceholderAlignment.baseline,
        baseline: TextBaseline.alphabetic,
        child: GestureDetector(
          onTap: () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
          child: Text(url, style: style.copyWith(decoration: TextDecoration.underline, decorationColor: color)),
        ),
      ));
      last = match.end;
    }
    if (last < text.length) spans.add(TextSpan(text: text.substring(last)));
    return Text.rich(TextSpan(style: style, children: spans));
  }
}

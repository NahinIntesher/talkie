import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import '../chat/chat.dart';
import '../chat/models.dart';
import '../core/prefs.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'bubble.dart';
import '../core/api.dart';
import 'composer.dart';
import 'info.dart';

class ThreadScreen extends StatefulWidget {
  const ThreadScreen({super.key, required this.conversationId});
  final String conversationId;
  @override
  State<ThreadScreen> createState() => _ThreadScreenState();
}

class _ThreadScreenState extends State<ThreadScreen> {
  final scroll = ScrollController();
  ChatMessage? replyTo;
  ChatMessage? editing;
  bool loadingOlder = false;
  late final Chat chat = context.read<Chat>();

  @override
  void initState() {
    super.initState();
    chat.open(widget.conversationId);
    scroll.addListener(() {
      if (scroll.position.pixels > scroll.position.maxScrollExtent - 600 && !loadingOlder) {
        loadingOlder = true;
        chat.loadOlder(widget.conversationId).whenComplete(() => loadingOlder = false);
      }
    });
  }

  @override
  void dispose() {
    if (chat.activeId == widget.conversationId) chat.activeId = null;
    scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final chat = context.watch<Chat>();
    final prefs = context.watch<Prefs>();
    final p = context.palette;
    final t = prefs.t;
    final c = chat.conversations[widget.conversationId];
    final title = c == null ? '' : chat.titleOf(c, fallback: t('চ্যাট', 'Chat'));
    final thread = chat.threads[widget.conversationId];
    final items = thread?.items ?? [];
    final typing = chat.typingIn(widget.conversationId).where((u) => u != chat.me).toList();

    String status = '';
    if (c != null) {
      if (typing.isNotEmpty) {
        status = c.isGroup ? t('${chat.nameOf(typing.first)} লিখছেন…', '${chat.nameOf(typing.first)} is typing…') : t('লিখছেন…', 'typing…');
      } else if (c.isGroup) {
        status = (chat.members[c.id] ?? []).map((m) => chat.nameOf(m.userId, you: t('আপনি', 'You'))).join(', ');
      } else if (chat.online[c.peerId] == true) {
        status = t('অনলাইন', 'online');
      } else {
        status = lastSeen(chat.profiles[c.peerId]?.lastSeenAt, prefs);
      }
    }

    final blocked = c != null && !c.isGroup && (chat.profiles[c.peerId]?.blockedByMe ?? false);
    final canSend = c != null && c.active && !blocked && !(c.isGroup && c.group?['sendPolicy'] == 'admins' && !c.isAdmin);

    return Scaffold(
      backgroundColor: p.wallpaper,
      appBar: AppBar(
        titleSpacing: 0,
        title: c == null
            ? const SizedBox.shrink()
            : GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: _openInfo,
                child: Row(children: [
                Avatar(name: title, url: chat.avatarOf(c), size: 40, group: c.isGroup && chat.avatarOf(c) == null),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
                    if (status.isNotEmpty)
                      Text(status, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: typing.isNotEmpty || status == t('অনলাইন', 'online') ? p.brand : p.subtle)),
                  ]),
                ),
              ]),
              ),
        actions: [
          if (c != null && c.active) ...[
            IconButton(icon: const Icon(LucideIcons.video), onPressed: () => callHook?.call(context, c, true)),
            IconButton(icon: const Icon(LucideIcons.phone), onPressed: () => callHook?.call(context, c, false)),
          ],
          if (c != null) IconButton(icon: const Icon(LucideIcons.ellipsisVertical), onPressed: () => _chatMenu(c)),
        ],
      ),
      body: Column(children: [
        Expanded(
          child: thread?.loaded != true
              ? const Center(child: CircularProgressIndicator())
              : ListView.builder(
                  controller: scroll,
                  reverse: true,
                  padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
                  itemCount: items.length + (thread!.hasMore ? 1 : 0),
                  itemBuilder: (context, index) {
                    if (index == items.length) return const Padding(padding: EdgeInsets.all(16), child: Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))));
                    final i = items.length - 1 - index;
                    final m = items[i];
                    final prev = i > 0 ? items[i - 1] : null;
                    final next = i < items.length - 1 ? items[i + 1] : null;
                    final newDay = prev == null || !sameDay(prev.time, m.time);
                    final firstOfRun = newDay || prev.senderId != m.senderId || prev.kind == 'system';
                    final lastOfRun = next == null || next.senderId != m.senderId || !sameDay(next.time, m.time) || next.kind == 'system';
                    return Column(children: [
                      if (newDay) _DayChip(label: dayLabel(m.time, prefs)),
                      if (m.kind == 'system')
                        _DayChip(label: systemText(m, chat, prefs))
                      else
                        MessageBubble(
                          key: ValueKey(m.id),
                          message: m,
                          conversation: c!,
                          firstOfRun: firstOfRun,
                          lastOfRun: lastOfRun,
                          onReply: () => setState(() {
                            replyTo = m;
                            editing = null;
                          }),
                          onLongPress: () => _actions(m),
                        ),
                    ]);
                  },
                ),
        ),
        if (c != null && canSend)
          Composer(
            conversationId: widget.conversationId,
            replyTo: replyTo,
            editing: editing,
            onCancel: () => setState(() {
              replyTo = null;
              editing = null;
            }),
          )
        else if (c != null)
          SafeArea(
            top: false,
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.all(18),
              color: p.surface,
              child: Text(
                blocked ? t('আপনি এই ব্যক্তিকে ব্লক করেছেন', 'You blocked this person') : (!c.active ? t('আপনি আর এই গ্রুপে নেই', 'You are no longer in this group') : t('শুধু অ্যাডমিনরা পাঠাতে পারেন', 'Only admins can send')),
                textAlign: TextAlign.center,
                style: TextStyle(color: p.muted, fontWeight: FontWeight.w600),
              ),
            ),
          ),
      ]),
    );
  }

  void _openInfo() => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ConversationInfoScreen(conversationId: widget.conversationId)));

  Future<void> _guard(Future<void> Function() action) async {
    try {
      await action();
    } catch (error) {
      if (mounted) showMessage(context, error is ApiError ? error.message : context.read<Prefs>().t('কিছু একটা সমস্যা হয়েছে।', 'Something went wrong.'), error: true);
    }
  }

  void _chatMenu(Conversation c) {
    final t = context.read<Prefs>().t;
    final muted = c.mutedUntil != null;
    final navigator = Navigator.of(context);
    showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            _item(sheet, LucideIcons.users, c.isGroup ? t('গ্রুপের তথ্য', 'Group info') : t('কন্টাক্টের তথ্য', 'Contact info'), _openInfo),
            _item(sheet, muted ? LucideIcons.bellRing : LucideIcons.bellOff, muted ? t('আনমিউট', 'Unmute') : t('নোটিফিকেশন মিউট', 'Mute notifications'),
                () => _guard(() => chat.updateSettings(c.id, {'mutedUntil': muted ? null : DateTime.now().add(const Duration(hours: 8)).toUtc().toIso8601String()}))),
            _item(sheet, c.pinned ? LucideIcons.pinOff : LucideIcons.pin, c.pinned ? t('চ্যাট আনপিন', 'Unpin chat') : t('চ্যাট পিন', 'Pin chat'), () => _guard(() => chat.updateSettings(c.id, {'pinned': !c.pinned}))),
            _item(sheet, c.archived ? LucideIcons.archiveRestore : LucideIcons.archive, c.archived ? t('আর্কাইভ থেকে সরান', 'Unarchive') : t('চ্যাট আর্কাইভ', 'Archive chat'), () => _guard(() async {
                  final archiving = !c.archived;
                  await chat.updateSettings(c.id, {'archived': archiving});
                  if (archiving) navigator.pop();
                })),
            _item(sheet, LucideIcons.mailOpen, t('অপঠিত চিহ্নিত করুন', 'Mark as unread'), () => _guard(() async {
                  await chat.updateSettings(c.id, {'markedUnread': true});
                  navigator.pop();
                })),
            _item(sheet, LucideIcons.eraser, t('চ্যাট খালি করুন', 'Clear chat'), () async {
              if (await _confirm(t('চ্যাট খালি করবেন?', 'Clear this chat?'), t('খালি করুন', 'Clear'))) await _guard(() => chat.clearChat(c.id));
            }, danger: true),
            if (!c.isGroup || !c.active)
              _item(sheet, LucideIcons.trash2, t('চ্যাট মুছুন', 'Delete chat'), () async {
                if (!await _confirm(t('চ্যাটটি মুছবেন?', 'Delete this chat?'), t('মুছুন', 'Delete'))) return;
                await _guard(() async {
                  await chat.deleteConversation(c.id);
                  navigator.pop();
                });
              }, danger: true),
          ]),
        ),
      ),
    );
  }

  Future<bool> _confirm(String title, String action) async {
    final t = context.read<Prefs>().t;
    final yes = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(title),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog), child: Text(t('বাতিল', 'Cancel'))),
          TextButton(onPressed: () => Navigator.pop(dialog, true), child: Text(action, style: TextStyle(color: context.palette.danger))),
        ],
      ),
    );
    return yes == true;
  }

  Future<void> _info(ChatMessage m) async {
    final t = context.read<Prefs>().t;
    ({List<String> readBy, List<String> deliveredTo})? info;
    await _guard(() async => info = await chat.messageInfo(m.id));
    if (!mounted || info == null) return;
    final p = context.palette;
    Widget people(String label, List<String> ids, Color color) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: TextStyle(fontWeight: FontWeight.w800, color: color)),
          const SizedBox(height: 6),
          if (ids.isEmpty) Text('-', style: TextStyle(color: p.subtle)),
          for (final id in ids)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(children: [
                Avatar(name: chat.nameOf(id), url: chat.profiles[id]?.avatarUrl, size: 34),
                const SizedBox(width: 10),
                Expanded(child: Text(chat.nameOf(id), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600))),
              ]),
            ),
        ]);
    await showModalBottomSheet<void>(
      context: context,
      builder: (_) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(t('মেসেজের তথ্য', 'Message info'), style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 16),
            people(t('পড়েছেন', 'Read by'), info!.readBy, Colors.lightBlue),
            const SizedBox(height: 16),
            people(t('পৌঁছেছে', 'Delivered to'), info!.deliveredTo, p.muted),
          ]),
        ),
      ),
    );
  }

  void _actions(ChatMessage m) {
    final t = context.read<Prefs>().t;
    final mine = m.senderId == chat.me;
    final p = context.palette;
    HapticFeedback.mediumImpact();
    if (m.deleted || m.local != null) {
      if (m.local == 'failed') {
        showModalBottomSheet<void>(
          context: context,
          builder: (_) => SafeArea(
            child: ListTile(
              leading: const Icon(LucideIcons.rotateCw),
              title: Text(t('আবার পাঠান', 'Retry'), style: const TextStyle(fontWeight: FontWeight.w700)),
              onTap: () {
                Navigator.pop(context);
                if (m.kind == 'text') chat.sendText(widget.conversationId, m.text ?? '', retry: m).catchError((_) {});
              },
            ),
          ),
        );
      }
      return;
    }
    final editable = mine && m.kind == 'text' && DateTime.now().difference(m.time).inMinutes < 15;
    final pinned = chat.pins[widget.conversationId]?.contains(m.id) ?? false;
    const emojis = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
    final myReaction = m.reactions.where((r) => r.userIds.contains(chat.me)).firstOrNull?.emoji;
    showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
              for (final e in emojis)
                InkWell(
                  borderRadius: BorderRadius.circular(99),
                  onTap: () {
                    Navigator.pop(sheet);
                    chat.react(widget.conversationId, m.id, myReaction == e ? null : e).catchError((_) {});
                  },
                  child: Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(color: myReaction == e ? p.brandSoft : null, shape: BoxShape.circle),
                    child: Text(e, style: const TextStyle(fontSize: 28)),
                  ),
                ),
            ]),
          ),
          const Divider(),
          _item(sheet, LucideIcons.reply, t('উত্তর দিন', 'Reply'), () => setState(() {
                replyTo = m;
                editing = null;
              })),
          if ((m.text ?? '').isNotEmpty)
            _item(sheet, LucideIcons.copy, t('কপি', 'Copy'), () {
              Clipboard.setData(ClipboardData(text: m.text!));
              showMessage(context, t('কপি হয়েছে', 'Copied'));
            }),
          if (editable) _item(sheet, LucideIcons.pencil, t('সম্পাদনা', 'Edit'), () => setState(() {
                editing = m;
                replyTo = null;
              })),
          if (mine) _item(sheet, LucideIcons.info, t('তথ্য', 'Info'), () => _info(m)),
          _item(sheet, m.starred ? LucideIcons.starOff : LucideIcons.star, m.starred ? t('তারকা সরান', 'Unstar') : t('তারকা দিন', 'Star'), () => chat.star(widget.conversationId, m.id, !m.starred)),
          _item(sheet, pinned ? LucideIcons.pinOff : LucideIcons.pin, pinned ? t('পিন সরান', 'Unpin') : t('পিন করুন', 'Pin'), () => chat.pin(widget.conversationId, m.id, !pinned)),
          _item(sheet, LucideIcons.trash2, t('মুছুন', 'Delete'), () => _delete(m, mine), danger: true),
        ]),
      ),
    );
  }

  Widget _item(BuildContext sheet, IconData icon, String label, VoidCallback onTap, {bool danger = false}) {
    final color = danger ? context.palette.danger : context.palette.text;
    return ListTile(
      leading: Icon(icon, color: color),
      title: Text(label, style: TextStyle(fontWeight: FontWeight.w700, color: color)),
      onTap: () {
        Navigator.pop(sheet);
        onTap();
      },
    );
  }

  Future<void> _delete(ChatMessage m, bool mine) async {
    final t = context.read<Prefs>().t;
    final c = chat.conversations[widget.conversationId];
    final forEveryone = mine ? DateTime.now().difference(m.time).inHours < 48 : (c?.isGroup == true && c!.isAdmin);
    final scope = await showDialog<String>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(t('বার্তা মুছবেন?', 'Delete message?')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog), child: Text(t('বাতিল', 'Cancel'))),
          TextButton(onPressed: () => Navigator.pop(dialog, 'me'), child: Text(t('আমার জন্য', 'For me'))),
          if (forEveryone) TextButton(onPressed: () => Navigator.pop(dialog, 'everyone'), child: Text(t('সবার জন্য', 'For everyone'), style: TextStyle(color: context.palette.danger))),
        ],
      ),
    );
    if (scope != null) chat.deleteMessage(widget.conversationId, m.id, scope).catchError((_) {});
  }
}

/// Lets the calls feature plug the call buttons in without the chat screens depending on it.
void Function(BuildContext context, Conversation conversation, bool video)? callHook;

class _DayChip extends StatelessWidget {
  const _DayChip({required this.label});
  final String label;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
          decoration: BoxDecoration(color: p.surface.withValues(alpha: 0.9), borderRadius: BorderRadius.circular(99)),
          child: Text(label, textAlign: TextAlign.center, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: p.muted)),
        ),
      ),
    );
  }
}

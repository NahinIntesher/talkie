import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import '../chat/chat.dart';
import '../chat/models.dart';
import '../core/prefs.dart';
import '../core/realtime.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'new_chat.dart';
import 'thread.dart';

void openThread(BuildContext context, String conversationId) {
  Navigator.of(context).push(MaterialPageRoute(builder: (_) => ThreadScreen(conversationId: conversationId)));
}

class ChatsScreen extends StatefulWidget {
  const ChatsScreen({super.key, this.archived = false});
  final bool archived;
  @override
  State<ChatsScreen> createState() => _ChatsScreenState();
}

class _ChatsScreenState extends State<ChatsScreen> {
  final search = TextEditingController();
  String filter = 'all';

  @override
  void dispose() {
    search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final chat = context.watch<Chat>();
    final prefs = context.watch<Prefs>();
    final p = context.palette;
    final t = prefs.t;
    final rawQuery = search.text.trim();
    final query = rawQuery.toLowerCase().replaceFirst(RegExp(r'^@'), '');
    var list = chat.ordered(archived: widget.archived);
    if (!widget.archived && query.isNotEmpty) list = [...list, ...chat.ordered(archived: true)];
    if (filter == 'unread') list = list.where((c) => c.unreadCount > 0 || c.markedUnread).toList();
    if (filter == 'groups') list = list.where((c) => c.isGroup).toList();
    if (query.isNotEmpty) list = list.where((c) => chat.titleOf(c).toLowerCase().contains(query) || (chat.profiles[c.peerId]?.username.contains(query) ?? false)).toList();
    final archivedCount = widget.archived ? 0 : chat.ordered(archived: true).length;

    return Scaffold(
      appBar: AppBar(
        titleSpacing: widget.archived ? 0 : 20,
        title: widget.archived
            ? Text(t('আর্কাইভ', 'Archived'))
            : Row(children: [
                const LogoMark(size: 30),
                const SizedBox(width: 10),
                const Text('Talkie'),
                const SizedBox(width: 10),
                ValueListenableBuilder(
                  valueListenable: realtime.state,
                  builder: (_, state, _) => state == Connection.connected
                      ? const SizedBox.shrink()
                      : SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: p.subtle)),
                ),
              ]),
      ),
      floatingActionButton: widget.archived
          ? null
          : FloatingActionButton(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NewChatScreen())),
              backgroundColor: Palette.fill[1],
              foregroundColor: Palette.onBrand,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
              child: const Icon(LucideIcons.messageCirclePlus),
            ).animate().scale(delay: 200.ms, duration: 350.ms, curve: Curves.easeOutBack),
      body: RefreshIndicator(
        color: p.brand,
        onRefresh: chat.loadConversations,
        child: CustomScrollView(slivers: [
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: TextField(
                controller: search,
                onChanged: (_) => setState(() {}),
                decoration: InputDecoration(
                  hintText: t('খুঁজুন', 'Search'),
                  prefixIcon: const Icon(LucideIcons.search, size: 20),
                  suffixIcon: rawQuery.isEmpty ? null : IconButton(icon: const Icon(LucideIcons.x, size: 18), onPressed: () => setState(search.clear)),
                  contentPadding: const EdgeInsets.symmetric(vertical: 10),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide.none),
                  focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide(color: p.brand.withValues(alpha: 0.6), width: 1)),
                ),
              ),
            ),
          ),
          if (!widget.archived)
            SliverToBoxAdapter(
              child: SizedBox(
                height: 44,
                child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 16), children: [
                  for (final (key, label) in [('all', t('সব', 'All')), ('unread', t('অপঠিত', 'Unread')), ('groups', t('গ্রুপ', 'Groups'))])
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ChoiceChip(
                        label: Text(label),
                        selected: filter == key,
                        onSelected: (_) => setState(() => filter = key),
                        showCheckmark: false,
                        labelStyle: TextStyle(fontWeight: FontWeight.w700, color: filter == key ? p.brand : p.muted),
                        selectedColor: p.brandSoft,
                        backgroundColor: p.surface2,
                        side: BorderSide.none,
                        shape: const StadiumBorder(),
                      ),
                    ),
                ]),
              ),
            ),
          if (archivedCount > 0 && query.isEmpty)
            SliverToBoxAdapter(
              child: ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 24),
                leading: Icon(LucideIcons.archive, color: p.muted),
                title: Text(t('আর্কাইভ', 'Archived'), style: const TextStyle(fontWeight: FontWeight.w700)),
                trailing: Text(digits('$archivedCount', prefs), style: TextStyle(color: p.brand, fontWeight: FontWeight.w800)),
                onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const ChatsScreen(archived: true))),
              ),
            ),
          if (!chat.ready)
            const SliverFillRemaining(hasScrollBody: false, child: Center(child: CircularProgressIndicator()))
          else if (list.isEmpty)
            SliverFillRemaining(
              hasScrollBody: false,
              child: Center(
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Container(
                    width: 84,
                    height: 84,
                    decoration: BoxDecoration(color: p.brandSoft, shape: BoxShape.circle),
                    child: Icon(query.isEmpty ? LucideIcons.messagesSquare : LucideIcons.searchX, color: p.brand, size: 36),
                  ),
                  const SizedBox(height: 16),
                  Text(query.isEmpty ? t('এখনো কোনো চ্যাট নেই', 'No chats yet') : t('কিছু পাওয়া যায়নি', 'Nothing found'), style: Theme.of(context).textTheme.titleMedium),
                  if (!widget.archived && RegExp(r'^[a-z0-9._]{3,32}$').hasMatch(query))
                    TextButton(
                      onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => NewChatScreen(initialQuery: rawQuery))),
                      child: Text(t('@$query খুঁজুন', 'Find @$query')),
                    ),
                ]).animate().fadeIn(duration: 300.ms),
              ),
            )
          else
            SliverList.builder(
              itemCount: list.length,
              itemBuilder: (context, i) => _ChatRow(conversation: list[i]),
            ),
          const SliverToBoxAdapter(child: SizedBox(height: 96)),
        ]),
      ),
    );
  }
}

class _ChatRow extends StatelessWidget {
  const _ChatRow({required this.conversation});
  final Conversation conversation;

  @override
  Widget build(BuildContext context) {
    final chat = context.read<Chat>();
    final prefs = context.read<Prefs>();
    final p = context.palette;
    final c = conversation;
    final title = chat.titleOf(c, fallback: prefs.t('চ্যাট', 'Chat'));
    final last = c.last;
    final typing = chat.typingIn(c.id).where((u) => u != chat.me).toList();
    final unread = c.unreadCount > 0 || c.markedUnread;
    final muted = c.mutedUntil != null && DateTime.parse(c.mutedUntil!).isAfter(DateTime.now());
    final mine = last != null && last.senderId == chat.me && last.kind != 'system';
    final r = chat.receipts[c.id];
    final online = c.peerId != null && chat.online[c.peerId] == true;

    String line;
    if (typing.isNotEmpty) {
      line = c.isGroup ? prefs.t('${chat.nameOf(typing.first)} লিখছেন…', '${chat.nameOf(typing.first)} is typing…') : prefs.t('লিখছেন…', 'typing…');
    } else {
      final who = c.isGroup && last != null && last.kind != 'system' && !mine ? '${chat.nameOf(last.senderId)}: ' : '';
      line = '$who${preview(last, chat, prefs)}';
    }

    return InkWell(
      onTap: () => openThread(context, c.id),
      onLongPress: () => _actions(context),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(children: [
          Stack(clipBehavior: Clip.none, children: [
            Avatar(name: title, url: chat.avatarOf(c), size: 54, group: c.isGroup && chat.avatarOf(c) == null),
            if (online)
              Positioned(
                right: 1,
                bottom: 1,
                child: Container(width: 14, height: 14, decoration: BoxDecoration(color: p.success, shape: BoxShape.circle, border: Border.all(color: p.bg, width: 2.5))),
              ),
          ]),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 16.5, fontWeight: FontWeight.w800, color: p.text))),
                if (last != null) Text(listTime(last.time, prefs), style: TextStyle(fontSize: 12, fontWeight: unread ? FontWeight.w800 : FontWeight.w600, color: unread ? p.brand : p.subtle)),
              ]),
              const SizedBox(height: 3),
              Row(children: [
                if (mine && typing.isEmpty) ...[Ticks(message: last, receipts: r, size: 16), const SizedBox(width: 3)],
                Expanded(
                  child: Text(
                    line,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 14, color: typing.isNotEmpty ? p.brand : (unread ? p.text : p.muted), fontWeight: typing.isNotEmpty || unread ? FontWeight.w700 : FontWeight.w500),
                  ),
                ),
                if (muted) Padding(padding: const EdgeInsets.only(left: 6), child: Icon(LucideIcons.bellOff, size: 15, color: p.subtle)),
                if (c.pinned) Padding(padding: const EdgeInsets.only(left: 6), child: Icon(LucideIcons.pin, size: 15, color: p.subtle)),
                if (unread)
                  Container(
                    margin: const EdgeInsets.only(left: 8),
                    padding: const EdgeInsets.symmetric(horizontal: 7),
                    constraints: const BoxConstraints(minWidth: 22, minHeight: 22),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(gradient: muted ? null : p.gradient, color: muted ? p.subtle : null, borderRadius: BorderRadius.circular(99)),
                    child: Text(c.unreadCount > 0 ? digits('${c.unreadCount}', prefs) : '', style: TextStyle(color: muted ? Colors.white : Palette.onBrand, fontSize: 12, fontWeight: FontWeight.w800)),
                  ),
              ]),
            ]),
          ),
        ]),
      ),
    );
  }

  void _actions(BuildContext context) {
    final chat = context.read<Chat>();
    final t = context.read<Prefs>().t;
    final c = conversation;
    final muted = c.mutedUntil != null;
    showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          _SheetAction(icon: c.pinned ? LucideIcons.pinOff : LucideIcons.pin, label: c.pinned ? t('পিন সরান', 'Unpin') : t('পিন করুন', 'Pin'), onTap: () => chat.updateSettings(c.id, {'pinned': !c.pinned})),
          _SheetAction(
            icon: muted ? LucideIcons.bell : LucideIcons.bellOff,
            label: muted ? t('আনমিউট', 'Unmute') : t('মিউট', 'Mute'),
            onTap: () => chat.updateSettings(c.id, {'mutedUntil': muted ? null : DateTime.now().add(const Duration(days: 3650)).toUtc().toIso8601String()}),
          ),
          _SheetAction(icon: c.archived ? LucideIcons.archiveRestore : LucideIcons.archive, label: c.archived ? t('আর্কাইভ থেকে সরান', 'Unarchive') : t('আর্কাইভ', 'Archive'), onTap: () => chat.updateSettings(c.id, {'archived': !c.archived})),
          _SheetAction(icon: LucideIcons.mailOpen, label: t('অপঠিত চিহ্নিত করুন', 'Mark as unread'), onTap: () => chat.updateSettings(c.id, {'markedUnread': true})),
          if (!c.isGroup || !c.active)
            _SheetAction(
              icon: LucideIcons.trash2,
              label: t('চ্যাট মুছুন', 'Delete chat'),
              danger: true,
              onTap: () async {
                final yes = await showDialog<bool>(
                  context: context,
                  builder: (dialog) => AlertDialog(
                    title: Text(t('চ্যাটটি মুছবেন?', 'Delete this chat?')),
                    actions: [
                      TextButton(onPressed: () => Navigator.pop(dialog), child: Text(t('বাতিল', 'Cancel'))),
                      TextButton(onPressed: () => Navigator.pop(dialog, true), child: Text(t('মুছুন', 'Delete'), style: TextStyle(color: context.palette.danger))),
                    ],
                  ),
                );
                if (yes != true) return;
                try {
                  await chat.deleteConversation(c.id);
                } catch (_) {
                  if (context.mounted) showMessage(context, t('কিছু একটা সমস্যা হয়েছে।', 'Something went wrong.'), error: true);
                }
              },
            ),
        ]),
      ),
    );
  }
}

class _SheetAction extends StatelessWidget {
  const _SheetAction({required this.icon, required this.label, required this.onTap, this.danger = false});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool danger;
  @override
  Widget build(BuildContext context) {
    final color = danger ? context.palette.danger : context.palette.text;
    return ListTile(
      leading: Icon(icon, color: color),
      title: Text(label, style: TextStyle(fontWeight: FontWeight.w700, color: color)),
      onTap: () {
        Navigator.of(context).pop();
        onTap();
      },
    );
  }
}

/// Sent / delivered / read ticks for my messages.
class Ticks extends StatelessWidget {
  const Ticks({super.key, required this.message, required this.receipts, this.size = 15, this.onBubble = false});
  final ChatMessage message;
  final Receipts? receipts;
  final double size;
  final bool onBubble;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final base = onBubble ? Colors.white.withValues(alpha: 0.75) : p.subtle;
    if (message.local == 'sending') return Icon(LucideIcons.clock3, size: size - 2, color: base);
    if (message.local == 'failed') return Icon(LucideIcons.circleAlert, size: size, color: p.danger);
    final r = receipts;
    final read = r != null && !newer(message.id, r.read);
    final delivered = r != null && !newer(message.id, r.delivered);
    if (read) return Icon(LucideIcons.checkCheck, size: size, color: onBubble ? const Color(0xFF9EF0FF) : p.brand);
    if (delivered) return Icon(LucideIcons.checkCheck, size: size, color: base);
    return Icon(LucideIcons.check, size: size, color: base);
  }
}

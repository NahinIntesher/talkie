import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import '../chat/chat.dart';
import '../chat/models.dart';
import '../core/api.dart';
import '../core/prefs.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'calls.dart';

/// Call history.
class CallsScreen extends StatefulWidget {
  const CallsScreen({super.key});
  @override
  State<CallsScreen> createState() => _CallsScreenState();
}

class _CallsScreenState extends State<CallsScreen> {
  List<Json>? calls;

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final r = await api.get('/meet/calls');
      final list = (r['calls'] as List).cast<Json>();
      if (!mounted) return;
      context.read<Chat>().loadProfiles(list.expand((c) => (c['participants'] as List).map((p) => p['userId'] as String)));
      setState(() => calls = list);
    } catch (_) {
      if (mounted) setState(() => calls ??= []);
    }
  }

  @override
  Widget build(BuildContext context) {
    final chat = context.watch<Chat>();
    final prefs = context.watch<Prefs>();
    // Reload when a call finishes.
    context.select<Calls, bool>((c) => c.phase == null);
    final t = prefs.t;
    final p = context.palette;
    return Scaffold(
      appBar: AppBar(title: Text(t('কল', 'Calls')), titleSpacing: 20),
      body: RefreshIndicator(
        onRefresh: load,
        child: calls == null
            ? const Center(child: CircularProgressIndicator())
            : calls!.isEmpty
                ? ListView(children: [
                    const SizedBox(height: 160),
                    Center(child: CircleAvatar(radius: 42, backgroundColor: p.brandSoft, child: Icon(LucideIcons.phone, color: p.brand, size: 34))),
                    const SizedBox(height: 16),
                    Center(child: Text(t('কোনো কল নেই', 'No calls yet'), style: Theme.of(context).textTheme.titleMedium)),
                  ])
                : ListView.builder(
                    itemCount: calls!.length,
                    itemBuilder: (context, i) {
                      final call = calls![i];
                      final outgoing = call['initiatorId'] == chat.me;
                      final others = (call['participants'] as List).map((x) => x['userId'] as String).where((u) => u != chat.me).toList();
                      final conversation = chat.conversations[call['conversationId']];
                      final name = conversation != null ? chat.titleOf(conversation) : (others.isEmpty ? '…' : chat.nameOf(others.first));
                      final missed = !outgoing && call['answeredAt'] == null;
                      final video = call['media'] == 'video';
                      final time = DateTime.parse(call['createdAt'] as String).toLocal();
                      final length = call['answeredAt'] != null && call['endedAt'] != null
                          ? DateTime.parse(call['endedAt'] as String).difference(DateTime.parse(call['answeredAt'] as String)).inMilliseconds
                          : null;
                      return ListTile(
                        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                        leading: Avatar(name: name, url: conversation != null ? chat.avatarOf(conversation) : null, size: 48, group: conversation?.isGroup ?? false),
                        title: Text(name, style: TextStyle(fontWeight: FontWeight.w800, color: missed ? p.danger : p.text)),
                        subtitle: Row(children: [
                          Icon(outgoing ? LucideIcons.arrowUpRight : LucideIcons.arrowDownLeft, size: 15, color: missed ? p.danger : p.success),
                          const SizedBox(width: 4),
                          Text(
                            '${listTime(time, prefs)}, ${clock(time, prefs)}${length != null ? ' · ${digits(duration(length), prefs)}' : ''}',
                            style: TextStyle(color: p.subtle, fontWeight: FontWeight.w600),
                          ),
                        ]),
                        trailing: call['conversationId'] == null
                            ? null
                            : IconButton(
                                icon: Icon(video ? LucideIcons.video : LucideIcons.phone, color: p.brand),
                                onPressed: () async {
                                  final error = await context.read<Calls>().start(call['conversationId'] as String, video);
                                  if (error != null && context.mounted) showMessage(context, error, error: true);
                                },
                              ),
                      );
                    },
                  ),
      ),
    );
  }
}

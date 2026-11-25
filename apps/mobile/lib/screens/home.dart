import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import '../call/calls.dart';
import '../call/calls_screen.dart';
import '../chat/chat.dart';
import '../core/prefs.dart';
import '../meet/meet_screen.dart';
import '../status/status.dart';
import '../status/status_screen.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'chats.dart';
import 'settings.dart';
import 'thread.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  int tab = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    context.read<Chat>().start();
    context.read<Calls>();
    context.read<Statuses>();
    callHook = (context, conversation, video) async {
      final error = await context.read<Calls>().start(conversation.id, video);
      if (error != null && context.mounted) showMessage(context, error, error: true);
    };
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final chat = context.read<Chat>();
    if (state == AppLifecycleState.resumed) {
      chat.resumed();
    } else if (state == AppLifecycleState.paused) {
      chat.appVisible = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final prefs = context.watch<Prefs>();
    final unread = context.select<Chat, int>((c) => c.unreadChats);
    final p = context.palette;
    final freshStatus = context.select<Statuses, bool>((s) => s.groups.any((g) => !g.allViewed && !s.muted.contains(g.ownerId)));
    const pages = [ChatsScreen(), StatusScreen(), CallsScreen(), MeetScreen(), SettingsScreen()];
    return Scaffold(
      body: IndexedStack(index: tab, children: pages),
      bottomNavigationBar: NavigationBarTheme(
        data: NavigationBarThemeData(
          backgroundColor: p.surface,
          indicatorColor: p.brandSoft,
          labelTextStyle: WidgetStateProperty.resolveWith((s) => TextStyle(fontSize: 12, fontWeight: s.contains(WidgetState.selected) ? FontWeight.w800 : FontWeight.w600, color: s.contains(WidgetState.selected) ? p.brand : p.subtle)),
          iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(color: s.contains(WidgetState.selected) ? p.brand : p.subtle, size: 24)),
        ),
        child: NavigationBar(
          selectedIndex: tab,
          height: 68,
          onDestinationSelected: (i) => setState(() => tab = i),
          destinations: [
            NavigationDestination(
              icon: Badge(isLabelVisible: unread > 0, label: Text(digits('$unread', prefs)), backgroundColor: p.brand, child: const Icon(LucideIcons.messageCircle)),
              label: prefs.t('চ্যাট', 'Chats'),
            ),
            NavigationDestination(
              icon: Badge(isLabelVisible: freshStatus, smallSize: 8, backgroundColor: p.accent, child: const Icon(LucideIcons.circleDashed)),
              label: prefs.t('স্ট্যাটাস', 'Status'),
            ),
            NavigationDestination(icon: const Icon(LucideIcons.phone), label: prefs.t('কল', 'Calls')),
            NavigationDestination(icon: const Icon(LucideIcons.video), label: prefs.t('মিট', 'Meet')),
            NavigationDestination(icon: const Icon(LucideIcons.settings), label: prefs.t('সেটিংস', 'Settings')),
          ],
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:provider/provider.dart';

import 'call/call_overlay.dart';
import 'call/calls.dart';
import 'chat/chat.dart';
import 'status/status.dart';
import 'core/crypto.dart';
import 'core/prefs.dart';
import 'core/push.dart';
import 'core/session.dart';
import 'screens/home.dart';
import 'screens/signin.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  await Future.wait([Crypto.init(), initializeDateFormatting('bn'), initializeDateFormatting('en')]);
  final prefs = Prefs();
  await prefs.load();
  await push.init(bangla: prefs.bn);
  final session = Session();
  session.restore();
  runApp(MultiProvider(
    providers: [
      ChangeNotifierProvider.value(value: prefs),
      ChangeNotifierProvider.value(value: session),
    ],
    child: const TalkieApp(),
  ));
}

class TalkieApp extends StatelessWidget {
  const TalkieApp({super.key});

  @override
  Widget build(BuildContext context) {
    final prefs = context.watch<Prefs>();
    final session = context.watch<Session>();
    final signedIn = session.status == SessionStatus.signedIn;
    final app = MaterialApp(
      builder: (context, child) {
        // Quicksand looks larger than Baloo Da 2 at the same size: English uses slightly smaller text (as on the web).
        final content = signedIn ? CallOverlay(child: child!) : child!;
        if (prefs.locale != 'en') return content;
        final media = MediaQuery.of(context);
        return MediaQuery(
          data: media.copyWith(textScaler: _EnglishTextScaler(media.textScaler)),
          child: content,
        );
      },
      title: 'Talkie',
      debugShowCheckedModeBanner: false,
      themeMode: prefs.theme,
      theme: buildTheme(Brightness.light, bangla: prefs.bn),
      darkTheme: buildTheme(Brightness.dark, bangla: prefs.bn),
      locale: Locale(prefs.locale),
      home: switch (session.status) {
        SessionStatus.loading => const _Splash(),
        SessionStatus.reconnecting => Scaffold(body: Center(child: FilledButton(
          onPressed: session.restore,
          child: Text(prefs.t('আবার সংযোগ করুন', 'Reconnect')),
        ))),
        SessionStatus.signedOut => const SignInScreen(),
        SessionStatus.signedIn => const HomeScreen(),
      },
    );
    if (!signedIn) return app;
    // One chat engine (and call engine) per signed-in account, above the navigator so every screen can reach them.
    return ChangeNotifierProvider<Chat>(
      key: ValueKey(session.userId),
      create: (_) => Chat(session),
      child: MultiProvider(
        providers: [
          ChangeNotifierProvider<Calls>(create: (context) => Calls(context.read<Chat>())),
          ChangeNotifierProvider<Statuses>(create: (context) => Statuses(context.read<Chat>())),
        ],
        child: app,
      ),
    );
  }
}

class _EnglishTextScaler extends TextScaler {
  const _EnglishTextScaler(this.systemScaler);

  final TextScaler systemScaler;

  @override
  double scale(double fontSize) => systemScaler.scale(fontSize * 0.94);

  @override
  double get textScaleFactor => scale(14) / 14;

  @override
  bool operator ==(Object other) =>
      other is _EnglishTextScaler && other.systemScaler == systemScaler;

  @override
  int get hashCode => systemScaler.hashCode;
}

class _Splash extends StatelessWidget {
  const _Splash();
  @override
  Widget build(BuildContext context) => const Scaffold(body: Center(child: LogoMark(size: 72)));
}

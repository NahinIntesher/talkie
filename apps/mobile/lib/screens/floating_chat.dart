import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:provider/provider.dart';

import '../chat/chat.dart';
import '../core/api.dart';
import '../core/chat_bubbles.dart';
import '../core/prefs.dart';
import '../core/session.dart';
import '../ui/theme.dart';
import 'thread.dart';

class FloatingChatApp extends StatefulWidget {
  const FloatingChatApp({super.key, required this.prefs, required this.route});
  final Prefs prefs;
  final String route;

  @override
  State<FloatingChatApp> createState() => _FloatingChatAppState();
}

class _FloatingChatAppState extends State<FloatingChatApp>
    with WidgetsBindingObserver {
  static const _storage = FlutterSecureStorage();
  late final Session _session = Session(expectedDevice: _device);
  Chat? _chat;
  String? _device;
  String? _conversation;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final parts = widget.route.split('/');
    if (parts.length == 4 &&
        validBubbleId(parts[2]) &&
        validBubbleId(parts[3])) {
      _device = parts[2];
      _conversation = parts[3];
    }
    _session.addListener(_sessionChanged);
    unawaited(_load());
  }

  Future<bool> _ownsDevice() async {
    if (_device == null || !(await bubbleStatus(_device)).enabled) return false;
    final stored = await _storage.read(key: 'talkie.device');
    return stored != null && jsonDecode(stored)['deviceId'] == _device;
  }

  Future<void> _load() async {
    try {
      if (await _ownsDevice()) {
        await _session.restore();
        if (!mounted) return;
        if (_session.status == SessionStatus.signedIn &&
            _session.deviceId == _device &&
            api.accessToken != null &&
            await _ownsDevice() &&
            mounted) {
          final chat = _chat = Chat(_session);
          unawaited(chat.start());
        }
      }
    } catch (_) {
      // Use the retry view when secure storage, authentication, or the network is unavailable.
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _sessionChanged() {
    if (_chat != null && _session.status == SessionStatus.signedOut) {
      _closeThread();
    }
  }

  void _closeThread() {
    final previous = _chat;
    if (previous == null || !mounted) return;
    previous.stop();
    setState(() => _chat = null);
    WidgetsBinding.instance.addPostFrameCallback((_) => previous.dispose());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final chat = _chat;
    if (chat == null) return;
    chat.appVisible = false;
    if (state == AppLifecycleState.resumed) {
      unawaited(() async {
        if (await _ownsDevice().catchError((Object _) => false) &&
            mounted && _chat == chat) {
          chat.resumed();
        } else if (mounted && _chat == chat) {
          _closeThread();
        }
      }());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _session.removeListener(_sessionChanged);
    _chat?.dispose();
    _session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final prefs = widget.prefs;
    final chat = _chat;
    return ChangeNotifierProvider.value(
      value: prefs,
      child: MaterialApp(
        initialRoute: '/',
        title: 'Talkie',
        debugShowCheckedModeBanner: false,
        themeMode: prefs.theme,
        theme: buildTheme(Brightness.light, bangla: prefs.bn),
        darkTheme: buildTheme(Brightness.dark, bangla: prefs.bn),
        home: chat == null
            ? Scaffold(
                body: Center(
                  child: _loading
                      ? const CircularProgressIndicator()
                      : FilledButton(
                          onPressed: () {
                            setState(() => _loading = true);
                            unawaited(_load());
                          },
                          child: Text(prefs.t('আবার চেষ্টা করুন', 'Try again')),
                        ),
                ),
              )
            : MultiProvider(
                providers: [
                  ChangeNotifierProvider.value(value: _session),
                  ChangeNotifierProvider.value(value: chat),
                ],
                child: ThreadScreen(
                  conversationId: _conversation!,
                  floating: true,
                ),
              ),
      ),
    );
  }
}

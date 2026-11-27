import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import '../core/api.dart';
import '../core/crypto.dart';
import '../core/prefs.dart';
import '../core/session.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

enum _Step { email, code, profile }

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});
  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  static const _storage = FlutterSecureStorage();
  static const _pendingCode = 'talkie.otp.pending';
  _Step step = _Step.email;
  final email = TextEditingController();
  final code = TextEditingController();
  final name = TextEditingController();
  final username = TextEditingController();
  final codeFocus = FocusNode();
  bool busy = false;
  String? error;
  String? challengeId;
  String? requestKey;
  String? signupToken;
  int resendAfter = 0;
  DateTime sentAt = DateTime.now();
  Timer? ticker;
  bool usernameEdited = false;
  String availability = 'idle';
  Timer? availabilityTimer;

  Prefs get prefs => context.read<Prefs>();
  String t(String bn, String en) => prefs.t(bn, en);

  @override
  void initState() {
    super.initState();
    _restoreCode();
  }

  Future<void> _restoreCode() async {
    try {
      final saved = await _storage.read(key: _pendingCode);
      if (!mounted || saved == null || busy || email.text.isNotEmpty || step != _Step.email) return;
      final data = jsonDecode(saved) as Map<String, dynamic>;
      final sent = DateTime.parse(data['sentAt'] as String);
      if (DateTime.now().difference(sent) >= const Duration(minutes: 10)) {
        await _forgetCode();
        return;
      }
      email.text = data['email'] as String;
      _awaitCode(data['requestKey'] as String, data['challengeId'] as String?, data['cooldown'] as int, data['uncertain'] == true, sent: sent);
    } catch (_) {}
  }

  Future<void> _rememberCode(String email, String attempt, String? id, int cooldown, bool uncertain, DateTime sent) async {
    try {
      await _storage.write(key: _pendingCode, value: jsonEncode({
        'email': email, 'requestKey': attempt, 'challengeId': id, 'cooldown': cooldown,
        'uncertain': uncertain, 'sentAt': sent.toIso8601String(),
      }));
    } catch (_) {}
  }

  Future<void> _forgetCode() async {
    try { await _storage.delete(key: _pendingCode); } catch (_) {}
  }

  @override
  void dispose() {
    ticker?.cancel();
    availabilityTimer?.cancel();
    for (final c in [email, code, name, username]) {
      c.dispose();
    }
    codeFocus.dispose();
    super.dispose();
  }

  String _message(Object err) {
    if (err is ApiError) return err.code == 'network' ? t('সংযোগ নেই', 'No connection') : err.message;
    return t('কিছু একটা ভুল হয়েছে', 'Something went wrong');
  }

  Future<void> requestCode() async {
    if (busy) return;
    final value = email.text.trim().toLowerCase();
    if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(value)) {
      setState(() => error = t('সঠিক ইমেইল দিন', 'Enter a valid email'));
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    final attempt = Crypto.b64(Crypto.instance.random(16));
    final sent = DateTime.now();
    try {
      await _rememberCode(value, attempt, null, 60, true, sent);
      final result = await api.post('/auth/otp/request', {'email': value, 'locale': prefs.locale, 'requestKey': attempt});
      final id = result['challengeId'] as String;
      final cooldown = (result['resendAfterSeconds'] as num).toInt();
      final uncertain = result['delivery'] == 'uncertain';
      await _rememberCode(value, attempt, id, cooldown, uncertain, sent);
      _awaitCode(attempt, id, cooldown, uncertain, sent: sent);
    } on ApiError catch (err) {
      if (err.status == 0 || err.status >= 500) {
        _awaitCode(attempt, null, 60, true, sent: sent);
      } else if (mounted) {
        await _forgetCode();
        if (!mounted) return;
        setState(() => error = _message(err));
      }
    } catch (err) {
      if (mounted) setState(() => error = _message(err));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  void _awaitCode(String attempt, String? id, int cooldown, bool uncertain, {required DateTime sent}) {
    if (!mounted) return;
    requestKey = attempt;
    challengeId = id;
    resendAfter = cooldown;
    sentAt = sent;
    code.clear();
    ticker?.cancel();
    ticker = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
    setState(() {
      step = _Step.code;
      error = uncertain ? t('মেইল পৌঁছেছে কি না নিশ্চিত হওয়া যায়নি। কোড পেলে এখানে দিন, না পেলে আবার পাঠান।', 'Delivery could not be confirmed. Enter the code if it arrives, or resend it.') : null;
    });
  }

  Future<void> pasteCode() async {
    final text = (await Clipboard.getData(Clipboard.kTextPlain))?.text?.trim() ?? '';
    if (!mounted || step != _Step.code || busy) return;
    final value = text.replaceAll(RegExp(r'[\s-]'), '');
    if (!RegExp(r'^\d{6}$').hasMatch(value)) {
      setState(() => error = t('আগে ছয় ডিজিটের কোডটি কপি করুন।', 'Copy the six-digit code first.'));
      return;
    }
    code.value = TextEditingValue(text: value, selection: TextSelection.collapsed(offset: value.length));
    await verify();
  }

  Future<void> verify() async {
    if (busy || code.text.length != 6) return;
    final session = context.read<Session>();
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = await api.post('/auth/otp/verify', {
        if (challengeId != null) 'challengeId': challengeId else 'requestKey': requestKey,
        'code': code.text, 'device': await session.deviceInfo(),
      }) as Map<String, dynamic>;
      await _forgetCode();
      if (!mounted) return;
      if (result['status'] == 'signed_in') {
        await session.signedIn(result);
        return;
      }
      signupToken = result['signupToken'] as String;
      setState(() => step = _Step.profile);
    } catch (err) {
      if (!mounted) return;
      if (err is ApiError && err.code.startsWith('otp_')) code.clear();
      final left = err is ApiError ? (err.details?['attemptsLeft']) : null;
      setState(() => error = left != null ? '${_message(err)} ($left)' : _message(err));
      HapticFeedback.heavyImpact();
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  void suggestUsername(String value) {
    if (usernameEdited) return;
    final suggested = value.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), '.').replaceAll(RegExp(r'^\.+|\.+$'), '');
    if (suggested.length >= 3) {
      username.text = suggested.length > 24 ? suggested.substring(0, 24) : suggested;
      checkUsername(username.text);
    }
  }

  String? usernameProblem(String value) {
    if (value.isEmpty) return null;
    if (value.length < 3) return t('অন্তত ৩ অক্ষর', 'At least 3 characters');
    if (value.length > 32) return t('সর্বোচ্চ ৩২ অক্ষর', 'At most 32 characters');
    if (!RegExp(r'^[a-z0-9._]+$').hasMatch(value)) return t('শুধু অক্ষর, সংখ্যা, ডট ও আন্ডারস্কোর', 'Only letters, numbers, dot and underscore');
    if (value.startsWith('.') || value.endsWith('.') || value.contains('..')) return t('ডটের অবস্থান ঠিক নয়', 'Dots in the wrong place');
    if (!RegExp('[a-z]').hasMatch(value)) return t('অন্তত একটি অক্ষর দিন', 'Include a letter');
    return null;
  }

  void checkUsername(String raw) {
    final value = raw.trim().toLowerCase();
    availabilityTimer?.cancel();
    if (value.isEmpty || usernameProblem(value) != null) {
      setState(() => availability = value.isEmpty ? 'idle' : 'invalid');
      return;
    }
    setState(() => availability = 'checking');
    availabilityTimer = Timer(const Duration(milliseconds: 350), () async {
      try {
        final result = await api.get('/users/username-available?username=${Uri.encodeQueryComponent(value)}');
        if (mounted && username.text.trim().toLowerCase() == value) setState(() => availability = result['available'] == true ? 'available' : (result['reason'] as String? ?? 'taken'));
      } catch (_) {
        if (mounted) setState(() => availability = 'idle');
      }
    });
  }

  Future<void> signup() async {
    final session = context.read<Session>();
    if (name.text.trim().isEmpty) {
      setState(() => error = t('আপনার নাম দিন', 'Enter your name'));
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = await api.post('/auth/signup', {
        'signupToken': signupToken,
        'username': username.text.trim().toLowerCase(),
        'displayName': name.text.trim(),
        'locale': prefs.locale,
        'device': await session.deviceInfo(),
      }) as Map<String, dynamic>;
      if (result['status'] == 'signed_in') await session.signedIn(result);
    } catch (err) {
      if (err is ApiError && err.code == 'otp_expired') setState(() => step = _Step.email);
      setState(() => error = _message(err));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    context.watch<Prefs>();
    final p = context.palette;
    return Scaffold(
      body: Container(
        decoration: BoxDecoration(
          gradient: RadialGradient(center: const Alignment(-0.8, -1), radius: 1.4, colors: [Palette.fill[1].withValues(alpha: 0.16), p.bg]),
        ),
        child: SafeArea(
          child: Column(children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 12, 0),
              child: Row(children: [
                const LogoMark(size: 36),
                const SizedBox(width: 10),
                Text('Talkie', style: Theme.of(context).textTheme.titleLarge),
                const Spacer(),
                TextButton(
                  onPressed: () => prefs.setLocale(prefs.bn ? 'en' : 'bn'),
                  child: Text(prefs.bn ? 'English' : 'বাংলা', style: TextStyle(fontWeight: FontWeight.w700, color: p.brand)),
                ),
              ]),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  _Progress(index: step.index),
                  const SizedBox(height: 36),
                  AnimatedSwitcher(
                    duration: const Duration(milliseconds: 320),
                    transitionBuilder: (child, anim) => FadeTransition(opacity: anim, child: SlideTransition(position: Tween(begin: const Offset(0.06, 0), end: Offset.zero).animate(anim), child: child)),
                    child: KeyedSubtree(key: ValueKey(step), child: _body(context)),
                  ),
                ]),
              ),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _icon(IconData icon) {
    final p = context.palette;
    return Container(
      width: 56,
      height: 56,
      decoration: BoxDecoration(color: p.brandSoft, borderRadius: BorderRadius.circular(18)),
      child: Icon(icon, color: p.brand, size: 26),
    ).animate().scale(duration: 400.ms, curve: Curves.easeOutBack);
  }

  Widget _error() => AnimatedSize(
        duration: const Duration(milliseconds: 200),
        child: error == null
            ? const SizedBox(height: 0, width: double.infinity)
            : Padding(padding: const EdgeInsets.only(top: 12), child: Text(error!, style: TextStyle(color: context.palette.danger, fontWeight: FontWeight.w600))),
      );

  Widget _body(BuildContext context) {
    final p = context.palette;
    final title = Theme.of(context).textTheme.headlineMedium;
    switch (step) {
      case _Step.email:
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _icon(LucideIcons.mail),
          const SizedBox(height: 20),
          Text(t('আপনার ইমেইল', 'Your email'), style: title),
          const SizedBox(height: 28),
          TextField(
            controller: email,
            autofocus: true,
            keyboardType: TextInputType.emailAddress,
            autofillHints: const [AutofillHints.email],
            textInputAction: TextInputAction.go,
            onSubmitted: (_) => requestCode(),
            onChanged: (_) => setState(() => error = null),
            decoration: InputDecoration(hintText: 'name@example.com', prefixIcon: const Icon(LucideIcons.atSign, size: 20)),
          ),
          _error(),
          const SizedBox(height: 24),
          GradientButton(label: t('এগিয়ে যান', 'Continue'), icon: LucideIcons.arrowRight, loading: busy, onPressed: requestCode),
        ]);
      case _Step.code:
        final left = (resendAfter - DateTime.now().difference(sentAt).inSeconds).clamp(0, 9999);
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          TextButton.icon(
            onPressed: busy ? null : () {
              _forgetCode();
              setState(() {
                step = _Step.email;
                error = null;
              });
            },
            style: TextButton.styleFrom(foregroundColor: p.muted, padding: const EdgeInsets.symmetric(horizontal: 8)),
            icon: const Icon(LucideIcons.arrowLeft, size: 18),
            label: Text(email.text.trim().toLowerCase(), style: const TextStyle(fontWeight: FontWeight.w700)),
          ),
          const SizedBox(height: 12),
          Text(t('কোডটি লিখুন', 'Enter the code'), style: title),
          const SizedBox(height: 28),
          _OtpField(controller: code, focus: codeFocus, enabled: !busy, invalid: error != null, onComplete: verify, onChanged: () => setState(() => error = null)),
          TextButton.icon(onPressed: busy ? null : pasteCode, icon: const Icon(LucideIcons.clipboardPaste, size: 18), label: Text(t('কোড পেস্ট করুন', 'Paste code'))),
          if (code.text.length == 6 && !busy) TextButton(onPressed: verify, child: Text(t('কোড যাচাই করুন', 'Verify code'))),
          SizedBox(height: 28, child: busy ? Padding(padding: const EdgeInsets.only(top: 12), child: LinearProgressIndicator(borderRadius: BorderRadius.circular(9), color: p.brand)) : null),
          _error(),
          const SizedBox(height: 8),
          TextButton(
            onPressed: left > 0 || busy ? null : requestCode,
            child: Text(left > 0 ? t('আবার পাঠান $left', 'Resend in ${left}s') : t('আবার পাঠান', 'Resend code'), style: const TextStyle(fontWeight: FontWeight.w700)),
          ),
        ]);
      case _Step.profile:
        final problem = usernameProblem(username.text.trim().toLowerCase());
        final taken = availability == 'taken' || availability == 'reserved';
        final ok = name.text.trim().isNotEmpty && availability == 'available';
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _icon(LucideIcons.userRound),
          const SizedBox(height: 20),
          Text(t('আপনার প্রোফাইল', 'Your profile'), style: title),
          const SizedBox(height: 28),
          TextField(
            controller: name,
            autofocus: true,
            textCapitalization: TextCapitalization.words,
            maxLength: 64,
            onChanged: (v) {
              suggestUsername(v);
              setState(() => error = null);
            },
            decoration: InputDecoration(hintText: t('নাম', 'Name'), counterText: '', prefixIcon: const Icon(LucideIcons.user, size: 20)),
          ),
          const SizedBox(height: 14),
          TextField(
            controller: username,
            autocorrect: false,
            maxLength: 32,
            onChanged: (v) {
              usernameEdited = true;
              checkUsername(v);
            },
            decoration: InputDecoration(
              hintText: t('ইউজারনেম', 'Username'),
              counterText: '',
              prefixIcon: const Icon(LucideIcons.atSign, size: 20),
              errorText: problem ?? (taken ? t('এই ইউজারনেম নেওয়া হয়েছে', 'This username is taken') : null),
              suffixIcon: switch (availability) {
                'checking' => const Padding(padding: EdgeInsets.all(14), child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))),
                'available' => Icon(LucideIcons.circleCheck, color: p.success),
                'taken' || 'reserved' => Icon(LucideIcons.circleX, color: p.danger),
                _ => null,
              },
            ),
          ),
          _error(),
          const SizedBox(height: 24),
          GradientButton(label: t('শুরু করুন', 'Get started'), icon: LucideIcons.arrowRight, loading: busy, onPressed: ok ? signup : null),
        ]);
    }
  }
}

class _Progress extends StatelessWidget {
  const _Progress({required this.index});
  final int index;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return Row(
      children: List.generate(3, (i) {
        return Expanded(
          child: Container(
            height: 6,
            margin: EdgeInsets.only(right: i < 2 ? 6 : 0),
            decoration: BoxDecoration(color: p.surface3, borderRadius: BorderRadius.circular(9)),
            child: AnimatedFractionallySizedBox(
              duration: const Duration(milliseconds: 450),
              curve: Curves.easeOutCubic,
              alignment: Alignment.centerLeft,
              widthFactor: index >= i ? 1 : 0,
              child: DecoratedBox(decoration: BoxDecoration(gradient: p.gradient, borderRadius: BorderRadius.circular(9))),
            ),
          ),
        );
      }),
    );
  }
}

/// One real text input over the six visual slots. Taps and long presses reach the platform editor.
class _OtpField extends StatelessWidget {
  const _OtpField({required this.controller, required this.focus, required this.enabled, required this.invalid, required this.onComplete, required this.onChanged});
  final TextEditingController controller;
  final FocusNode focus;
  final bool enabled;
  final bool invalid;
  final VoidCallback onComplete;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return Stack(children: [
      ExcludeSemantics(
        child: ListenableBuilder(
          listenable: Listenable.merge([controller, focus]),
          builder: (context, _) {
            final text = controller.text;
            return Row(
              children: List.generate(6, (i) {
                final active = focus.hasFocus && (i == text.length || (i == 5 && text.length == 6));
                return Expanded(
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 160),
                    height: 60,
                    margin: EdgeInsets.only(right: i < 5 ? 8 : 0),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: p.surface,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: invalid ? p.danger : (active ? p.brand : p.border), width: active || invalid ? 2 : 1.2),
                    ),
                    child: Text(i < text.length ? text[i] : '', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: p.text)),
                  ),
                );
              }),
            );
          },
        ),
      ),
      Positioned.fill(
        child: TextField(
          controller: controller,
          focusNode: focus,
          enabled: enabled,
          autofocus: true,
          showCursor: false,
          style: const TextStyle(color: Colors.transparent),
          keyboardType: TextInputType.number,
          autofillHints: const [AutofillHints.oneTimeCode],
          maxLength: 6,
          decoration: const InputDecoration(
            filled: false, border: InputBorder.none, enabledBorder: InputBorder.none,
            focusedBorder: InputBorder.none, disabledBorder: InputBorder.none, counterText: '',
          ),
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          onChanged: (v) {
            onChanged();
            if (v.length == 6) onComplete();
          },
        ),
      ),
    ]);
  }
}

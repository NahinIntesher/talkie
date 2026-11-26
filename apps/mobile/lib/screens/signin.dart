import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import '../core/api.dart';
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
  _Step step = _Step.email;
  final email = TextEditingController();
  final code = TextEditingController();
  final name = TextEditingController();
  final username = TextEditingController();
  final codeFocus = FocusNode();
  bool busy = false;
  String? error;
  String? challengeId;
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
    final value = email.text.trim().toLowerCase();
    if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(value)) {
      setState(() => error = t('সঠিক ইমেইল দিন', 'Enter a valid email'));
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = await api.post('/auth/otp/request', {'email': value, 'locale': prefs.locale});
      challengeId = result['challengeId'] as String;
      resendAfter = (result['resendAfterSeconds'] as num).toInt();
      sentAt = DateTime.now();
      code.clear();
      ticker?.cancel();
      ticker = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
      setState(() => step = _Step.code);
      Future.delayed(const Duration(milliseconds: 350), () => codeFocus.requestFocus());
    } catch (err) {
      setState(() => error = _message(err));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> verify() async {
    if (busy || code.text.length != 6) return;
    final session = context.read<Session>();
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = await api.post('/auth/otp/verify', {'challengeId': challengeId, 'code': code.text, 'device': session.deviceInfo()}) as Map<String, dynamic>;
      if (result['status'] == 'signed_in') {
        await session.signedIn(result);
        return;
      }
      signupToken = result['signupToken'] as String;
      setState(() => step = _Step.profile);
    } catch (err) {
      code.clear();
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
        'device': session.deviceInfo(),
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
            onPressed: () => setState(() {
              step = _Step.email;
              error = null;
            }),
            style: TextButton.styleFrom(foregroundColor: p.muted, padding: const EdgeInsets.symmetric(horizontal: 8)),
            icon: const Icon(LucideIcons.arrowLeft, size: 18),
            label: Text(email.text.trim().toLowerCase(), style: const TextStyle(fontWeight: FontWeight.w700)),
          ),
          const SizedBox(height: 12),
          Text(t('কোডটি লিখুন', 'Enter the code'), style: title),
          const SizedBox(height: 28),
          _OtpField(controller: code, focus: codeFocus, enabled: !busy, invalid: error != null, onComplete: verify, onChanged: () => setState(() => error = null)),
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

/// Six boxes over one hidden field, so paste and SMS-style autofill both work.
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
      Opacity(
        opacity: 0,
        child: TextField(
          controller: controller,
          focusNode: focus,
          enabled: enabled,
          keyboardType: TextInputType.number,
          autofillHints: const [AutofillHints.oneTimeCode],
          maxLength: 6,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          onChanged: (v) {
            onChanged();
            if (v.length == 6) onComplete();
          },
        ),
      ),
      GestureDetector(
        onTap: () => focus.requestFocus(),
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
    ]);
  }
}

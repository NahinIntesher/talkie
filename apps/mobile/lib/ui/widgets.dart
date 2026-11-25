import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/config.dart';
import 'theme.dart';

/// Talkie's mark: a speech bubble with a voice wave, on the brand gradient.
class LogoMark extends StatelessWidget {
  const LogoMark({super.key, this.size = 40});
  final double size;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(gradient: p.gradient, borderRadius: BorderRadius.circular(size * 0.28)),
      child: Center(
        child: Container(
          width: size * 0.5,
          height: size * 0.38,
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(size * 0.09)),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [0.5, 1.0, 0.4].map((h) => Container(width: size * 0.05, height: size * 0.2 * h, margin: EdgeInsets.symmetric(horizontal: size * 0.02), decoration: BoxDecoration(color: p.brand2, borderRadius: BorderRadius.circular(9)))).toList(),
          ),
        ),
      ),
    );
  }
}

const _tones = [
  [Color(0xFF6366F1), Color(0xFF8B5CF6)],
  [Color(0xFFD946EF), Color(0xFFEC4899)],
  [Color(0xFF0EA5E9), Color(0xFF6366F1)],
  [Color(0xFF10B981), Color(0xFF14B8A6)],
  [Color(0xFFF59E0B), Color(0xFFF97316)],
  [Color(0xFFF43F5E), Color(0xFFEF4444)],
];

class Avatar extends StatelessWidget {
  const Avatar({super.key, required this.name, this.url, this.size = 44, this.group = false});
  final String name;
  final String? url;
  final double size;
  final bool group;
  @override
  Widget build(BuildContext context) {
    if (url != null) {
      return ClipOval(child: CachedNetworkImage(imageUrl: Config.asset(url!), width: size, height: size, fit: BoxFit.cover, errorWidget: (_, _, _) => _initials()));
    }
    return _initials();
  }

  Widget _initials() {
    final tone = _tones[name.runes.fold<int>(0, (a, b) => a + b) % _tones.length];
    final initials = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).take(2).map((p) => String.fromCharCode(p.runes.first).toUpperCase()).join();
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(shape: BoxShape.circle, gradient: LinearGradient(colors: tone, begin: Alignment.topLeft, end: Alignment.bottomRight)),
      alignment: Alignment.center,
      child: group ? Icon(Icons.groups_rounded, color: Colors.white, size: size * 0.5) : Text(initials.isEmpty ? '?' : initials, style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: size * 0.38)),
    );
  }
}

/// The main call-to-action button with the brand gradient.
class GradientButton extends StatelessWidget {
  const GradientButton({super.key, required this.label, this.onPressed, this.loading = false, this.icon});
  final String label;
  final VoidCallback? onPressed;
  final bool loading;
  final IconData? icon;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final enabled = onPressed != null && !loading;
    return AnimatedOpacity(
      duration: const Duration(milliseconds: 200),
      opacity: enabled ? 1 : 0.55,
      child: DecoratedBox(
        decoration: BoxDecoration(gradient: p.gradient, borderRadius: BorderRadius.circular(18), boxShadow: [if (enabled) BoxShadow(color: p.brand.withValues(alpha: 0.35), blurRadius: 24, offset: const Offset(0, 10))]),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(18),
            onTap: enabled
                ? () {
                    HapticFeedback.lightImpact();
                    onPressed!();
                  }
                : null,
            child: SizedBox(
              height: 54,
              child: Center(
                child: loading
                    ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white))
                    : Row(mainAxisSize: MainAxisSize.min, children: [
                        Text(label, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 16)),
                        if (icon != null) ...[const SizedBox(width: 8), Icon(icon, color: Colors.white, size: 20)],
                      ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

void showMessage(BuildContext context, String text, {bool error = false}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(text), backgroundColor: error ? context.palette.danger : null));
}

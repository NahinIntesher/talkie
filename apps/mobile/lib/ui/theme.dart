import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// The same palette as the web app (apps/web/app/globals.css). Brand colour: Talkie gold.
/// [brand] is the text/icon shade (deep gold on light, bright gold on dark); [gradient] is the bright gold fill,
/// which always carries [onBrand] (dark) text. Own message bubbles use [bubbleOut] with [bubbleOutText].
class Palette {
  const Palette({
    required this.bg,
    required this.surface,
    required this.surface2,
    required this.surface3,
    required this.border,
    required this.text,
    required this.muted,
    required this.subtle,
    required this.brand,
    required this.brand2,
    required this.accent,
    required this.brandSoft,
    required this.success,
    required this.danger,
    required this.bubbleOut,
    required this.bubbleOutText,
    required this.wallpaper,
  });

  final Color bg, surface, surface2, surface3, border, text, muted, subtle, brand, brand2, accent, brandSoft, success, danger, bubbleOut, bubbleOutText, wallpaper;

  /// Text and icons on the gold gradient fills.
  static const onBrand = Color(0xFF1F1300);
  static const fill = [Color(0xFFFCC93A), Color(0xFFF59E0B), Color(0xFFE08A0B)];

  static const light = Palette(
    bg: Color(0xFFF6F7FB),
    surface: Color(0xFFFFFFFF),
    surface2: Color(0xFFF1F3F9),
    surface3: Color(0xFFE7EAF3),
    border: Color(0xFFE3E6EF),
    text: Color(0xFF0E1222),
    muted: Color(0xFF4A5170),
    subtle: Color(0xFF737A96),
    brand: Color(0xFFB45309),
    brand2: Color(0xFFD97706),
    accent: Color(0xFFEA580C),
    brandSoft: Color(0xFFFEF3C7),
    success: Color(0xFF12A150),
    danger: Color(0xFFDC2645),
    bubbleOut: Color(0xFFFBBF24),
    bubbleOutText: Color(0xFF2A1700),
    wallpaper: Color(0xFFECEEF6),
  );

  static const dark = Palette(
    bg: Color(0xFF080A14),
    surface: Color(0xFF10131F),
    surface2: Color(0xFF161A29),
    surface3: Color(0xFF1E2335),
    border: Color(0xFF232840),
    text: Color(0xFFEEF0F8),
    muted: Color(0xFFA9B0CC),
    subtle: Color(0xFF7F87A6),
    brand: Color(0xFFFBBF24),
    brand2: Color(0xFFF59E0B),
    accent: Color(0xFFFB923C),
    brandSoft: Color(0xFF2B2110),
    success: Color(0xFF34D27B),
    danger: Color(0xFFFF5C7A),
    bubbleOut: Color(0xFFB45309),
    bubbleOutText: Color(0xFFFFFFFF),
    wallpaper: Color(0xFF0B0E19),
  );

  LinearGradient get gradient => const LinearGradient(colors: fill, stops: [0, 0.55, 1.1], begin: Alignment.topLeft, end: Alignment.bottomRight);
}

extension PaletteOf on BuildContext {
  Palette get palette => Theme.of(this).brightness == Brightness.dark ? Palette.dark : Palette.light;
}

/// English text in Quicksand, Bangla in Baloo Da 2: Quicksand has no Bangla letters, so they fall through to Baloo.
ThemeData buildTheme(Brightness brightness, {required bool bangla}) {
  final p = brightness == Brightness.dark ? Palette.dark : Palette.light;
  final primary = GoogleFonts.quicksand().fontFamily!;
  final fallback = [GoogleFonts.balooDa2().fontFamily!];
  final base = ThemeData(brightness: brightness, useMaterial3: true, fontFamily: primary, fontFamilyFallback: fallback);
  final text = base.textTheme.apply(bodyColor: p.text, displayColor: p.text, fontFamily: primary, fontFamilyFallback: fallback);
  return base.copyWith(
    scaffoldBackgroundColor: p.bg,
    colorScheme: ColorScheme.fromSeed(seedColor: p.brand, brightness: brightness).copyWith(primary: p.brand, surface: p.surface, error: p.danger),
    textTheme: text.copyWith(
      headlineMedium: text.headlineMedium?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.5),
      titleLarge: text.titleLarge?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.3),
      titleMedium: text.titleMedium?.copyWith(fontWeight: FontWeight.w700),
      bodyMedium: text.bodyMedium?.copyWith(fontSize: 15, fontWeight: FontWeight.w500),
    ),
    appBarTheme: AppBarTheme(backgroundColor: p.surface, foregroundColor: p.text, elevation: 0, scrolledUnderElevation: 0, centerTitle: false, titleTextStyle: text.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
    dividerTheme: DividerThemeData(color: p.border, thickness: 1, space: 1),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.surface2,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide.none),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide(color: p.brand, width: 2)),
      errorBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide(color: p.danger, width: 1.5)),
      hintStyle: TextStyle(color: p.subtle, fontWeight: FontWeight.w500),
    ),
    snackBarTheme: SnackBarThemeData(behavior: SnackBarBehavior.floating, backgroundColor: p.text, contentTextStyle: TextStyle(color: p.bg, fontWeight: FontWeight.w600), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14))),
    bottomSheetTheme: BottomSheetThemeData(backgroundColor: p.surface, showDragHandle: true, shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(28)))),
    dialogTheme: DialogThemeData(backgroundColor: p.surface, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(26))),
    pageTransitionsTheme: const PageTransitionsTheme(builders: {TargetPlatform.android: PredictiveBackPageTransitionsBuilder()}),
  );
}

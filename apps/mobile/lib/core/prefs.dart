import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Language and theme, remembered on the phone.
class Prefs extends ChangeNotifier {
  static const _storage = FlutterSecureStorage();
  String locale = 'bn';
  ThemeMode theme = ThemeMode.system;

  bool get bn => locale == 'bn';

  Future<void> load() async {
    locale = await _storage.read(key: 'talkie.locale') ?? 'bn';
    final stored = await _storage.read(key: 'talkie.theme');
    theme = ThemeMode.values.firstWhere((m) => m.name == stored, orElse: () => ThemeMode.system);
  }

  Future<void> setLocale(String value) async {
    locale = value;
    notifyListeners();
    await _storage.write(key: 'talkie.locale', value: value);
  }

  Future<void> setTheme(ThemeMode value) async {
    theme = value;
    notifyListeners();
    await _storage.write(key: 'talkie.theme', value: value.name);
  }

  /// Picks the Bangla or English text.
  String t(String bn, String en) => this.bn ? bn : en;
}

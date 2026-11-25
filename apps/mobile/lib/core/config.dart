/// Where the app talks to. Release builds use the public site; development builds pass
/// `--dart-define=TALKIE_ORIGIN=http://127.0.0.1:3000` (with `adb reverse tcp:3000 tcp:3000`).
class Config {
  static const origin = String.fromEnvironment('TALKIE_ORIGIN', defaultValue: 'https://talkie.kodofact.com');

  /// The realtime service. In production it is served by the same origin under /ws.
  static const realtimeUrl = String.fromEnvironment('TALKIE_REALTIME', defaultValue: origin);

  static String api(String path) => '$origin/api$path';
  static String asset(String pathOrUrl) => pathOrUrl.startsWith('http') ? pathOrUrl : '$origin$pathOrUrl';
}

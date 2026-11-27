import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talkie/core/chat_bubbles.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    messenger.setMockMethodCallHandler(bubbleChannel, null);
  });

  test('unavailable Android bubble features leave the fallback available', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    expect(await bubbleStatus('1001'), (
      supported: false, enabled: false, notifications: false, allowed: false,
    ));
  });

  test('enabling bubbles is explicit and scoped to the signed-in device', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    final calls = <MethodCall>[];
    messenger.setMockMethodCallHandler(bubbleChannel, (call) async {
      calls.add(call);
      return switch (call.method) {
        'status' => {'supported': true, 'enabled': false, 'notifications': true, 'allowed': false},
        _ => null,
      };
    });
    final state = await bubbleStatus('1001');
    expect(state.supported, isTrue);
    expect(state.allowed, isFalse);
    expect(calls.map((call) => call.method), ['status']);
    await setChatBubbles(null, true);
    await setChatBubbles('wrong-device', true);
    await setChatBubbles('1001', true);
    expect(calls.map((call) => call.method), ['status', 'enable']);
    expect(calls.last.arguments, {'device': '1001'});
  });
}

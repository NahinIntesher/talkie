import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

typedef BubbleStatus = ({
  bool supported,
  bool enabled,
  bool notifications,
  bool allowed,
});

const bubbleChannel = MethodChannel('talkie/bubbles');
final _idPattern = RegExp(r'^[1-9][0-9]{0,19}$');

bool validBubbleId(String? id) => id != null && _idPattern.hasMatch(id);
bool get bubblePlatform =>
    !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

Future<BubbleStatus> bubbleStatus(String? device) async {
  final values = bubblePlatform
      ? await bubbleChannel
            .invokeMapMethod<String, bool>('status', {'device': device})
            .catchError((Object _) => null)
      : null;
  return (
    supported: values?['supported'] == true,
    enabled: values?['enabled'] == true,
    notifications: values?['notifications'] == true,
    allowed: values?['allowed'] == true,
  );
}

Future<void> setChatBubbles(String? device, bool enable) async {
  if (bubblePlatform && validBubbleId(device)) {
    await bubbleChannel.invokeMethod<void>(enable ? 'enable' : 'disable', {
      'device': device,
    });
  }
}

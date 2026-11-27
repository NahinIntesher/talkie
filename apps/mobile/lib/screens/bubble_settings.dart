import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:provider/provider.dart';

import '../core/chat_bubbles.dart';
import '../core/prefs.dart';
import '../core/session.dart';
import '../ui/widgets.dart';

Future<bool> enableBubbles(BuildContext context, String? device) async {
  final t = context.read<Prefs>().t;
  final status = await bubbleStatus(device);
  if (!status.supported || !context.mounted) return false;
  try {
    if (!status.notifications &&
        !(await Permission.notification.request()).isGranted) {
      if (!context.mounted) return false;
      await _settingsDialog(
        context,
        t('নোটিফিকেশনের অনুমতি দিন', 'Allow notifications'),
        t(
          'চ্যাট বাবলের জন্য Talkie-এর নোটিফিকেশন চালু করুন।',
          'Allow Talkie notifications to use chat bubbles.',
        ),
        openAppSettings,
      );
      return false;
    }
    if (!context.mounted) return false;
    await setChatBubbles(device, true);
    if (!context.mounted) return false;
    if (status.allowed) return true;
    await _settingsDialog(
      context,
      t('চ্যাট বাবল চালু করুন', 'Allow chat bubbles'),
      t(
        'Android সেটিংসে Talkie-এর জন্য সব কথোপকথন অথবা বেছে নেওয়া কথোপকথন অনুমোদন করুন।',
        'In Android settings, allow bubbles for all Talkie conversations or choose individual conversations.',
      ),
      () => bubbleChannel.invokeMethod<void>('settings'),
    );
    return false;
  } catch (_) {
    if (context.mounted) {
      showMessage(
        context,
        t('চ্যাট বাবল চালু করা যায়নি।', 'Could not enable chat bubbles.'),
        error: true,
      );
    }
    return false;
  }
}

Future<void> _settingsDialog(
  BuildContext context,
  String title,
  String description,
  Future<dynamic> Function() settings,
) async {
  final t = context.read<Prefs>().t;
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialog) => AlertDialog(
      title: Text(title),
      content: Text(description),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(dialog),
          child: Text(t('পরে', 'Later')),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(dialog, true),
          child: Text(t('Android সেটিংস', 'Android settings')),
        ),
      ],
    ),
  );
  if (confirmed == true && context.mounted) await settings();
}

class BubbleSettingsRow extends StatefulWidget {
  const BubbleSettingsRow({super.key});

  @override
  State<BubbleSettingsRow> createState() => _BubbleSettingsRowState();
}

class _BubbleSettingsRowState extends State<BubbleSettingsRow>
    with WidgetsBindingObserver {
  BubbleStatus? _status;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  Future<void> _refresh() async {
    final status = await bubbleStatus(context.read<Session>().deviceId);
    if (mounted) setState(() => _status = status);
  }

  @override
  Widget build(BuildContext context) {
    final status = _status;
    if (status == null || !status.supported) return const SizedBox.shrink();
    final t = context.watch<Prefs>().t;
    final ready = status.notifications && status.allowed;
    return Column(
      children: [
        SwitchListTile(
          secondary: const Icon(LucideIcons.messageCircle),
          title: Text(t('চ্যাট বাবল', 'Chat bubbles')),
          subtitle: Text(
            ready
                ? t(
                    'ভাসমান বাবল থেকে চ্যাট করুন',
                    'Message from a floating bubble',
                  )
                : t(
                    'চ্যাট বাবলের জন্য Android অনুমতি দিন',
                    'Allow chat bubbles in Android settings',
                  ),
          ),
          value: status.enabled,
          onChanged: _busy
              ? null
              : (enabled) async {
                  setState(() => _busy = true);
                  try {
                    final device = context.read<Session>().deviceId;
                    if (enabled) {
                      await enableBubbles(context, device);
                    } else {
                      await setChatBubbles(device, false);
                    }
                  } catch (_) {
                    if (context.mounted) {
                      showMessage(
                        context,
                        t(
                          'সেটিংস বদলানো যায়নি।',
                          'Could not update bubble settings.',
                        ),
                        error: true,
                      );
                    }
                  } finally {
                    if (mounted) {
                      setState(() => _busy = false);
                      await _refresh();
                    }
                  }
                },
        ),
        if (status.enabled && !ready)
          ListTile(
            leading: const Icon(Icons.settings_outlined),
            title: Text(t('Android সেটিংস খুলুন', 'Open Android settings')),
            onTap: () =>
                enableBubbles(context, context.read<Session>().deviceId),
          ),
      ],
    );
  }
}

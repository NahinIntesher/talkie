import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mime/mime.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:provider/provider.dart';

import '../chat/chat.dart';
import '../chat/history.dart';
import '../chat/media.dart';
import '../chat/models.dart';
import '../core/api.dart';
import '../core/prefs.dart';
import '../core/session.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.watch<Session>();
    final prefs = context.watch<Prefs>();
    final p = context.palette;
    final t = prefs.t;
    final user = session.user ?? {};
    final name = user['displayName'] as String? ?? '';
    return Scaffold(
      appBar: AppBar(title: Text(t('সেটিংস', 'Settings')), titleSpacing: 20),
      body: ListView(padding: const EdgeInsets.only(bottom: 32), children: [
        InkWell(
          onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const ProfileScreen())),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
            child: Row(children: [
              Avatar(name: name, url: user['avatarUrl'] as String?, size: 68),
              const SizedBox(width: 16),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(name, style: Theme.of(context).textTheme.titleLarge),
                  Text('@${user['username'] ?? ''}', style: TextStyle(color: p.subtle, fontWeight: FontWeight.w600)),
                ]),
              ),
              Icon(LucideIcons.chevronRight, color: p.subtle),
            ]),
          ),
        ),
        _Section(children: [
          _Row(
            icon: LucideIcons.palette,
            label: t('থিম', 'Theme'),
            value: switch (prefs.theme) { ThemeMode.light => t('লাইট', 'Light'), ThemeMode.dark => t('ডার্ক', 'Dark'), _ => t('সিস্টেম', 'System') },
            onTap: () => _choose<ThemeMode>(context, t('থিম', 'Theme'), prefs.theme, {ThemeMode.system: t('সিস্টেম', 'System'), ThemeMode.light: t('লাইট', 'Light'), ThemeMode.dark: t('ডার্ক', 'Dark')}, prefs.setTheme),
          ),
          _Row(
            icon: LucideIcons.languages,
            label: t('ভাষা', 'Language'),
            value: prefs.bn ? 'বাংলা' : 'English',
            onTap: () => _choose<String>(context, t('ভাষা', 'Language'), prefs.locale, {'bn': 'বাংলা', 'en': 'English'}, (v) {
              prefs.setLocale(v);
              api.patch('/users/me', {'locale': v}).catchError((_) => null);
            }),
          ),
        ]),
        _Section(children: [
          _Row(icon: LucideIcons.shieldCheck, label: t('প্রাইভেসি', 'Privacy'), onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const PrivacyScreen()))),
          _Row(icon: LucideIcons.monitorSmartphone, label: t('ডিভাইস', 'Devices'), onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const DevicesScreen()))),
          _Row(icon: LucideIcons.bell, label: t('নোটিফিকেশন সেটিংস', 'Notification settings'), onTap: () => openAppSettings()),
        ]),
        _Section(children: [
          _Row(
            icon: LucideIcons.logOut,
            label: t('সাইন আউট', 'Sign out'),
            danger: true,
            onTap: () async {
              final ok = await showDialog<bool>(
                context: context,
                builder: (d) => AlertDialog(
                  title: Text(t('সাইন আউট করবেন?', 'Sign out?')),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(d), child: Text(t('বাতিল', 'Cancel'))),
                    TextButton(onPressed: () => Navigator.pop(d, true), child: Text(t('সাইন আউট', 'Sign out'), style: TextStyle(color: p.danger))),
                  ],
                ),
              );
              if (ok == true) {
                try {
                  await session.signOut();
                } catch (_) {
                  if (context.mounted) showMessage(context, t('সাইন আউট করতে আবার সংযোগ করুন।', 'Reconnect to finish signing out.'), error: true);
                }
              }
            },
          ),
        ]),
      ]),
    );
  }

  static void _choose<T>(BuildContext context, String title, T current, Map<T, String> options, void Function(T) onPick) {
    showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: RadioGroup<T>(
          groupValue: current,
          onChanged: (v) {
            Navigator.pop(sheet);
            if (v != null) onPick(v);
          },
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(title, style: Theme.of(sheet).textTheme.titleLarge)),
            for (final e in options.entries) RadioListTile<T>(value: e.key, title: Text(e.value, style: const TextStyle(fontWeight: FontWeight.w700))),
          ]),
        ),
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 14),
      decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(20), border: Border.all(color: p.border)),
      clipBehavior: Clip.antiAlias,
      child: Column(children: [
        for (var i = 0; i < children.length; i++) ...[if (i > 0) Divider(indent: 56, color: p.border), children[i]],
      ]),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.icon, required this.label, this.value, this.onTap, this.danger = false});
  final IconData icon;
  final String label;
  final String? value;
  final VoidCallback? onTap;
  final bool danger;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final color = danger ? p.danger : p.text;
    return ListTile(
      onTap: onTap,
      leading: Container(
        width: 34,
        height: 34,
        decoration: BoxDecoration(color: danger ? p.danger.withValues(alpha: 0.12) : p.brandSoft, borderRadius: BorderRadius.circular(10)),
        child: Icon(icon, size: 18, color: danger ? p.danger : p.brand),
      ),
      title: Text(label, style: TextStyle(fontWeight: FontWeight.w700, color: color)),
      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
        if (value != null) Text(value!, style: TextStyle(color: p.subtle, fontWeight: FontWeight.w600)),
        if (!danger) Icon(LucideIcons.chevronRight, size: 18, color: p.subtle),
      ]),
    );
  }
}

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});
  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late final session = context.read<Session>();
  late final name = TextEditingController(text: session.user?['displayName'] as String? ?? '');
  late final about = TextEditingController(text: session.user?['about'] as String? ?? '');
  bool saving = false;
  bool uploading = false;

  @override
  void dispose() {
    name.dispose();
    about.dispose();
    super.dispose();
  }

  String t(String bn, String en) => context.read<Prefs>().t(bn, en);

  Future<void> save() async {
    if (name.text.trim().isEmpty) return;
    setState(() => saving = true);
    try {
      final result = await api.patch('/users/me', {'displayName': name.text.trim(), 'about': about.text.trim()});
      session.updateUser(result['profile'] as Json);
      if (mounted) {
        showMessage(context, t('সংরক্ষিত', 'Saved'));
        Navigator.pop(context);
      }
    } catch (err) {
      if (mounted) showMessage(context, '$err', error: true);
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  Future<void> changePhoto() async {
    final picked = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 1024, maxHeight: 1024, imageQuality: 90);
    if (picked == null) return;
    setState(() => uploading = true);
    try {
      final bytes = await picked.readAsBytes();
      final mediaId = await Media.uploadPhoto(bytes, 'avatar', lookupMimeType(picked.path) ?? 'image/jpeg');
      final result = await api.put('/users/me/avatar', {'mediaId': mediaId});
      session.updateUser({'avatarUrl': result['avatarUrl']});
    } catch (err) {
      if (mounted) showMessage(context, '$err', error: true);
    } finally {
      if (mounted) setState(() => uploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = context.watch<Session>().user ?? {};
    final p = context.palette;
    return Scaffold(
      appBar: AppBar(title: Text(t('প্রোফাইল', 'Profile'))),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        Center(
          child: GestureDetector(
            onTap: uploading ? null : changePhoto,
            child: Stack(children: [
              Avatar(name: user['displayName'] as String? ?? '', url: user['avatarUrl'] as String?, size: 120),
              Positioned(
                right: 2,
                bottom: 2,
                child: Container(
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(gradient: p.gradient, shape: BoxShape.circle, border: Border.all(color: p.bg, width: 3)),
                  child: uploading ? const Padding(padding: EdgeInsets.all(9), child: CircularProgressIndicator(strokeWidth: 2, color: Palette.onBrand)) : const Icon(LucideIcons.camera, size: 17, color: Palette.onBrand),
                ),
              ),
            ]),
          ),
        ),
        const SizedBox(height: 28),
        TextField(controller: name, maxLength: 64, decoration: InputDecoration(hintText: t('নাম', 'Name'), counterText: '', prefixIcon: const Icon(LucideIcons.user, size: 20))),
        const SizedBox(height: 12),
        TextField(controller: about, maxLength: 140, maxLines: 3, minLines: 1, decoration: InputDecoration(hintText: t('সম্পর্কে', 'About'), counterText: '', prefixIcon: const Icon(LucideIcons.info, size: 20))),
        const SizedBox(height: 12),
        ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 4),
          leading: Icon(LucideIcons.atSign, color: p.muted),
          title: Text('${user['username'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w700)),
        ),
        ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 4),
          leading: Icon(LucideIcons.mail, color: p.muted),
          title: Text('${user['email'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w700)),
        ),
        const SizedBox(height: 20),
        GradientButton(label: t('সংরক্ষণ', 'Save'), loading: saving, onPressed: save),
      ]),
    );
  }
}

class PrivacyScreen extends StatefulWidget {
  const PrivacyScreen({super.key});
  @override
  State<PrivacyScreen> createState() => _PrivacyScreenState();
}

class _PrivacyScreenState extends State<PrivacyScreen> {
  Map<String, String>? privacy;
  bool readReceipts = true;

  @override
  void initState() {
    super.initState();
    api.get('/users/me').then((r) {
      if (!mounted) return;
      setState(() {
        privacy = Map<String, String>.from(r['privacy'] as Map);
        readReceipts = r['readReceipts'] != false;
      });
    }).catchError((_) {});
  }

  Future<void> update(Json body) async {
    try {
      await api.put('/users/me/privacy', body);
    } catch (err) {
      if (mounted) showMessage(context, '$err', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.watch<Prefs>().t;
    final p = context.palette;
    final labels = {
      'last_seen': t('শেষ দেখা', 'Last seen'),
      'online': t('অনলাইন', 'Online'),
      'profile_photo': t('প্রোফাইল ছবি', 'Profile photo'),
      'about': t('সম্পর্কে', 'About'),
      'status': t('স্ট্যাটাস', 'Status'),
      'groups_add': t('গ্রুপে যোগ করা', 'Groups'),
    };
    final audiences = {'everyone': t('সবাই', 'Everyone'), 'contacts': t('কন্টাক্ট', 'Contacts'), 'nobody': t('কেউ না', 'Nobody')};
    return Scaffold(
      appBar: AppBar(title: Text(t('প্রাইভেসি', 'Privacy'))),
      body: privacy == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(children: [
              for (final e in labels.entries)
                ListTile(
                  title: Text(e.value, style: const TextStyle(fontWeight: FontWeight.w700)),
                  trailing: Text(audiences[privacy![e.key]] ?? '', style: TextStyle(color: p.brand, fontWeight: FontWeight.w700)),
                  onTap: () => SettingsScreen._choose<String>(context, e.value, privacy![e.key] ?? 'everyone', audiences, (v) {
                    setState(() => privacy![e.key] = v);
                    update({'settings': [{'key': e.key, 'audience': v}]});
                  }),
                ),
              SwitchListTile(
                value: readReceipts,
                activeThumbColor: p.brand,
                title: Text(t('পড়ার রসিদ', 'Read receipts'), style: const TextStyle(fontWeight: FontWeight.w700)),
                onChanged: (v) {
                  setState(() => readReceipts = v);
                  update({'readReceipts': v});
                },
              ),
            ]),
    );
  }
}

class DevicesScreen extends StatefulWidget {
  const DevicesScreen({super.key});
  @override
  State<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends State<DevicesScreen> {
  List<Json>? devices;
  List<Json> historyRequests = [];
  bool historyPending = false;
  bool transferring = false;

  Future<void> _requestHistory() async {
    try {
      await api.post('/chat/history/requests');
      if (mounted) setState(() => historyPending = true);
    } catch (error) {
      if (mounted) showMessage(context, '$error', error: true);
    }
  }

  Future<void> _transfer() async {
    final t = context.read<Prefs>().t;
    final chat = context.read<Chat>();
    var code = '';
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(t('চ্যাট ইতিহাস পাঠান', 'Send chat history')),
        content: TextField(
          onChanged: (value) => code = value,
          autocorrect: false,
          enableSuggestions: false,
          decoration: InputDecoration(labelText: t('অন্য ডিভাইসের কোড', 'Other device’s code')),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog), child: Text(t('বাতিল', 'Cancel'))),
          FilledButton(onPressed: () => Navigator.pop(dialog, true), child: Text(t('পাঠান', 'Send'))),
        ],
      ),
    );
    if (!mounted || confirmed != true || code.trim().isEmpty) return;
    await _sendHistory(chat, code);
  }

  Future<void> _sendHistory(Chat chat, String code) async {
    final t = context.read<Prefs>().t;
    setState(() => transferring = true);
    try {
      final result = await transferHistory(chat, code);
      if (!mounted) return;
      final prefs = context.read<Prefs>();
      final added = digits('${result.added}', prefs);
      final unreadable = digits('${result.unreadable}', prefs);
      showMessage(context, t('$addedটি বার্তার চাবি পাঠানো হয়েছে। $unreadableটি খোলা যায়নি।', 'Transferred $added message keys. $unreadable could not be opened.'));
      await _loadHistoryRequests();
    } catch (_) {
      if (mounted) showMessage(context, t('পাঠানো যায়নি। অন্য ডিভাইসের কোড যাচাই করে আবার চেষ্টা করুন।', 'Transfer failed. Check the code from your other device and try again.'), error: true);
    } finally {
      if (mounted) setState(() => transferring = false);
    }
  }

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final r = await api.get('/auth/devices');
      if (mounted) setState(() => devices = (r['devices'] as List).cast<Json>());
    } catch (_) {}
    await _loadHistoryRequests();
  }

  Future<void> _loadHistoryRequests() async {
    try {
      final result = await api.get('/chat/history/requests');
      if (mounted) {
        setState(() {
          historyRequests = (result['incoming'] as List).cast<Json>();
          historyPending = result['pending'] == true;
        });
      }
    } catch (_) {}
  }

  Future<void> _approveHistory(Json request, String deviceName) async {
    final t = context.read<Prefs>().t;
    final chat = context.read<Chat>();
    var code = '';
    final approved = await showDialog<bool>(context: context, builder: (dialog) => AlertDialog(
      title: Text(t('চ্যাট ইতিহাস পাঠাবেন?', 'Share encrypted history?')),
      content: TextField(
        onChanged: (value) => code = value,
        keyboardType: TextInputType.number,
        decoration: InputDecoration(labelText: t('নতুন ডিভাইসের কোড', 'New device’s code'), helperText: deviceName),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialog, false), child: Text(t('বাতিল', 'Cancel'))),
        FilledButton(onPressed: () => Navigator.pop(dialog, true), child: Text(t('অনুমোদন দিন', 'Approve'))),
      ],
    ));
    if (!mounted || approved != true) return;
    if (code.replaceAll(RegExp(r'\s'), '') != historyApprovalCode(request['identityKey'] as String)) {
      showMessage(context, t('যাচাই কোড মিলছে না।', 'The verification code does not match.'), error: true);
      return;
    }
    await _sendHistory(chat, '${request['deviceId']}.${request['identityKey']}');
  }

  Future<void> _signOutDevice(Json device) async {
    final t = context.read<Prefs>().t;
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(t('ডিভাইস থেকে সাইন আউট করবেন?', 'Sign out this device?')),
        content: Text(device['name'] as String),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog), child: Text(t('বাতিল', 'Cancel'))),
          FilledButton(onPressed: () => Navigator.pop(dialog, true), child: Text(t('সাইন আউট', 'Sign out'))),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      await api.delete('/auth/devices/${device['id']}');
      await load();
    } catch (error) {
      if (mounted) showMessage(context, '$error', error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final prefs = context.watch<Prefs>();
    final t = prefs.t;
    final p = context.palette;
    final ownKey = context.watch<Session>().keys?.publicKey;
    return Scaffold(
      appBar: AppBar(title: Text(t('ডিভাইস', 'Devices')), actions: [
        IconButton(tooltip: t('রিফ্রেশ করুন', 'Refresh'), onPressed: load, icon: const Icon(LucideIcons.refreshCw)),
      ]),
      body: devices == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(children: [
              Padding(padding: const EdgeInsets.all(16), child: Text(t('একসঙ্গে সর্বোচ্চ তিনটি ডিভাইস সক্রিয় থাকবে।', 'Up to three devices can stay signed in.'))),
              for (final d in devices!)
                ListTile(
                  leading: CircleAvatar(
                    backgroundColor: p.brandSoft,
                    child: Icon(d['platform'] == 'web' ? LucideIcons.monitor : LucideIcons.smartphone, color: p.brand, size: 20),
                  ),
                  title: Text(d['name'] as String? ?? '', style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: Text([
                    if (d['current'] == true) t('এই ডিভাইস', 'This device'),
                    switch (d['platform']) { 'android' => 'Android', 'ios' => 'iOS', 'web' => 'Web', _ => 'Desktop' },
                    '${t('সংযুক্ত', 'Linked')} ${listTime(DateTime.parse(d['createdAt'] as String).toLocal(), prefs)}',
                    '${t('সর্বশেষ সক্রিয়', 'Last active')} ${listTime(DateTime.parse(d['lastActiveAt'] as String).toLocal(), prefs)}',
                  ].join(' · '), style: TextStyle(color: d['current'] == true ? p.success : p.subtle, fontWeight: FontWeight.w600)),
                  trailing: d['current'] == true
                      ? null
                      : IconButton(
                          icon: Icon(LucideIcons.logOut, color: p.danger),
                          tooltip: t('এই ডিভাইস থেকে সাইন আউট', 'Sign out this device'),
                          onPressed: () => _signOutDevice(d),
                        ),
                ),
              if (transferring) const LinearProgressIndicator(),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 24, 20, 4),
                child: Text(t('এনক্রিপ্ট করা চ্যাট ইতিহাস', 'Encrypted chat history'), style: Theme.of(context).textTheme.titleMedium),
              ),
              ListTile(
                leading: const Icon(LucideIcons.history),
                title: Text(t('পুরোনো চ্যাট ফিরিয়ে আনুন', 'Restore chat history')),
                subtitle: Text(historyPending ? t('চেনা পুরোনো ডিভাইসে এই অনুরোধ অনুমোদন দিন।', 'Approve this request on a trusted older device.') : t('পুরোনো ডিভাইসে অনুমোদনের অনুরোধ পাঠান।', 'Request approval from an older device.')),
                onTap: transferring || historyPending ? null : _requestHistory,
              ),
              if (historyPending && ownKey != null)
                Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 8), child: SelectableText('${t('এই ডিভাইসের যাচাই কোড', 'This device’s verification code')} ${historyApprovalCode(ownKey)}')),
              for (final request in historyRequests)
                if (devices!.where((d) => d['id'] == request['deviceId']).firstOrNull case final device?)
                  ListTile(
                    leading: const Icon(LucideIcons.shieldCheck),
                    title: Text(t('চ্যাট ইতিহাসের অনুরোধ', 'History restore request')),
                    subtitle: Text(device['name'] as String),
                    onTap: transferring ? null : () => _approveHistory(request, device['name'] as String),
                  ),
              ListTile(
                leading: const Icon(LucideIcons.copy),
                title: Text(t('এই ডিভাইসের কোড কপি করুন', 'Copy this device’s code')),
                onTap: () async {
                  final code = historyTransferCode(context.read<Session>());
                  if (code == null) return;
                  await Clipboard.setData(ClipboardData(text: code));
                  if (context.mounted) showMessage(context, t('এই ডিভাইসের কোড কপি হয়েছে', 'Device code copied'));
                },
              ),
              ListTile(
                leading: const Icon(LucideIcons.send),
                title: Text(t('চ্যাট ইতিহাস পাঠান', 'Send chat history')),
                enabled: !transferring,
                onTap: transferring ? null : _transfer,
              ),
            ]),
    );
  }
}

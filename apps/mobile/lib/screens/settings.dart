import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mime/mime.dart';
import 'package:provider/provider.dart';

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
              if (ok == true) await session.signOut();
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
  }

  @override
  Widget build(BuildContext context) {
    final prefs = context.watch<Prefs>();
    final t = prefs.t;
    final p = context.palette;
    return Scaffold(
      appBar: AppBar(title: Text(t('ডিভাইস', 'Devices'))),
      body: devices == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(children: [
              for (final d in devices!)
                ListTile(
                  leading: CircleAvatar(
                    backgroundColor: p.brandSoft,
                    child: Icon(d['platform'] == 'web' ? LucideIcons.monitor : LucideIcons.smartphone, color: p.brand, size: 20),
                  ),
                  title: Text(d['name'] as String? ?? '', style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: Text(d['current'] == true ? t('এই ডিভাইস', 'This device') : listTime(DateTime.parse(d['lastActiveAt'] as String).toLocal(), prefs), style: TextStyle(color: d['current'] == true ? p.success : p.subtle, fontWeight: FontWeight.w600)),
                  trailing: d['current'] == true
                      ? null
                      : IconButton(
                          icon: Icon(LucideIcons.logOut, color: p.danger),
                          onPressed: () async {
                            try {
                              await api.delete('/auth/devices/${d['id']}');
                              await load();
                            } catch (err) {
                              if (context.mounted) showMessage(context, '$err', error: true);
                            }
                          },
                        ),
                ),
            ]),
    );
  }
}

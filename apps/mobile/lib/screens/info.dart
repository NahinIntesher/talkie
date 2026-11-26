import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mime/mime.dart';
import 'package:provider/provider.dart';

import '../chat/chat.dart';
import '../chat/media.dart';
import '../chat/models.dart';
import '../core/api.dart';
import '../core/config.dart';
import '../core/prefs.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'new_chat.dart';

/// Contact info or group info: the same things the web's info panel offers.
class ConversationInfoScreen extends StatefulWidget {
  const ConversationInfoScreen({super.key, required this.conversationId});
  final String conversationId;
  @override
  State<ConversationInfoScreen> createState() => _ConversationInfoScreenState();
}

class _ConversationInfoScreenState extends State<ConversationInfoScreen> {
  late final Chat chat = context.read<Chat>();
  bool uploading = false;

  @override
  void initState() {
    super.initState();
    chat.reload(widget.conversationId);
    final peer = chat.conversations[widget.conversationId]?.peerId;
    if (peer != null) chat.refreshProfile(peer).catchError((_) => chat.profiles[peer]!);
  }

  String Function(String, String) get t => context.read<Prefs>().t;

  Future<void> _run(Future<void> Function() action) async {
    try {
      await action();
    } on ApiError catch (error) {
      if (mounted) showMessage(context, error.message, error: true);
    } catch (_) {
      if (mounted) showMessage(context, t('কিছু একটা সমস্যা হয়েছে।', 'Something went wrong.'), error: true);
    }
  }

  Future<bool> _confirm(String title, String action) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(title),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog), child: Text(t('বাতিল', 'Cancel'))),
          TextButton(onPressed: () => Navigator.pop(dialog, true), child: Text(action, style: TextStyle(color: context.palette.danger))),
        ],
      ),
    );
    return yes == true;
  }

  Future<void> _changeGroupPhoto() async {
    final picked = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 1024, maxHeight: 1024, imageQuality: 90);
    if (picked == null) return;
    setState(() => uploading = true);
    await _run(() async {
      final bytes = await picked.readAsBytes();
      final mediaId = await Media.uploadPhoto(bytes, 'group_avatar', lookupMimeType(picked.path) ?? 'image/jpeg');
      await chat.updateGroup(widget.conversationId, {'avatarMediaId': mediaId});
    });
    if (mounted) setState(() => uploading = false);
  }

  Future<void> _editGroup(Json group) async {
    final name = TextEditingController(text: group['name'] as String? ?? '');
    final description = TextEditingController(text: group['description'] as String? ?? '');
    final save = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(t('গ্রুপের তথ্য', 'Group info')),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: name, maxLength: 100, decoration: InputDecoration(labelText: t('গ্রুপের নাম', 'Group name'), counterText: '')),
          const SizedBox(height: 12),
          TextField(controller: description, maxLength: 2048, minLines: 2, maxLines: 5, decoration: InputDecoration(labelText: t('বিবরণ', 'Description'), counterText: '')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog), child: Text(t('বাতিল', 'Cancel'))),
          FilledButton(onPressed: () => Navigator.pop(dialog, true), child: Text(t('সংরক্ষণ করুন', 'Save'))),
        ],
      ),
    );
    if (save == true && name.text.trim().isNotEmpty) {
      await _run(() => chat.updateGroup(widget.conversationId, {'name': name.text.trim(), 'description': description.text.trim()}));
    }
    name.dispose();
    description.dispose();
  }

  Future<void> _safety(String peerId, String title) async {
    String? number;
    await _run(() async => number = await chat.safetyNumber(peerId));
    if (!mounted) return;
    if (number == null) return showMessage(context, t('মেসেজটি ডিক্রিপ্ট করা যায়নি।', 'Could not decrypt this message.'), error: true);
    final p = context.palette;
    await showDialog<void>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(t('এনক্রিপশন', 'Encryption')),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(LucideIcons.shieldCheck, size: 48, color: p.success),
          const SizedBox(height: 16),
          SelectableText(number!, textAlign: TextAlign.center, style: const TextStyle(fontFamily: 'monospace', fontSize: 18, height: 1.8, letterSpacing: 1.5)),
        ]),
        actions: [TextButton(onPressed: () => Navigator.pop(dialog), child: Text(t('ঠিক আছে', 'OK')))],
      ),
    );
  }

  Future<void> _report(Profile peer) async {
    const reasons = ['spam', 'harassment', 'impersonation', 'inappropriate', 'other'];
    final labels = {
      'spam': t('স্প্যাম', 'Spam'),
      'harassment': t('হয়রানি', 'Harassment'),
      'impersonation': t('অন্য কেউ সেজে আছে', 'Pretending to be someone'),
      'inappropriate': t('অনুপযুক্ত কনটেন্ট', 'Inappropriate content'),
      'other': t('অন্য কিছু', 'Something else'),
    };
    String? reason;
    var block = false;
    final note = TextEditingController();
    final send = await showDialog<bool>(
      context: context,
      builder: (dialog) => StatefulBuilder(
        builder: (context, setLocal) => AlertDialog(
          title: Text(t('${peer.name}-কে রিপোর্ট করুন', 'Report ${peer.name}')),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              RadioGroup<String>(
                groupValue: reason,
                onChanged: (value) => setLocal(() => reason = value),
                child: Column(children: [
                  for (final value in reasons) RadioListTile<String>(value: value, title: Text(labels[value]!), contentPadding: EdgeInsets.zero, dense: true),
                ]),
              ),
              TextField(controller: note, maxLength: 500, minLines: 2, maxLines: 4, decoration: InputDecoration(labelText: t('বিস্তারিত (ঐচ্ছিক)', 'Details (optional)'), counterText: '')),
              SwitchListTile(value: block, onChanged: (value) => setLocal(() => block = value), title: Text(t('ব্লকও করুন', 'Also block')), contentPadding: EdgeInsets.zero),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialog), child: Text(t('বাতিল', 'Cancel'))),
            TextButton(onPressed: reason == null ? null : () => Navigator.pop(dialog, true), child: Text(t('রিপোর্ট', 'Report'), style: TextStyle(color: reason == null ? null : context.palette.danger))),
          ],
        ),
      ),
    );
    final text = note.text.trim();
    note.dispose();
    if (send != true || reason == null) return;
    await _run(() async {
      await chat.report(peer.id, reason!, text, block);
      if (mounted) showMessage(context, t('রিপোর্ট পাঠানো হয়েছে', 'Report sent'));
    });
  }

  Future<void> _memberActions(Member member) async {
    final admin = member.role == 'admin';
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            leading: const Icon(LucideIcons.shieldCheck),
            title: Text(admin ? t('অ্যাডমিন থেকে সরান', 'Dismiss as admin') : t('গ্রুপ অ্যাডমিন করুন', 'Make group admin'), style: const TextStyle(fontWeight: FontWeight.w700)),
            onTap: () => Navigator.pop(sheet, 'role'),
          ),
          ListTile(
            leading: Icon(LucideIcons.userMinus, color: context.palette.danger),
            title: Text(t('সরিয়ে দিন', 'Remove'), style: TextStyle(fontWeight: FontWeight.w700, color: context.palette.danger)),
            onTap: () => Navigator.pop(sheet, 'remove'),
          ),
        ]),
      ),
    );
    if (choice == 'role') await _run(() => chat.setRole(widget.conversationId, member.userId, admin ? 'member' : 'admin'));
    if (choice == 'remove') await _run(() => chat.removeMember(widget.conversationId, member.userId));
  }

  @override
  Widget build(BuildContext context) {
    final chat = context.watch<Chat>();
    final prefs = context.watch<Prefs>();
    final t = prefs.t;
    final p = context.palette;
    final c = chat.conversations[widget.conversationId];
    if (c == null) return Scaffold(appBar: AppBar());
    final group = c.group;
    final peer = c.peerId != null ? chat.profiles[c.peerId] : null;
    final members = chat.members[c.id] ?? [];
    final myRole = members.where((m) => m.userId == chat.me).firstOrNull?.role ?? c.role;
    final isAdmin = myRole == 'admin' || myRole == 'owner';
    final canEdit = group != null && c.active && (group['editInfoPolicy'] != 'admins' || isAdmin);
    final title = chat.titleOf(c, fallback: t('চ্যাট', 'Chat'));
    final about = (group?['description'] as String?)?.trim().isNotEmpty == true ? group!['description'] as String : peer?.about;
    final disappearing = c.disappearingSeconds ?? 0;

    return Scaffold(
      appBar: AppBar(title: Text(group != null ? t('গ্রুপের তথ্য', 'Group info') : t('কন্টাক্টের তথ্য', 'Contact info'))),
      body: ListView(padding: const EdgeInsets.only(bottom: 32), children: [
        const SizedBox(height: 16),
        Center(
          child: GestureDetector(
            onTap: canEdit && !uploading ? _changeGroupPhoto : null,
            child: Stack(alignment: Alignment.center, children: [
              Avatar(name: title, url: chat.avatarOf(c), size: 108, group: group != null && chat.avatarOf(c) == null),
              if (uploading) const CircularProgressIndicator(),
              if (canEdit && !uploading)
                Positioned(right: 0, bottom: 0, child: CircleAvatar(radius: 17, backgroundColor: p.brand, child: const Icon(LucideIcons.camera, size: 17, color: Palette.onBrand))),
            ]),
          ),
        ),
        const SizedBox(height: 14),
        Text(title, textAlign: TextAlign.center, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
        const SizedBox(height: 4),
        Text(
          group != null ? t('${members.length} জন সদস্য', '${members.length} members') : (peer != null ? '@${peer.username}' : ''),
          textAlign: TextAlign.center,
          style: TextStyle(color: p.muted, fontWeight: FontWeight.w600),
        ),
        if (canEdit)
          Center(
            child: Padding(
              padding: const EdgeInsets.only(top: 10),
              child: TextButton.icon(onPressed: () => _editGroup(group), icon: const Icon(LucideIcons.pencil, size: 16), label: Text(t('সম্পাদনা', 'Edit'))),
            ),
          ),
        const SizedBox(height: 12),
        if (about != null && about.isNotEmpty)
          _Card(title: group != null ? t('বিবরণ', 'Description') : t('পরিচিতি', 'About'), child: Text(about, style: const TextStyle(height: 1.5))),
        _Card(
          title: t('অদৃশ্য মেসেজ', 'Disappearing messages'),
          child: SizedBox(
            width: double.infinity,
            child: SegmentedButton<int>(
              showSelectedIcon: false,
              segments: [
                ButtonSegment(value: 0, label: Text(t('বন্ধ', 'Off'))),
                ButtonSegment(value: 86400, label: Text(t('২৪ ঘ.', '24h'))),
                ButtonSegment(value: 604800, label: Text(t('৭ দিন', '7d'))),
                ButtonSegment(value: 7776000, label: Text(t('৯০ দিন', '90d'))),
              ],
              selected: {disappearing},
              onSelectionChanged: c.active ? (value) => _run(() => chat.setDisappearing(c.id, value.first == 0 ? null : value.first)) : null,
            ),
          ),
        ),
        if (group == null && peer != null)
          _Card(
            title: t('এনক্রিপশন', 'Encryption'),
            child: _Action(icon: LucideIcons.shieldCheck, label: t('নিরাপত্তা কোড যাচাই করুন', 'Verify security code'), onTap: () => _safety(peer.id, title)),
          ),
        if (group != null && isAdmin && c.active)
          _Card(
            title: t('গ্রুপ সেটিংস', 'Group settings'),
            child: Column(children: [
              _Switch(label: t('শুধু অ্যাডমিনরা মেসেজ পাঠাতে পারবেন', 'Only admins can send messages'), value: group['sendPolicy'] == 'admins', onChanged: (v) => _run(() => chat.updateGroup(c.id, {'sendPolicy': v ? 'admins' : 'all'}))),
              _Switch(label: t('শুধু অ্যাডমিনরা গ্রুপের তথ্য বদলাতে পারবেন', 'Only admins can edit group info'), value: group['editInfoPolicy'] == 'admins', onChanged: (v) => _run(() => chat.updateGroup(c.id, {'editInfoPolicy': v ? 'admins' : 'all'}))),
              _Switch(label: t('নতুন সদস্য অনুমোদন করুন', 'Approve new members'), value: group['approvalRequired'] == true, onChanged: (v) => _run(() => chat.updateGroup(c.id, {'approvalRequired': v}))),
            ]),
          ),
        if (group != null)
          _Card(
            title: t('${members.length} জন সদস্য', '${members.length} members'),
            child: Column(children: [
              if (c.active && (isAdmin || group['addMemberPolicy'] == 'all'))
                _Action(
                  icon: LucideIcons.userPlus,
                  label: t('সদস্য যোগ করুন', 'Add members'),
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => NewChatScreen(addTo: c.id, existing: members.map((m) => m.userId).toList()))),
                ),
              if (c.active && isAdmin)
                _Action(
                  icon: LucideIcons.link2,
                  label: t('লিংক দিয়ে আমন্ত্রণ', 'Invite via link'),
                  onTap: () => _run(() async {
                    final code = await chat.inviteLink(c.id);
                    await Clipboard.setData(ClipboardData(text: '${Config.origin}/join/$code'));
                    if (context.mounted) showMessage(context, t('আমন্ত্রণ লিংক কপি হয়েছে', 'Invite link copied'));
                  }),
                ),
              for (final member in members)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Avatar(name: chat.nameOf(member.userId), url: chat.profiles[member.userId]?.avatarUrl, size: 42),
                  title: Text(member.userId == chat.me ? t('আপনি', 'You') : chat.nameOf(member.userId), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: chat.profiles[member.userId] == null ? null : Text('@${chat.profiles[member.userId]!.username}', style: TextStyle(color: p.subtle)),
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    if (member.role != 'member')
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(color: p.brandSoft, borderRadius: BorderRadius.circular(99)),
                        child: Text(member.role == 'owner' ? t('মালিক', 'Owner') : t('অ্যাডমিন', 'Admin'), style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w800, color: p.brand)),
                      ),
                    if (isAdmin && c.active && member.userId != chat.me && member.role != 'owner')
                      IconButton(icon: const Icon(LucideIcons.ellipsisVertical, size: 18), onPressed: () => _memberActions(member)),
                  ]),
                ),
            ]),
          ),
        _Card(
          child: Column(children: [
            if (group == null && peer != null) ...[
              _Action(
                icon: LucideIcons.ban,
                danger: true,
                label: peer.blockedByMe ? t('আনব্লক করুন', 'Unblock') : t('${peer.name}-কে ব্লক করুন', 'Block ${peer.name}'),
                onTap: () => _run(() => chat.setBlocked(peer.id, !peer.blockedByMe)),
              ),
              _Action(icon: LucideIcons.flag, danger: true, label: t('${peer.name}-কে রিপোর্ট', 'Report ${peer.name}'), onTap: () => _report(peer)),
            ],
            if (group != null && c.active)
              _Action(
                icon: LucideIcons.logOut,
                danger: true,
                label: t('গ্রুপ থেকে বের হন', 'Exit group'),
                onTap: () async {
                  if (await _confirm(t('গ্রুপ থেকে বের হবেন?', 'Exit this group?'), t('বের হন', 'Exit'))) await _run(() => chat.removeMember(c.id, chat.me));
                },
              ),
            if (group == null || !c.active)
              _Action(
                icon: LucideIcons.trash2,
                danger: true,
                label: t('চ্যাট মুছুন', 'Delete chat'),
                onTap: () async {
                  final navigator = Navigator.of(context);
                  if (!await _confirm(t('চ্যাটটি মুছবেন?', 'Delete this chat?'), t('মুছুন', 'Delete'))) return;
                  await _run(() async {
                    await chat.deleteConversation(c.id);
                    navigator.popUntil((route) => route.isFirst);
                  });
                },
              ),
          ]),
        ),
      ]),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({this.title, required this.child});
  final String? title;
  final Widget child;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(20), border: Border.all(color: p.border)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (title != null) ...[
          Text(title!, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w800, color: p.muted)),
          const SizedBox(height: 10),
        ],
        child,
      ]),
    );
  }
}

class _Action extends StatelessWidget {
  const _Action({required this.icon, required this.label, required this.onTap, this.danger = false});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool danger;
  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final color = danger ? p.danger : p.text;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(icon, color: danger ? p.danger : p.brand),
      title: Text(label, style: TextStyle(fontWeight: FontWeight.w700, color: color)),
      onTap: onTap,
    );
  }
}

class _Switch extends StatelessWidget {
  const _Switch({required this.label, required this.value, required this.onChanged});
  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;
  @override
  Widget build(BuildContext context) => SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
        value: value,
        onChanged: onChanged,
      );
}

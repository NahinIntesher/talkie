import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import '../chat/chat.dart';
import '../chat/models.dart';
import '../core/api.dart';
import '../core/prefs.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'thread.dart';

/// Start a chat by username or from contacts, or pick people for a new group.
class NewChatScreen extends StatefulWidget {
  const NewChatScreen({super.key, this.group = false, this.initialQuery = '', this.addTo, this.existing = const []});
  final bool group;
  final String initialQuery;
  /// Picking people to add to this existing group (instead of creating one).
  final String? addTo;
  final List<String> existing;
  @override
  State<NewChatScreen> createState() => _NewChatScreenState();
}

class _NewChatScreenState extends State<NewChatScreen> {
  final search = TextEditingController();
  final groupName = TextEditingController();
  List<Profile> contacts = [];
  Profile? found;
  bool searching = false;
  bool lookupFailed = false;
  int lookupRequest = 0;
  bool busy = false;
  final selected = <String, Profile>{};
  Timer? debounce;

  @override
  void initState() {
    super.initState();
    if (widget.initialQuery.isNotEmpty) {
      search.text = widget.initialQuery;
      lookup(search.text);
    }
    api.get('/users/me/contacts').then((r) {
      if (mounted) setState(() => contacts = (r['contacts'] as List).map((u) => Profile(u as Json)).toList());
    }).catchError((_) {});
  }

  @override
  void dispose() {
    debounce?.cancel();
    search.dispose();
    groupName.dispose();
    super.dispose();
  }

  void lookup(String raw) {
    final username = raw.trim().toLowerCase().replaceFirst(RegExp(r'^@'), '');
    final request = ++lookupRequest;
    final valid = RegExp(r'^[a-z0-9._]{3,32}$').hasMatch(username);
    debounce?.cancel();
    setState(() {
      found = null;
      lookupFailed = false;
      searching = valid;
    });
    if (!valid) return;
    debounce = Timer(const Duration(milliseconds: 350), () async {
      try {
        final result = await api.get('/users/by-username/${Uri.encodeComponent(username)}');
        if (mounted && request == lookupRequest) setState(() => found = Profile(result['user'] as Json));
      } catch (error) {
        if (mounted && request == lookupRequest && (error is! ApiError || error.status != 404)) setState(() => lookupFailed = true);
      } finally {
        if (mounted && request == lookupRequest) setState(() => searching = false);
      }
    });
  }

  bool get picking => widget.group || widget.addTo != null;

  Future<void> pick(Profile profile) async {
    if (picking) {
      setState(() => selected.containsKey(profile.id) ? selected.remove(profile.id) : selected[profile.id] = profile);
      return;
    }
    final chat = context.read<Chat>();
    final navigator = Navigator.of(context);
    setState(() => busy = true);
    try {
      chat.profiles[profile.id] ??= profile;
      final id = await chat.startDirect(profile.id);
      navigator.pushReplacement(MaterialPageRoute(builder: (_) => ThreadScreen(conversationId: id)));
    } catch (err) {
      if (mounted) showMessage(context, '$err', error: true);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> addToGroup() async {
    final chat = context.read<Chat>();
    final navigator = Navigator.of(context);
    setState(() => busy = true);
    try {
      await chat.addMembers(widget.addTo!, selected.keys.toList());
      navigator.pop();
    } catch (err) {
      if (mounted) showMessage(context, '$err', error: true);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> createGroup() async {
    final chat = context.read<Chat>();
    final navigator = Navigator.of(context);
    setState(() => busy = true);
    try {
      final id = await chat.createGroup(groupName.text.trim(), selected.keys.toList());
      navigator.pushReplacement(MaterialPageRoute(builder: (_) => ThreadScreen(conversationId: id)));
    } catch (err) {
      if (mounted) showMessage(context, '$err', error: true);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.watch<Prefs>().t;
    final p = context.palette;
    final query = search.text.trim().toLowerCase().replaceFirst(RegExp(r'^@'), '');
    final people = [
      ?found,
      ...contacts.where((c) => c.id != found?.id && (query.isEmpty || c.name.toLowerCase().contains(query) || c.username.contains(query))),
    ].where((person) => !widget.existing.contains(person.id)).toList();
    final adding = widget.addTo != null;
    return Scaffold(
      appBar: AppBar(title: Text(adding ? t('সদস্য যোগ করুন', 'Add members') : widget.group ? t('নতুন গ্রুপ', 'New group') : t('নতুন চ্যাট', 'New chat'))),
      floatingActionButton: selected.isNotEmpty && (adding || (widget.group && groupName.text.trim().isNotEmpty))
          ? FloatingActionButton.extended(
              onPressed: busy ? null : (adding ? addToGroup : createGroup),
              backgroundColor: Palette.fill[1],
              foregroundColor: Palette.onBrand,
              icon: busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Palette.onBrand)) : const Icon(LucideIcons.check),
              label: Text(adding ? t('যোগ করুন', 'Add') : t('তৈরি করুন', 'Create'), style: const TextStyle(fontWeight: FontWeight.w800)),
            )
          : null,
      body: Column(children: [
        if (widget.group)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: TextField(
              controller: groupName,
              maxLength: 64,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(hintText: t('গ্রুপের নাম', 'Group name'), counterText: '', prefixIcon: const Icon(LucideIcons.users, size: 20)),
            ),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
          child: TextField(
            controller: search,
            autofocus: !picking,
            autocorrect: false,
            onChanged: lookup,
            decoration: InputDecoration(
              hintText: t('নাম বা @ইউজারনেম', 'Name or @username'),
              prefixIcon: const Icon(LucideIcons.search, size: 20),
              suffixIcon: searching ? const Padding(padding: EdgeInsets.all(14), child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))) : null,
            ),
          ),
        ),
        if (selected.isNotEmpty)
          SizedBox(
            height: 92,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              children: [
                for (final s in selected.values)
                  GestureDetector(
                    onTap: () => setState(() => selected.remove(s.id)),
                    child: Padding(
                      padding: const EdgeInsets.all(6),
                      child: Column(children: [
                        Stack(children: [
                          Avatar(name: s.name, url: s.avatarUrl, size: 52),
                          Positioned(right: 0, bottom: 0, child: CircleAvatar(radius: 9, backgroundColor: p.subtle, child: const Icon(LucideIcons.x, size: 12, color: Colors.white))),
                        ]),
                        const SizedBox(height: 4),
                        SizedBox(width: 60, child: Text(s.name.split(' ').first, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600))),
                      ]),
                    ),
                  ),
              ],
            ),
          ),
        if (!picking && query.isEmpty)
          ListTile(
            contentPadding: const EdgeInsets.symmetric(horizontal: 20),
            leading: CircleAvatar(radius: 24, backgroundColor: p.brandSoft, child: Icon(LucideIcons.users, color: p.brand)),
            title: Text(t('নতুন গ্রুপ', 'New group'), style: const TextStyle(fontWeight: FontWeight.w800)),
            onTap: () => Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const NewChatScreen(group: true))),
          ),
        if (busy && !picking) const LinearProgressIndicator(),
        if (query.length >= 3 && !searching && people.isEmpty)
          Padding(
            padding: const EdgeInsets.all(12),
            child: lookupFailed
                ? TextButton(onPressed: () => lookup(search.text), child: Text(t('খোঁজা যায়নি, আবার চেষ্টা করুন', 'Search failed. Try again')))
                : Text(t('এই ইউজারনেমে কাউকে পাওয়া যায়নি', 'No one found with this username'), textAlign: TextAlign.center),
          ),
        Expanded(
          child: ListView.builder(
            itemCount: people.length,
            itemBuilder: (context, i) {
              final person = people[i];
              final checked = selected.containsKey(person.id);
              return ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 2),
                leading: Avatar(name: person.name, url: person.avatarUrl, size: 48),
                title: Text(person.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                subtitle: Text('@${person.username}', style: TextStyle(color: p.subtle, fontWeight: FontWeight.w500)),
                trailing: picking ? Checkbox(value: checked, onChanged: (_) => pick(person), shape: const CircleBorder(), activeColor: p.brand) : null,
                onTap: () => pick(person),
              );
            },
          ),
        ),
      ]),
    );
  }
}

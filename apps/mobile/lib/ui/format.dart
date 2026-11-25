import 'package:intl/intl.dart';

import '../chat/chat.dart';
import '../chat/models.dart';
import '../core/prefs.dart';

const _bnDigits = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

String digits(String text, Prefs prefs) => prefs.bn ? text.replaceAllMapped(RegExp('[0-9]'), (m) => _bnDigits[int.parse(m[0]!)]) : text;

String clock(DateTime time, Prefs prefs) => digits(DateFormat(prefs.bn ? 'h:mm a' : 'h:mm a').format(time), prefs);

bool sameDay(DateTime a, DateTime b) => a.year == b.year && a.month == b.month && a.day == b.day;

/// Time shown in the chat list: clock today, "Yesterday", weekday this week, then a date.
String listTime(DateTime time, Prefs prefs) {
  final now = DateTime.now();
  if (sameDay(time, now)) return clock(time, prefs);
  if (sameDay(time, now.subtract(const Duration(days: 1)))) return prefs.t('গতকাল', 'Yesterday');
  if (now.difference(time).inDays < 7) return DateFormat.EEEE(prefs.locale).format(time);
  return digits(DateFormat('d/M/yy').format(time), prefs);
}

String dayLabel(DateTime time, Prefs prefs) {
  final now = DateTime.now();
  if (sameDay(time, now)) return prefs.t('আজ', 'Today');
  if (sameDay(time, now.subtract(const Duration(days: 1)))) return prefs.t('গতকাল', 'Yesterday');
  return DateFormat.yMMMMd(prefs.locale).format(time);
}

String lastSeen(String? iso, Prefs prefs) {
  if (iso == null) return '';
  final time = DateTime.parse(iso).toLocal();
  final at = sameDay(time, DateTime.now()) ? clock(time, prefs) : '${listTime(time, prefs)} ${clock(time, prefs)}';
  return prefs.t('শেষ দেখা $at', 'last seen $at');
}

String duration(int ms) {
  final s = ms ~/ 1000;
  return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
}

String fileSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(0)} KB';
  if (bytes < 1024 * 1024 * 1024) return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
  return '${(bytes / 1024 / 1024 / 1024).toStringAsFixed(2)} GB';
}

/// One-line preview of a message for the chat list and reply bars.
String preview(ChatMessage? m, Chat chat, Prefs prefs) {
  if (m == null) return '';
  final t = prefs.t;
  if (m.deleted) return t('বার্তাটি মুছে ফেলা হয়েছে', 'This message was deleted');
  if (m.kind == 'system') return systemText(m, chat, prefs);
  if (m.kind == 'call') return t('কল', 'Call');
  if (m.unreadable != null) return t('বার্তাটি খোলা যায়নি', 'Message unavailable');
  final text = m.text ?? '';
  switch (m.kind) {
    case 'image':
      return '📷 ${text.isEmpty ? t('ছবি', 'Photo') : text}';
    case 'video':
      return '🎬 ${text.isEmpty ? t('ভিডিও', 'Video') : text}';
    case 'voice':
      return '🎤 ${t('ভয়েস মেসেজ', 'Voice message')}';
    case 'document':
    case 'audio':
      return '📄 ${m.attachments.firstOrNull?['name'] ?? t('ফাইল', 'File')}';
    case 'poll':
      return '📊 ${m.poll?['question'] ?? ''}';
  }
  return text;
}

String systemText(ChatMessage m, Chat chat, Prefs prefs) {
  final e = m.systemEvent;
  if (e == null) return '';
  final t = prefs.t;
  final actor = chat.nameOf(e['actorId'] as String? ?? '', you: t('আপনি', 'You'));
  final targets = ((e['targetIds'] as List?) ?? []).map((id) => chat.nameOf(id as String, you: t('আপনাকে', 'you'))).join(', ');
  switch (e['type']) {
    case 'group_created':
      return t('$actor গ্রুপটি তৈরি করেছেন', '$actor created the group');
    case 'members_added':
      return t('$actor $targets কে যোগ করেছেন', '$actor added $targets');
    case 'member_removed':
      return t('$actor $targets কে সরিয়েছেন', '$actor removed $targets');
    case 'member_left':
      return t('$actor চলে গেছেন', '$actor left');
    case 'member_joined':
      return t('$actor যোগ দিয়েছেন', '$actor joined');
    case 'admin_promoted':
      return t('$targets এখন অ্যাডমিন', '$targets is now an admin');
    case 'admin_demoted':
      return t('$targets আর অ্যাডমিন নন', '$targets is no longer an admin');
    case 'name_changed':
      return t('$actor গ্রুপের নাম বদলেছেন', '$actor changed the group name');
    case 'description_changed':
      return t('$actor বিবরণ বদলেছেন', '$actor changed the description');
    case 'disappearing_changed':
      return t('$actor অদৃশ্য বার্তা বদলেছেন', '$actor changed disappearing messages');
    default:
      return t('$actor সেটিংস বদলেছেন', '$actor changed the settings');
  }
}

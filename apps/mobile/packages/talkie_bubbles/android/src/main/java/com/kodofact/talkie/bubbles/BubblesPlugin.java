package com.kodofact.talkie.bubbles;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;
import android.util.Log;
import io.flutter.embedding.engine.plugins.FlutterPlugin;
import io.flutter.embedding.engine.plugins.activity.ActivityAware;
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding;
import io.flutter.plugin.common.MethodCall;
import io.flutter.plugin.common.MethodChannel;
import io.flutter.plugin.common.PluginRegistry;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

public final class BubblesPlugin implements FlutterPlugin, ActivityAware, MethodChannel.MethodCallHandler,
        PluginRegistry.NewIntentListener {
    static final String DEVICE = "talkie.bubbles.device";
    static final String CONVERSATION = "talkie.bubbles.conversation";
    private static final String PREFIX = "talkie-chat:";
    private static final Pattern ID = Pattern.compile("[1-9][0-9]{0,19}");
    private Context context;
    private MethodChannel channel;
    private ActivityPluginBinding binding;
    private Map<String, String> pending;

    static boolean validId(String value) {
        return value != null && ID.matcher(value).matches();
    }

    @Override
    public void onAttachedToEngine(FlutterPluginBinding engine) {
        context = engine.getApplicationContext();
        channel = new MethodChannel(engine.getBinaryMessenger(), "talkie/bubbles");
        channel.setMethodCallHandler(this);
    }

    @Override
    public void onDetachedFromEngine(FlutterPluginBinding engine) {
        channel.setMethodCallHandler(null);
    }

    @Override
    public void onAttachedToActivity(ActivityPluginBinding activity) {
        binding = activity;
        activity.addOnNewIntentListener(this);
        if (!(activity.getActivity() instanceof FloatingChatActivity)) onNewIntent(activity.getActivity().getIntent());
    }

    @Override
    public void onDetachedFromActivity() {
        binding.removeOnNewIntentListener(this);
        binding = null;
    }

    @Override
    public void onDetachedFromActivityForConfigChanges() {
        onDetachedFromActivity();
    }

    @Override
    public void onReattachedToActivityForConfigChanges(ActivityPluginBinding activity) {
        onAttachedToActivity(activity);
    }

    @Override
    public boolean onNewIntent(Intent intent) {
        if (intent == null) return false;
        String device = intent.getStringExtra(DEVICE);
        String conversation = intent.getStringExtra(CONVERSATION);
        if (!validId(device) || !validId(conversation)) return false;
        intent.removeExtra(DEVICE);
        intent.removeExtra(CONVERSATION);
        pending = new HashMap<>();
        pending.put("device", device);
        pending.put("conversation", conversation);
        channel.invokeMethod("openChat", null);
        return true;
    }

    private SharedPreferences preferences() {
        return context.getSharedPreferences("talkie_conversation_bubbles", Context.MODE_PRIVATE);
    }

    private NotificationManager notifications() {
        return context.getSystemService(NotificationManager.class);
    }

    private boolean allowed() {
        if (Build.VERSION.SDK_INT >= 31) {
            return notifications().areBubblesEnabled()
                    && notifications().getBubblePreference() != NotificationManager.BUBBLE_PREFERENCE_NONE;
        }
        return Build.VERSION.SDK_INT >= 30 && notifications().areBubblesAllowed();
    }

    @Override
    public void onMethodCall(MethodCall call, MethodChannel.Result result) {
        String device = call.argument("device");
        try {
            switch (call.method) {
                case "status" -> {
                    Map<String, Boolean> status = new HashMap<>();
                    status.put("supported", Build.VERSION.SDK_INT >= 30);
                    status.put("enabled", validId(device) && device.equals(preferences().getString(DEVICE, null)));
                    status.put("notifications", notifications().areNotificationsEnabled());
                    status.put("allowed", allowed());
                    result.success(status);
                }
                case "enable" -> {
                    if (Build.VERSION.SDK_INT >= 30 && validId(device)) {
                        preferences().edit().putString(DEVICE, device).apply();
                    }
                    result.success(null);
                }
                case "disable" -> {
                    if (validId(device) && device.equals(preferences().getString(DEVICE, null))) disable(device);
                    result.success(null);
                }
                case "settings" -> {
                    if (binding != null && Build.VERSION.SDK_INT >= 30) {
                        Intent settings = new Intent(Settings.ACTION_APP_NOTIFICATION_BUBBLE_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
                        try {
                            binding.getActivity().startActivity(settings);
                        } catch (ActivityNotFoundException noBubbleSettings) {
                            binding.getActivity().startActivity(settings.setAction(Settings.ACTION_APP_NOTIFICATION_SETTINGS));
                        }
                    }
                    result.success(null);
                }
                case "decorate" -> result.success(decorate(call, device));
                case "openApp" -> {
                    String conversation = call.argument("conversation");
                    if (binding != null && validId(device) && validId(conversation)) {
                        Activity activity = binding.getActivity();
                        activity.startActivity(fullChat(device, conversation).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                        if (activity instanceof FloatingChatActivity) activity.finish();
                    }
                    result.success(null);
                }
                case "takeOpen" -> {
                    result.success(pending);
                    pending = null;
                }
                default -> result.notImplemented();
            }
        } catch (RuntimeException error) {
            Log.w("TalkieBubbles", "Android bubble operation failed: " + call.method + " (" + error.getClass().getSimpleName() + ")");
            result.error("bubble_unavailable", error.getMessage(), null);
        }
    }

    private Intent fullChat(String device, String conversation) {
        return context.getPackageManager().getLaunchIntentForPackage(context.getPackageName())
                .setAction(Intent.ACTION_VIEW)
                .putExtra(DEVICE, device)
                .putExtra(CONVERSATION, conversation)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    private void disable(String device) {
        preferences().edit().remove(DEVICE).apply();
        if (Build.VERSION.SDK_INT < 30) return;
        String prefix = PREFIX + device + ":";
        for (StatusBarNotification item : notifications().getActiveNotifications()) {
            String shortcut = item.getNotification().getShortcutId();
            if (shortcut != null && shortcut.startsWith(prefix)) notifications().cancel(item.getTag(), item.getId());
        }
        ShortcutManager manager = context.getSystemService(ShortcutManager.class);
        List<String> ids = new ArrayList<>();
        for (ShortcutInfo shortcut : manager.getShortcuts(ShortcutManager.FLAG_MATCH_DYNAMIC | ShortcutManager.FLAG_MATCH_CACHED)) {
            if (shortcut.getId().startsWith(prefix)) ids.add(shortcut.getId());
        }
        if (!ids.isEmpty()) {
            manager.removeDynamicShortcuts(ids);
            manager.removeLongLivedShortcuts(ids);
        }
    }

    private boolean decorate(MethodCall call, String device) {
        if (Build.VERSION.SDK_INT < 30 || !validId(device) || !device.equals(preferences().getString(DEVICE, null))) return false;
        String conversation = call.argument("conversation");
        String title = call.argument("title");
        Integer id = call.argument("notificationId");
        if (!validId(conversation) || title == null || title.trim().isEmpty() || id == null) return false;
        for (StatusBarNotification item : notifications().getActiveNotifications()) {
            if (item.getId() != id || !conversation.equals(item.getTag())) continue;
            String shortcut = PREFIX + device + ":" + conversation;
            byte[] photo = call.argument("avatar");
            Bitmap bitmap = photo == null ? null : BitmapFactory.decodeByteArray(photo, 0, photo.length);
            Icon icon = bitmap == null ? conversationIcon(title) : Icon.createWithAdaptiveBitmap(bitmap);
            Person person = new Person.Builder().setName(title).setKey(shortcut).setIcon(icon).build();
            ShortcutManager manager = context.getSystemService(ShortcutManager.class);
            manager.pushDynamicShortcut(new ShortcutInfo.Builder(context, shortcut)
                    .setShortLabel(title).setLongLived(true).setIcon(icon).setPerson(person)
                    .setIntent(fullChat(device, conversation)).build());
            Intent target = new Intent(context, FloatingChatActivity.class)
                    .setAction(Intent.ACTION_VIEW)
                    .setData(Uri.parse("talkie://bubble/" + device + "/" + conversation))
                    .putExtra(DEVICE, device)
                    .putExtra(CONVERSATION, conversation);
            // System UI adds launch options when it opens a bubble. Keep the intent scoped to
            // the non-exported activity and the conversation-specific URI.
            int launchFlags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 31) launchFlags |= PendingIntent.FLAG_MUTABLE;
            PendingIntent launch = PendingIntent.getActivity(context, 0, target, launchFlags);
            boolean expand = Boolean.TRUE.equals(call.argument("expand"));
            Notification.BubbleMetadata bubble = new Notification.BubbleMetadata.Builder(launch, icon)
                    .setDesiredHeight(640).setAutoExpandBubble(expand).setSuppressNotification(expand).build();
            Notification enriched = Notification.Builder.recoverBuilder(context, item.getNotification())
                    .setShortcutId(shortcut).setAutoCancel(false).setOnlyAlertOnce(true).setBubbleMetadata(bubble).build();
            notifications().notify(conversation, id, enriched);
            return true;
        }
        return false;
    }

    private Icon conversationIcon(String title) {
        Bitmap bitmap = Bitmap.createBitmap(108, 108, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.drawColor(0xffffd46b);
        Paint letter = new Paint(Paint.ANTI_ALIAS_FLAG);
        letter.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        letter.setColor(0xff392400);
        letter.setTextAlign(Paint.Align.CENTER);
        letter.setTextSize(45);
        String initial = new String(Character.toChars(title.trim().codePointAt(0)));
        canvas.drawText(initial, 54, 54 - (letter.ascent() + letter.descent()) / 2, letter);
        return Icon.createWithAdaptiveBitmap(bitmap);
    }
}

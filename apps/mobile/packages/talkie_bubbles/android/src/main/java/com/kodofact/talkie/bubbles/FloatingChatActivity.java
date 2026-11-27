package com.kodofact.talkie.bubbles;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import io.flutter.embedding.android.FlutterActivity;

public final class FloatingChatActivity extends FlutterActivity {
    private SharedPreferences preferences;
    private final SharedPreferences.OnSharedPreferenceChangeListener featureChanged =
            (prefs, name) -> { if (BubblesPlugin.DEVICE.equals(name) && !isEnabled()) finish(); };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("talkie_conversation_bubbles", Context.MODE_PRIVATE);
        preferences.registerOnSharedPreferenceChangeListener(featureChanged);
        if (!isEnabled()) finish();
    }

    @Override
    protected void onDestroy() {
        if (preferences != null) preferences.unregisterOnSharedPreferenceChangeListener(featureChanged);
        super.onDestroy();
    }

    private boolean isEnabled() {
        String device = getIntent().getStringExtra(BubblesPlugin.DEVICE);
        return BubblesPlugin.validId(device) && device.equals(preferences.getString(BubblesPlugin.DEVICE, null));
    }

    @Override
    public String getInitialRoute() {
        String device = getIntent().getStringExtra(BubblesPlugin.DEVICE);
        String conversation = getIntent().getStringExtra(BubblesPlugin.CONVERSATION);
        return BubblesPlugin.validId(device) && BubblesPlugin.validId(conversation)
                ? "/floating-chat/" + device + "/" + conversation
                : "/floating-chat";
    }
}

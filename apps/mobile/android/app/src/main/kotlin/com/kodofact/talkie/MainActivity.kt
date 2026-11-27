package com.kodofact.talkie

import android.app.PictureInPictureParams
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.util.Rational
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var pipEnabled = false
    private var openId: String? = null

    override fun configureFlutterEngine(engine: FlutterEngine) {
        super.configureFlutterEngine(engine)
        openId = intent.getStringExtra("ongoingId")
        channel = MethodChannel(engine.dartExecutor.binaryMessenger, "talkie/ongoing")
        channel?.setMethodCallHandler { call, result ->
            when (call.method) {
                "update" -> {
                    val data = call.arguments as Map<*, *>
                    setPip(data["pip"] == true)
                    val service = Intent(this, OngoingCallService::class.java)
                    for ((key, value) in data) when (value) {
                        is String -> service.putExtra(key as String, value)
                        is Boolean -> service.putExtra(key as String, value)
                        is Number -> service.putExtra(key as String, value.toLong())
                    }
                    try {
                        ContextCompat.startForegroundService(this, service)
                        result.success(null)
                    } catch (e: RuntimeException) {
                        result.error("foreground_service", e.message, null)
                    }
                }
                "stop" -> {
                    setPip(false)
                    stopService(Intent(this, OngoingCallService::class.java))
                    result.success(null)
                }
                "background" -> { if (!enterPip()) moveTaskToBack(true); result.success(null) }
                "takeOpen" -> { result.success(openId); openId = null }
                else -> result.notImplemented()
            }
        }
    }

    private fun canPip() = Build.VERSION.SDK_INT >= 26 && packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private fun setPip(enabled: Boolean) {
        if (enabled == pipEnabled) return
        pipEnabled = enabled
        if (canPip() && Build.VERSION.SDK_INT >= 31) {
            setPictureInPictureParams(PictureInPictureParams.Builder().setAspectRatio(Rational(4, 3)).setAutoEnterEnabled(enabled).build())
        }
    }

    private fun enterPip(): Boolean {
        if (!pipEnabled || !canPip() || Build.VERSION.SDK_INT < 26) return false
        return try { enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(Rational(4, 3)).build()) }
        catch (_: IllegalStateException) { false }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT < 31) enterPip()
    }

    override fun onPictureInPictureModeChanged(active: Boolean, config: Configuration) {
        super.onPictureInPictureModeChanged(active, config)
        channel?.invokeMethod("pip", active)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra("ongoingId")?.let { id ->
            openId = id
            channel?.invokeMethod("open", id)
        }
    }

    override fun cleanUpFlutterEngine(engine: FlutterEngine) {
        channel?.setMethodCallHandler(null)
        channel = null
        stopService(Intent(this, OngoingCallService::class.java))
        super.cleanUpFlutterEngine(engine)
    }

    companion object {
        var channel: MethodChannel? = null
            private set
    }
}

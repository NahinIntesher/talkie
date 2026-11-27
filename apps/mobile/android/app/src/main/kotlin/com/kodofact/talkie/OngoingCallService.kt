package com.kodofact.talkie

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat

class OngoingCallService : Service() {
    private var sessionId: String? = null
    private var activeTypes = 0
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra("id") ?: return START_NOT_STICKY
        if (intent.action == "end" || intent.action == "mute") {
            if (id == sessionId) {
                val channel = MainActivity.channel
                if (channel != null) channel.invokeMethod(intent.action!!, id) else stopSelf()
            }
            return START_NOT_STICKY
        }
        sessionId = id
        val manager = getSystemService(NotificationManager::class.java)
        val channelId = "ongoing_calls"
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(channelId, intent.getStringExtra("channel"), NotificationManager.IMPORTANCE_HIGH).apply {
                setSound(null, null)
                enableVibration(false)
            })
        }
        val open = Intent(this, MainActivity::class.java).putExtra("ongoingId", id)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val immutable = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        fun action(name: String): PendingIntent {
            val command = Intent(this, OngoingCallService::class.java).setAction(name)
                .setData(Uri.Builder().scheme("talkie").authority("ongoing").appendPath(id).appendPath(name).build()).putExtra("id", id)
            return PendingIntent.getService(this, 0, command, immutable)
        }
        val person = Person.Builder().setName(intent.getStringExtra("title") ?: "Talkie").build()
        val since = intent.getLongExtra("since", 0)
        val notification = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_stat_talkie)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, action("end")).setIsVideo(intent.getBooleanExtra("video", false)))
            .setContentTitle(person.name).setContentText(intent.getStringExtra("status"))
            .setContentIntent(PendingIntent.getActivity(this, 713, open, immutable))
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setWhen(since).setUsesChronometer(since > 0).setShowWhen(since > 0)
            .addAction(0, intent.getStringExtra("muteLabel"), action("mute")).build()
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        if (Build.VERSION.SDK_INT >= 30) {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (intent.getBooleanExtra("camera", false) && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        }
        try {
            if (types != activeTypes) {
                ServiceCompat.startForeground(this, 411, notification, types)
                activeTypes = types
            } else manager.notify(411, notification)
        } catch (_: SecurityException) {
            // An activity can leave the foreground while a permission dialog is closing.
            if (activeTypes == 0) stopSelf() else manager.notify(411, notification)
        }
        return START_NOT_STICKY
    }
}

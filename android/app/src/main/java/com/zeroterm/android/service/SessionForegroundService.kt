package com.zeroterm.android.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.net.wifi.WifiManager
import androidx.core.app.NotificationCompat
import com.zeroterm.android.MainActivity
import com.zeroterm.android.R
import com.zeroterm.android.ZeroTermApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Keeps the process visible while SSH sessions are open (RFC-003 §6.3).
 * The Application-scoped SessionManager remains the single source of truth.
 */
class SessionForegroundService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                serviceScope.launch {
                    (application as ZeroTermApp).container.sessions.disconnectAll()
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelfResult(startId)
                }
                return START_NOT_STICKY
            }
        }
        val sessions = (application as ZeroTermApp).container.sessions
        val connecting = intent?.getBooleanExtra(EXTRA_CONNECTING, false) == true
        val count = intent?.getIntExtra(EXTRA_SESSION_COUNT, sessions.sessionCount())
            ?: sessions.sessionCount()
        if (count <= 0 && !connecting) {
            stopSelfResult(startId)
            return START_NOT_STICKY
        }
        val notification = buildNotification(count.coerceAtLeast(1), connecting)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        acquireSessionLocks()
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        serviceScope.launch {
            (application as ZeroTermApp).container.sessions.disconnectAll()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelfResult(startId)
        }
    }

    override fun onDestroy() {
        releaseSessionLocks()
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun acquireSessionLocks() {
        if (wakeLock?.isHeld != true) {
            wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:SSHSession")
                .apply {
                    setReferenceCounted(false)
                    acquire()
                }
        }
        if (wifiLock?.isHeld != true) {
            val wifi = applicationContext.getSystemService(WifiManager::class.java)
            wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "$packageName:SSHSession")
                .apply {
                    setReferenceCounted(false)
                    acquire()
                }
        }
    }

    private fun releaseSessionLocks() {
        wifiLock?.let { if (it.isHeld) it.release() }
        wakeLock?.let { if (it.isHeld) it.release() }
        wifiLock = null
        wakeLock = null
    }

    private fun buildNotification(sessionCount: Int, connecting: Boolean): Notification {
        ensureChannel()
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                action = MainActivity.ACTION_OPEN_ACTIVE_SESSION
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                // AND-7: stamp the intent as internally originated + restrict
                // delivery to our own package so MainActivity can reject the
                // same custom action arriving from a third-party app.
                setPackage(packageName)
                putExtra(MainActivity.EXTRA_INTERNAL_NAV, true)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, SessionForegroundService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val text = if (connecting) {
            getString(R.string.session_service_connecting)
        } else if (sessionCount == 1) {
            getString(R.string.session_service_one)
        } else {
            getString(R.string.session_service_many, sessionCount)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.session_service_title))
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(0, getString(R.string.session_service_disconnect_all), stop)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun ensureChannel() {
        val mgr = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.session_service_channel),
            NotificationManager.IMPORTANCE_LOW,
        )
        mgr.createNotificationChannel(channel)
    }

    companion object {
        const val CHANNEL_ID = "zeroterm_sessions"
        const val NOTIFICATION_ID = 1001
        const val ACTION_STOP = "com.zeroterm.android.STOP_SESSIONS"
        const val EXTRA_SESSION_COUNT = "session_count"
        const val EXTRA_CONNECTING = "connecting"

        fun start(context: Context, sessionCount: Int, connecting: Boolean) {
            val intent = Intent(context, SessionForegroundService::class.java)
                .putExtra(EXTRA_SESSION_COUNT, sessionCount)
                .putExtra(EXTRA_CONNECTING, connecting)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SessionForegroundService::class.java))
        }
    }
}

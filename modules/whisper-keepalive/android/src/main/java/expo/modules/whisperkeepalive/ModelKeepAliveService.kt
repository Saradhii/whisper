package expo.modules.whisperkeepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * A foreground service with no work of its own. Its entire job is to exist:
 * while it runs, the process is "perceptible" rather than "cached", so Android
 * neither freezes it nor offers it to the low-memory killer first — which is
 * what lets the loaded model (and an in-flight generation) survive the user
 * switching apps.
 *
 * Started from JS when the app leaves the screen with a model resident, and
 * stopped when the user returns or the model is released after a long idle.
 */
class ModelKeepAliveService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      // Stopping is delivered as a command rather than through stopService():
      // a stopService() that overtakes a just-issued startForegroundService()
      // kills the service before it has called startForeground(), which the
      // platform punishes with a crash. A command is ordered behind the start.
      @Suppress("DEPRECATION")
      stopForeground(true)
      stopSelf()
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Model in memory"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Ready to answer when you come back."
    val notification = buildNotification(title, text)
    try {
      if (Build.VERSION.SDK_INT >= 34) {
        startForeground(NOTIFICATION_ID, notification, FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      // ForegroundServiceStartNotAllowedException (started too late, from the
      // background) or a missing type permission. Nothing to keep alive then.
      stopSelf()
    }
    // Not sticky: if the process dies the model is gone with it, and a
    // restarted empty service would be a notification guarding nothing.
    return START_NOT_STICKY
  }

  private fun buildNotification(title: String, text: String): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val builder = if (Build.VERSION.SDK_INT >= 26) {
      if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        val channel = NotificationChannel(
          CHANNEL_ID,
          "Model in memory",
          // Silent, no heads-up, collapsed in the shade.
          NotificationManager.IMPORTANCE_LOW
        )
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
      }
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    builder
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
    packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
      builder.setContentIntent(
        PendingIntent.getActivity(
          this,
          0,
          launch,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
      )
    }
    return builder.build()
  }

  companion object {
    const val ACTION_STOP = "expo.modules.whisperkeepalive.STOP"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    private const val CHANNEL_ID = "whisper-model-keepalive"
    private const val NOTIFICATION_ID = 0x5701
    // ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE (API 34), spelled out so
    // this compiles against any compileSdk.
    private const val FOREGROUND_SERVICE_TYPE_SPECIAL_USE = 1 shl 30
  }
}

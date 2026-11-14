package expo.modules.whisperkeepalive

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS control surface for [ModelKeepAliveService] plus a CPU wake lock.
 *
 * Everything here is synchronous and returns a boolean instead of throwing:
 * keeping the model alive is an optimization, and a failure to do so must
 * degrade to the old "release when backgrounded" behaviour, never to an error.
 */
class WhisperKeepAliveModule : Module() {
  private var wakeLock: PowerManager.WakeLock? = null
  @Volatile private var started = false
  @Volatile private var armed = false
  @Volatile private var title = "Model in memory"
  @Volatile private var text = "Ready to answer when you come back."
  private val handler = Handler(Looper.getMainLooper())
  private val timers = HashMap<String, Runnable>()

  private fun cancelTimer(id: String) {
    synchronized(timers) { timers.remove(id) }?.let { handler.removeCallbacks(it) }
  }

  private val context: Context?
    get() = appContext.reactContext?.applicationContext

  private fun startService(): Boolean {
    val ctx = context ?: return false
    return try {
      val intent = Intent(ctx, ModelKeepAliveService::class.java)
        .putExtra(ModelKeepAliveService.EXTRA_TITLE, title)
        .putExtra(ModelKeepAliveService.EXTRA_TEXT, text)
      if (Build.VERSION.SDK_INT >= 26) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
      started = true
      true
    } catch (e: Exception) {
      // ForegroundServiceStartNotAllowedException and friends: unguarded.
      false
    }
  }

  private fun stopService(): Boolean {
    val ctx = context ?: return false
    // Only when a start is outstanding: startService() on a service that is
    // not running would create it just to tear it down, and is refused
    // outright from the background.
    if (!started) return false
    started = false
    return try {
      // Delivered as a command, not stopService(): see ModelKeepAliveService.
      ctx.startService(
        Intent(ctx, ModelKeepAliveService::class.java)
          .setAction(ModelKeepAliveService.ACTION_STOP)
      )
      true
    } catch (e: Exception) {
      // Refused (background, service already gone): make sure it is down.
      try {
        ctx.stopService(Intent(ctx, ModelKeepAliveService::class.java))
      } catch (ignored: Exception) {
      }
      false
    }
  }

  override fun definition() = ModuleDefinition {
    Name("WhisperKeepAlive")

    /** Arm or disarm the guard. While armed, the service is started natively
     *  the instant the activity pauses and stopped when it resumes.
     *
     *  The start cannot be left to JS reacting to AppState: Android 12+ only
     *  accepts a foreground-service start while the app is still visible, and
     *  the 'background' event reaches JS asynchronously — by which time the
     *  activity may already be stopped. onPause runs synchronously, in time. */
    Function("arm") { on: Boolean, newTitle: String, newText: String ->
      armed = on
      title = newTitle
      text = newText
      true
    }

    /** Whether the service was started for the current off-screen period. */
    Function("isGuarding") { started }

    OnActivityEntersBackground {
      if (armed) startService()
    }

    OnActivityEntersForeground {
      stopService()
    }

    /** Stop early — the model was released, so there is nothing to guard. */
    Function("stop") { stopService() }

    Events("onTimer")

    /** A timer that fires while the app is off-screen. React Native pauses
     *  every JS setTimeout the moment the activity pauses (JavaTimerManager),
     *  foreground service or not — so "N minutes after backgrounding" cannot
     *  be expressed in JS at all. Events are still delivered; this posts one. */
    Function("schedule") { id: String, delayMs: Double ->
      cancelTimer(id)
      val task = Runnable {
        synchronized(timers) { timers.remove(id) }
        try {
          sendEvent("onTimer", mapOf("id" to id))
        } catch (e: Exception) {
          // JS side is gone; nothing to notify.
        }
      }
      synchronized(timers) { timers[id] = task }
      handler.postDelayed(task, delayMs.toLong())
      true
    }

    Function("cancel") { id: String ->
      cancelTimer(id)
      true
    }

    /** Hold the CPU awake while a generation runs with the screen off. Always
     *  acquired with a timeout, so a missed release cannot drain the battery. */
    Function("setWakeLock") { held: Boolean, timeoutMs: Double ->
      try {
        if (held) {
          val ctx = context ?: return@Function false
          val lock = wakeLock ?: (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "whisper:generation")
            .also {
              it.setReferenceCounted(false)
              wakeLock = it
            }
          lock.acquire(timeoutMs.toLong())
        } else {
          wakeLock?.let { if (it.isHeld) it.release() }
        }
        true
      } catch (e: Exception) {
        false
      }
    }

    OnDestroy {
      handler.removeCallbacksAndMessages(null)
      synchronized(timers) { timers.clear() }
      try {
        wakeLock?.let { if (it.isHeld) it.release() }
      } catch (e: Exception) {
        // already released
      }
    }
  }
}

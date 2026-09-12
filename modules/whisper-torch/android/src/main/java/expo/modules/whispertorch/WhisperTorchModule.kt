package expo.modules.whispertorch

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Rear-flash torch control. Deliberately tiny: the whole surface is
 * setTorch(on), because that is all the tool offers the model. CameraManager
 * takes the torch without opening a camera session, so this composes with the
 * camera app and costs nothing while idle.
 */
class WhisperTorchModule : Module() {
  private val cameraManager by lazy {
    appContext.reactContext?.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
  }

  override fun definition() = ModuleDefinition {
    Name("WhisperTorch")

    AsyncFunction("setTorch") { on: Boolean, promise: Promise ->
      try {
        val manager = cameraManager
          ?: throw IllegalStateException("Camera service is not available on this device.")
        val torchId = manager.cameraIdList.firstOrNull { id ->
          val chars = manager.getCameraCharacteristics(id)
          chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true &&
            chars.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
        }
        if (torchId == null) {
          promise.reject(
            CodedException("NO_FLASH", "This phone has no rear flash unit.", null)
          )
          return@AsyncFunction
        }
        manager.setTorchMode(torchId, on)
        promise.resolve(null)
      } catch (e: Exception) {
        // CameraAccessException (torch held by another client, camera disabled)
        // lands here; the message is what the tool hands back to the model.
        promise.reject(CodedException("TORCH_ERROR", e.message ?: "Could not set the torch.", e))
      }
    }
  }
}

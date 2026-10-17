package expo.modules.devicekey

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * A signing key kept in the phone's secure hardware (Android Keystore). The private key
 * never leaves the hardware, so it can't be copied to another phone. When the key is
 * created, the hardware also issues an attestation certificate chain — ending at a
 * Google root — that tells the server the key is real, was made by this app and
 * includes the server's one-time challenge.
 */
class DeviceKeyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DeviceKey")

    /** Replaces any key under [alias] with a new ECDSA P-256 key; returns its attestation chain (base64 DER, key certificate first). */
    AsyncFunction("generateKey") { alias: String, challenge: String ->
      val keyStore = keyStore()
      if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
      val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setAttestationChallenge(challenge.toByteArray(Charsets.UTF_8))
        .build()
      try {
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).run {
          initialize(spec)
          generateKeyPair()
        }
      } catch (e: Exception) {
        throw CodedException("ERR_KEY_GENERATION", "This phone could not create a secure key: ${e.message}", e)
      }
      val chain = keyStore.getCertificateChain(alias)
      if (chain == null || chain.size < 2) {
        throw CodedException("ERR_NO_ATTESTATION", "This phone does not support hardware key attestation", null)
      }
      chain.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }
    }

    AsyncFunction("hasKey") { alias: String ->
      keyStore().containsAlias(alias)
    }

    /** Signs the UTF-8 bytes of [message] with SHA-256/ECDSA; returns the DER signature, base64. */
    AsyncFunction("sign") { alias: String, message: String ->
      val key = keyStore().getKey(alias, null) as? PrivateKey
        ?: throw CodedException("ERR_KEY_MISSING", "This phone's attendance key is missing", null)
      val signature = Signature.getInstance("SHA256withECDSA").run {
        initSign(key)
        update(message.toByteArray(Charsets.UTF_8))
        sign()
      }
      Base64.encodeToString(signature, Base64.NO_WRAP)
    }

    AsyncFunction("deleteKey") { alias: String ->
      val keyStore = keyStore()
      if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
    }
  }

  private fun keyStore() = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  companion object {
    private const val KEYSTORE = "AndroidKeyStore"
  }
}

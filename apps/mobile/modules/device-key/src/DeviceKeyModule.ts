import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class DeviceKeyModule extends NativeModule {
  /** Creates a new hardware key (replacing any under `alias`); resolves to its attestation chain, base64 DER. */
  generateKey(alias: string, challenge: string): Promise<string[]>;
  hasKey(alias: string): Promise<boolean>;
  /** ECDSA P-256 / SHA-256 signature of the message's UTF-8 bytes, base64 DER. */
  sign(alias: string, message: string): Promise<string>;
  deleteKey(alias: string): Promise<void>;
}

/** The phone's hardware key, or null where it isn't available yet (iOS). */
export default requireOptionalNativeModule<DeviceKeyModule>('DeviceKey');

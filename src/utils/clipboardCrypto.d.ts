export interface EncryptedClipboard {
    ciphertext: string;
    nonce: string;
    authenticationTag: string;
    encryptionAlgorithm: "x25519-hkdf-sha256-aes-256-gcm";
    keyVersion: number;
}
/**
 * Encrypt clipboard plaintext for one target device.
 *
 * The returned ciphertext format is:
 *
 * ciphertext
 * nonce
 * authenticationTag
 *
 * The ephemeral public key is stored inside
 * the ciphertext envelope so the receiver can
 * perform X25519 during decryption.
 */
export declare function encryptClipboardForDevice(plaintext: string, targetPublicKeyBase64: string): Promise<EncryptedClipboard>;
//# sourceMappingURL=clipboardCrypto.d.ts.map
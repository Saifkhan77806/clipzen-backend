import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "node:crypto";

const INFO = new TextEncoder().encode("CLIPZEN clipboard encryption v1");

export interface EncryptedClipboard {
  ciphertext: string;
  nonce: string;
  authenticationTag: string;
  encryptionAlgorithm: "x25519-hkdf-sha256-aes-256-gcm";
  keyVersion: number;
}

/**
 * Base64 → exactly 32-byte X25519 public key.
 */
function decodePublicKey(publicKey: string): Uint8Array {
  const key = Buffer.from(publicKey, "base64");

  if (key.length !== 32) {
    throw new Error("Invalid X25519 public key length");
  }

  return new Uint8Array(key);
}

/**
 * Derive a deterministic AES-256 key from
 * an ephemeral X25519 keypair and the target
 * device's X25519 public key.
 */
function deriveEncryptionKey(
  ephemeralPrivateKey: Uint8Array,
  targetPublicKey: Uint8Array,
): Uint8Array {
  const sharedSecret = x25519.scalarMult(ephemeralPrivateKey, targetPublicKey);

  return hkdf(sha256, sharedSecret, undefined, INFO, 32);
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
export async function encryptClipboardForDevice(
  plaintext: string,
  targetPublicKeyBase64: string,
): Promise<EncryptedClipboard> {
  const targetPublicKey = decodePublicKey(targetPublicKeyBase64);

  const ephemeralPrivateKey = randomBytes(32);

  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

  const encryptionKey = deriveEncryptionKey(
    ephemeralPrivateKey,
    targetPublicKey,
  );

  const nonce = randomBytes(12);

  const plaintextBytes = new TextEncoder().encode(plaintext);

  /*
   * Web Crypto is used for AES-256-GCM.
   */
  const encryptionKeyBuffer = new Uint8Array(encryptionKey).buffer;

  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    encryptionKeyBuffer,
    {
      name: "AES-GCM",
    },
    false,
    ["encrypt"],
  );

  const encrypted = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      tagLength: 128,
    },
    cryptoKey,
    plaintextBytes,
  );

  const encryptedBytes = new Uint8Array(encrypted);

  const tagLength = 16;

  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - tagLength);

  const authenticationTag = encryptedBytes.slice(
    encryptedBytes.length - tagLength,
  );

  /*
   * Prefix the ciphertext with the
   * ephemeral public key.
   */
  const envelope = new Uint8Array(
    ephemeralPublicKey.length + ciphertext.length,
  );

  envelope.set(ephemeralPublicKey, 0);

  envelope.set(ciphertext, ephemeralPublicKey.length);

  return {
    ciphertext: Buffer.from(envelope).toString("base64"),

    nonce: Buffer.from(nonce).toString("base64"),

    authenticationTag: Buffer.from(authenticationTag).toString("base64"),

    encryptionAlgorithm: "x25519-hkdf-sha256-aes-256-gcm",

    keyVersion: 1,
  };
}

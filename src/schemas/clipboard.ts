import { z } from "zod";
import { PROTOCOL_VERSION } from "../types/protocol.js";

/*
 * Target-specific encrypted clipboard payload.
 *
 * The server stores and forwards this payload.
 * The receiving device decrypts it locally.
 */
export const encryptedClipboardPayloadSchema = z.object({
  ciphertext: z.string().min(1).max(2_000_000),

  nonce: z.string().min(1).max(256),

  authenticationTag: z.string().max(256).nullable(),

  encryptionAlgorithm: z.literal("x25519-hkdf-sha256-aes-256-gcm"),

  keyVersion: z.number().int().positive(),
});

/*
 * Server -> device realtime clipboard delivery.
 */
export const clipboardDeliverySchema = z.object({
  version: z.literal(PROTOCOL_VERSION),

  type: z.literal("clipboard.delivery"),

  messageId: z.string().uuid(),

  deliveryId: z.string().uuid(),

  clipboardItemId: z.string().uuid(),

  sourceDeviceId: z.string().uuid(),

  timestamp: z.string().datetime(),

  payload: encryptedClipboardPayloadSchema,
});

/*
 * Optional future/client -> server clipboard push protocol.
 *
 * Do not use this for the current HTTP send flow.
 *
 * Current send flow is:
 *
 * POST /v1/clipboard/send
 *        ↓
 * backend validates/encrypts/stores
 *        ↓
 * WebSocket clipboard.delivery
 */
export const clipboardPushSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),

  type: z.literal("clipboard.push"),

  messageId: z.string().uuid(),

  deviceId: z.string().uuid(),

  timestamp: z.string().datetime(),

  payload: z.object({
    text: z.string().min(1).max(1_000_000),
  }),
});

export type EncryptedClipboardPayload = z.infer<
  typeof encryptedClipboardPayloadSchema
>;

export type ClipboardDeliveryMessage = z.infer<typeof clipboardDeliverySchema>;

export type ClipboardPushMessage = z.infer<typeof clipboardPushSchema>;

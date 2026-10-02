import { z } from "zod";
import { PROTOCOL_VERSION } from "../types/protocol.js";

export const clipboardPushSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  type: z.literal("clipboard.push"),
  messageId: z.string().uuid(),
  deviceId: z.string().min(1).max(128),
  timestamp: z.string().datetime(),
  payload: z.object({
    text: z.string().min(1).max(1_000_000),
  }),
});

export type ValidatedClipboardPush = z.infer<typeof clipboardPushSchema>;

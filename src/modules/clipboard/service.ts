import type { ClipboardPushMessage } from "../../types/protocol.js";

export class ClipboardService {
  handlePush(message: ClipboardPushMessage) {
    return {
      version: message.version,
      type: "clipboard.received" as const,
      messageId: message.messageId,
      sourceDeviceId: message.deviceId,
      timestamp: new Date().toISOString(),
      payload: {
        text: message.payload.text,
      },
    };
  }
}

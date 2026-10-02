import type {
  ClipboardPushMessage,
  ClipboardReceivedMessage,
} from "../../types/protocol.js";
import type { ConnectedDevice } from "../devices/registry.js";

export class ClipboardService {
  routePush(
    message: ClipboardPushMessage,
    devices: ConnectedDevice[],
  ): ClipboardReceivedMessage[] {
    const responses: ClipboardReceivedMessage[] = [];

    for (const device of devices) {
      // Never send the clipboard back to its source device.
      if (device.deviceId === message.deviceId) {
        continue;
      }

      if (device.socket.readyState !== 1) {
        continue;
      }

      const response: ClipboardReceivedMessage = {
        version: message.version,
        type: "clipboard.received",
        messageId: message.messageId,
        sourceDeviceId: message.deviceId,
        timestamp: new Date().toISOString(),
        payload: {
          text: message.payload.text,
        },
      };

      device.socket.send(JSON.stringify(response));

      responses.push(response);
    }

    return responses;
  }
}

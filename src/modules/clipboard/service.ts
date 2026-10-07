import type {
  ClipboardDeliveryMessage,
  ClipboardPushMessage,
  ClipboardReceivedMessage,
} from "../../types/protocol.js";
import type { ConnectedDevice } from "../devices/registry.js";

export interface ClipboardDeliveryData {
  deliveryId: string;
  clipboardItemId: string;
  sourceDeviceId: string;
  ciphertext: string;
  nonce: string;
  authenticationTag: string | null;
  encryptionAlgorithm: string;
  keyVersion: number;
}

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

  deliverEncryptedClipboard(
    delivery: ClipboardDeliveryData,
    device: ConnectedDevice,
  ): ClipboardDeliveryMessage | null {
    /*
     * Never deliver to a device that is not
     * actually connected.
     */
    if (device.socket.readyState !== 1) {
      return null;
    }

    /*
     * Never deliver a clipboard item back
     * to its source device.
     */
    if (device.deviceId === delivery.sourceDeviceId) {
      return null;
    }

    const message: ClipboardDeliveryMessage = {
      version: 1,
      type: "clipboard.delivery",
      messageId: crypto.randomUUID(),
      deliveryId: delivery.deliveryId,
      clipboardItemId: delivery.clipboardItemId,
      sourceDeviceId: delivery.sourceDeviceId,
      timestamp: new Date().toISOString(),
      payload: {
        ciphertext: delivery.ciphertext,
        nonce: delivery.nonce,
        authenticationTag: delivery.authenticationTag,
        encryptionAlgorithm: delivery.encryptionAlgorithm,
        keyVersion: delivery.keyVersion,
      },
    };

    device.socket.send(JSON.stringify(message));

    return message;
  }
}

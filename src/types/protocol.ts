export const PROTOCOL_VERSION = 1 as const;

export type DevicePlatform = "android" | "windows" | "macos" | "linux" | "ios";

export interface DeviceInfo {
  deviceId: string;
  name: string;
  platform: DevicePlatform;
}

export interface ClipboardPayload {
  text: string;
}

export interface ClipboardPushMessage {
  version: typeof PROTOCOL_VERSION;
  type: "clipboard.push";
  messageId: string;
  deviceId: string;
  timestamp: string;
  payload: ClipboardPayload;
}

export interface ClipboardReceivedMessage {
  version: typeof PROTOCOL_VERSION;
  type: "clipboard.received";
  messageId: string;
  sourceDeviceId: string;
  timestamp: string;
  payload: ClipboardPayload;
}

export interface ErrorMessage {
  version: typeof PROTOCOL_VERSION;
  type: "error";
  messageId: string;
  code: string;
  message: string;
}

export interface ClipboardDeliveryMessage {
  version: typeof PROTOCOL_VERSION;
  type: "clipboard.delivery";
  messageId: string;
  deliveryId: string;
  clipboardItemId: string;
  sourceDeviceId: string;
  timestamp: string;
  payload: {
    ciphertext: string;
    nonce: string;
    authenticationTag: string | null;
    encryptionAlgorithm: string;
    keyVersion: number;
  };
}

export type ClientMessage = ClipboardPushMessage;

export type ServerMessage =
  | ClipboardReceivedMessage
  | ClipboardDeliveryMessage
  | ErrorMessage;

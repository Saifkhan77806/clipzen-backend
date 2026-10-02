import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { ClipboardService } from "../clipboard/service.js";
import { clipboardPushSchema } from "../../schemas/clipboard.js";
import { PROTOCOL_VERSION } from "../../types/protocol.js";
import type { DeviceRegistry } from "../devices/registry.js";

export async function realtimeRoutes(
  app: FastifyInstance,
  options: { deviceRegistry: DeviceRegistry },
) {
  const clipboardService = new ClipboardService();
  const { deviceRegistry } = options;

  app.get("/v1/ws", { websocket: true }, (socket, request) => {
    const connectionId = randomUUID();

    const deviceId = String(
      (request.query as { deviceId?: unknown }).deviceId ?? "",
    );

    if (!deviceId) {
      socket.close(1008, "deviceId is required");
      return;
    }

    deviceRegistry.register({
      deviceId,
      socket,
      connectedAt: new Date().toISOString(),
    });

    app.log.info({
      event: "websocket.connected",
      connectionId,
      deviceId,
    });

    socket.send(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        type: "connected",
        connectionId,
      }),
    );

    socket.on("message", (rawMessage: Buffer) => {
      try {
        const parsed: unknown = JSON.parse(rawMessage.toString("utf-8"));

        const result = clipboardPushSchema.safeParse(parsed);

        if (!result.success) {
          app.log.warn({
            event: "websocket.invalid_message",
            connectionId,
          });

          socket.send(
            JSON.stringify({
              version: PROTOCOL_VERSION,
              type: "error",
              messageId: randomUUID(),
              code: "INVALID_MESSAGE",
              message: "Invalid protocol message",
            }),
          );

          return;
        }

        const message = result.data;

        if (message.deviceId !== deviceId) {
          app.log.warn({
            event: "clipboard.device_identity_mismatch",
            connectionId,
            deviceId,
            messageDeviceId: message.deviceId,
            messageId: message.messageId,
          });

          socket.send(
            JSON.stringify({
              version: PROTOCOL_VERSION,
              type: "error",
              messageId: randomUUID(),
              code: "DEVICE_ID_MISMATCH",
              message: "Message deviceId does not match connection identity",
            }),
          );

          return;
        }

        app.log.info({
          event: "clipboard.push.received",
          connectionId,
          deviceId: message.deviceId,
          messageId: message.messageId,
        });

        const recipients = clipboardService.routePush(
          message,
          deviceRegistry.getAll(),
        );

        app.log.info({
          event: "clipboard.push.routed",
          connectionId,
          sourceDeviceId: message.deviceId,
          messageId: message.messageId,
          recipientCount: recipients.length,
        });
      } catch {
        app.log.warn({
          event: "websocket.invalid_json",
          connectionId,
        });

        socket.send(
          JSON.stringify({
            version: PROTOCOL_VERSION,
            type: "error",
            messageId: randomUUID(),
            code: "INVALID_JSON",
            message: "Invalid JSON message",
          }),
        );
      }
    });

    socket.on("close", () => {
      deviceRegistry.unregister(deviceId);

      app.log.info({
        event: "websocket.disconnected",
        connectionId,
        deviceId,
      });
    });

    socket.on("error", () => {
      app.log.error({
        event: "websocket.error",
        connectionId,
      });
    });
  });
}

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";

import { clipboardPushSchema } from "./schemas/clipboard.js";
import { PROTOCOL_VERSION } from "./types/protocol.js";

async function startServer() {
  const app = Fastify({
    logger: true,
  });

  await app.register(websocket);

  // Health endpoint
  app.get("/v1/health", async () => {
    return {
      status: "ok",
      timestamp: Date.now(),
      version: PROTOCOL_VERSION,
    };
  });

  // WebSocket API
  app.register(async function (fastify) {
    fastify.get("/v1/ws", { websocket: true }, (socket) => {
      const connectionId = randomUUID();

      app.log.info({
        event: "websocket.connected",
        connectionId,
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

          // Never log clipboard plaintext.
          app.log.info({
            event: "clipboard.push.received",
            connectionId,
            deviceId: message.deviceId,
            messageId: message.messageId,
          });

          socket.send(
            JSON.stringify({
              version: PROTOCOL_VERSION,
              type: "clipboard.received",
              messageId: message.messageId,
              sourceDeviceId: message.deviceId,
              timestamp: new Date().toISOString(),
              payload: {
                text: message.payload.text,
              },
            }),
          );
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
        app.log.info({
          event: "websocket.disconnected",
          connectionId,
        });
      });

      socket.on("error", () => {
        app.log.error({
          event: "websocket.error",
          connectionId,
        });
      });
    });
  });

  try {
    await app.listen({
      host: "0.0.0.0",
      port: 8080,
    });

    app.log.info("CLIPZEN server running on port 8080");
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

startServer();

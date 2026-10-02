import { randomUUID } from "node:crypto";
import { clipboardPushSchema } from "../../schemas/clipboard.js";
import { PROTOCOL_VERSION } from "../../types/protocol.js";
export async function realtimeRoutes(app) {
    app.get("/v1/ws", { websocket: true }, (socket) => {
        const connectionId = randomUUID();
        app.log.info({
            event: "websocket.connected",
            connectionId,
        });
        socket.send(JSON.stringify({
            version: PROTOCOL_VERSION,
            type: "connected",
            connectionId,
        }));
        socket.on("message", (rawMessage) => {
            try {
                const parsed = JSON.parse(rawMessage.toString("utf-8"));
                const result = clipboardPushSchema.safeParse(parsed);
                if (!result.success) {
                    app.log.warn({
                        event: "websocket.invalid_message",
                        connectionId,
                    });
                    socket.send(JSON.stringify({
                        version: PROTOCOL_VERSION,
                        type: "error",
                        messageId: randomUUID(),
                        code: "INVALID_MESSAGE",
                        message: "Invalid protocol message",
                    }));
                    return;
                }
                const message = result.data;
                app.log.info({
                    event: "clipboard.push.received",
                    connectionId,
                    deviceId: message.deviceId,
                    messageId: message.messageId,
                });
                socket.send(JSON.stringify({
                    version: PROTOCOL_VERSION,
                    type: "clipboard.received",
                    messageId: message.messageId,
                    sourceDeviceId: message.deviceId,
                    timestamp: new Date().toISOString(),
                    payload: {
                        text: message.payload.text,
                    },
                }));
            }
            catch {
                app.log.warn({
                    event: "websocket.invalid_json",
                    connectionId,
                });
                socket.send(JSON.stringify({
                    version: PROTOCOL_VERSION,
                    type: "error",
                    messageId: randomUUID(),
                    code: "INVALID_JSON",
                    message: "Invalid JSON message",
                }));
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
}
//# sourceMappingURL=websocket.js.map
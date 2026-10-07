import { randomUUID } from "node:crypto";
import { ClipboardService } from "../clipboard/service.js";
import { clipboardPushSchema } from "../../schemas/clipboard.js";
import { PROTOCOL_VERSION } from "../../types/protocol.js";
import { supabaseAdmin } from "../../config/clients.js";
import { authenticate } from "../../plugins/auth.js";
export async function realtimeRoutes(app, options) {
    const clipboardService = new ClipboardService();
    const { deviceRegistry } = options;
    app.get("/v1/ws", {
        websocket: true,
        preValidation: authenticate,
    }, async (socket, request) => {
        const connectionId = randomUUID();
        const deviceId = String(request.query.deviceId ?? "");
        /*
         * deviceId is still required.
         */
        if (!deviceId) {
            socket.close(1008, "deviceId is required");
            return;
        }
        /*
         * At this point authenticate() has already
         * verified the Supabase JWT and populated
         * request.userId.
         */
        const userId = request.userId;
        /*
         * Verify that the device exists and
         * belongs to the authenticated user.
         */
        const { data: device, error: deviceError } = await supabaseAdmin
            .from("devices")
            .select("id, user_id, status")
            .eq("id", deviceId)
            .maybeSingle();
        if (deviceError) {
            app.log.error({
                event: "websocket.device_lookup_failed",
                connectionId,
                deviceId,
                userId,
                error: deviceError,
            }, "CLIPZEN: Failed to lookup WebSocket device");
            socket.close(1011, "Device lookup failed");
            return;
        }
        /*
         * Device doesn't exist.
         */
        if (!device) {
            app.log.warn({
                event: "websocket.device_not_found",
                connectionId,
                deviceId,
                userId,
            });
            socket.close(1008, "Device not found");
            return;
        }
        /*
         * Device belongs to another user.
         */
        if (device.user_id !== userId) {
            app.log.warn({
                event: "websocket.device_ownership_denied",
                connectionId,
                deviceId,
                userId,
            });
            socket.close(1008, "Device ownership denied");
            return;
        }
        /*
         * Revoked/inactive devices cannot
         * establish a WebSocket connection.
         */
        if (device.status !== "active") {
            app.log.warn({
                event: "websocket.device_inactive",
                connectionId,
                deviceId,
                userId,
                status: device.status,
            });
            socket.close(1008, "Device is not active");
            return;
        }
        /*
         * Prevent an old connection from remaining
         * registered if this device connects again.
         */
        const existingConnection = deviceRegistry.get(deviceId);
        if (existingConnection) {
            try {
                existingConnection.socket.close(1000, "Replaced by newer connection");
            }
            catch {
                // Ignore errors while closing
                // the previous connection.
            }
            deviceRegistry.unregister(deviceId);
        }
        /*
         * Register authenticated device.
         */
        deviceRegistry.register({
            deviceId,
            socket,
            connectedAt: new Date().toISOString(),
        });
        app.log.info({
            event: "websocket.connected",
            connectionId,
            userId,
            deviceId,
        });
        /*
         * Tell the desktop that the authenticated
         * WebSocket connection succeeded.
         */
        socket.send(JSON.stringify({
            version: PROTOCOL_VERSION,
            type: "connected",
            connectionId,
        }));
        /*
         * Handle incoming protocol messages.
         */
        socket.on("message", (rawMessage) => {
            try {
                const parsed = JSON.parse(rawMessage.toString("utf-8"));
                const result = clipboardPushSchema.safeParse(parsed);
                if (!result.success) {
                    app.log.warn({
                        event: "websocket.invalid_message",
                        connectionId,
                        userId,
                        deviceId,
                        validationErrors: result.error.issues,
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
                /*
                 * Connection identity must match
                 * message identity.
                 */
                if (message.deviceId !== deviceId) {
                    app.log.warn({
                        event: "clipboard.device_identity_mismatch",
                        connectionId,
                        userId,
                        deviceId,
                        messageDeviceId: message.deviceId,
                        messageId: message.messageId,
                    });
                    socket.send(JSON.stringify({
                        version: PROTOCOL_VERSION,
                        type: "error",
                        messageId: randomUUID(),
                        code: "DEVICE_ID_MISMATCH",
                        message: "Message deviceId does not match connection identity",
                    }));
                    return;
                }
                app.log.info({
                    event: "clipboard.push.received",
                    connectionId,
                    userId,
                    deviceId: message.deviceId,
                    messageId: message.messageId,
                });
                const recipients = clipboardService.routePush(message, deviceRegistry.getAll());
                app.log.info({
                    event: "clipboard.push.routed",
                    connectionId,
                    userId,
                    sourceDeviceId: message.deviceId,
                    messageId: message.messageId,
                    recipientCount: recipients.length,
                });
            }
            catch {
                app.log.warn({
                    event: "websocket.invalid_json",
                    connectionId,
                    userId,
                    deviceId,
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
        /*
         * Connection closed.
         */
        socket.on("close", () => {
            /*
             * Only remove this connection if it is
             * still the active connection for the device.
             *
             * This prevents an older connection's
             * close event from deleting a newer one.
             */
            const current = deviceRegistry.get(deviceId);
            if (current?.socket === socket) {
                deviceRegistry.unregister(deviceId);
            }
            app.log.info({
                event: "websocket.disconnected",
                connectionId,
                userId,
                deviceId,
            });
        });
        socket.on("error", () => {
            app.log.error({
                event: "websocket.error",
                connectionId,
                userId,
                deviceId,
            });
        });
    });
}
//# sourceMappingURL=websocket.js.map
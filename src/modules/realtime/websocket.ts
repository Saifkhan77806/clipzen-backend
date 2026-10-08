import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { PROTOCOL_VERSION } from "../../types/protocol.js";
import type { DeviceRegistry } from "../devices/registry.js";
import { supabaseAdmin } from "../../config/clients.js";
import { authenticate } from "../../plugins/auth.js";

export async function realtimeRoutes(
  app: FastifyInstance,
  options: { deviceRegistry: DeviceRegistry },
) {
  const { deviceRegistry } = options;

  app.get(
    "/v1/ws",
    {
      websocket: true,
      preValidation: authenticate,
    },
    async (socket, request) => {
      const connectionId = randomUUID();

      /*
       * The deviceId identifies which registered
       * CLIPZEN device owns this WebSocket connection.
       */
      const deviceId = String(
        (
          request.query as {
            deviceId?: unknown;
          }
        ).deviceId ?? "",
      );

      /*
       * deviceId is required.
       */
      if (!deviceId) {
        socket.close(1008, "deviceId is required");
        return;
      }

      /*
       * authenticate() has already verified
       * the Supabase JWT and populated request.userId.
       */
      const userId = request.userId;

      /*
       * Verify that the device exists.
       */
      const { data: device, error: deviceError } = await supabaseAdmin
        .from("devices")
        .select("id, user_id, status")
        .eq("id", deviceId)
        .maybeSingle();

      if (deviceError) {
        app.log.error(
          {
            event: "websocket.device_lookup_failed",
            connectionId,
            deviceId,
            userId,
            error: deviceError,
          },
          "CLIPZEN: Failed to lookup WebSocket device",
        );

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
       * Device must belong to the authenticated user.
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
       * Revoked/inactive devices cannot connect.
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
       * If this device already has an active connection,
       * replace the old connection.
       */
      const existingConnection = deviceRegistry.get(deviceId);

      if (existingConnection) {
        try {
          existingConnection.socket.close(1000, "Replaced by newer connection");
        } catch {
          // Ignore errors while closing old connection.
        }

        deviceRegistry.unregister(deviceId);
      }

      /*
       * Register the authenticated device connection.
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
       * Confirm successful WebSocket connection.
       */
      socket.send(
        JSON.stringify({
          version: PROTOCOL_VERSION,
          type: "connected",
          connectionId,
        }),
      );

      /*
       * The server does not accept clipboard-send messages
       * through this WebSocket anymore.
       *
       * Clipboard sending is handled by:
       *
       * POST /v1/clipboard/send
       *
       * The WebSocket is used for server -> device
       * realtime clipboard.delivery messages.
       *
       * We intentionally do not register a "message"
       * handler here.
       */

      /*
       * Connection closed.
       */
      socket.on("close", () => {
        /*
         * Only unregister this connection if it is still
         * the active connection for this device.
         *
         * This prevents an older connection's close event
         * from removing a newer connection.
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

      /*
       * WebSocket error.
       */
      socket.on("error", (error: Error) => {
        app.log.error(
          {
            event: "websocket.error",
            connectionId,
            userId,
            deviceId,
            error,
          },
          "CLIPZEN: WebSocket error",
        );
      });
    },
  );
}

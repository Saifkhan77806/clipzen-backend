import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { supabaseAdmin } from "../../config/clients.js";
import { authenticate } from "../../plugins/auth.js";
import { DeviceRegistry } from "./registry.js";

const registerDeviceSchema = z.object({
  deviceId: z.string().uuid(),

  deviceName: z.string().min(1).max(128),

  platform: z.enum(["android", "windows", "macos", "linux", "ios"]),
});

const registerDeviceKeyParamsSchema = z.object({
  deviceId: z.string().uuid(),
});

const registerDeviceKeySchema = z.object({
  keyType: z.enum(["identity", "key_agreement"]),

  publicKey: z.string().min(1).max(256),

  algorithm: z.enum(["ed25519", "x25519"]),

  keyVersion: z.number().int().positive().default(1),
});

export async function deviceRoutes(
  fastify: FastifyInstance,
  options: { deviceRegistry: DeviceRegistry },
) {
  const { deviceRegistry } = options;
  /*
   * =====================================================
   * GET DEVICE LIST
   * =====================================================
   */

  /*
   * =====================================================
   * GET DEVICE LIST
   * =====================================================
   */

  fastify.get(
    "/v1/devices",
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      const userId = request.userId;

      /*
       * =====================================================
       * 1. Load all user's devices
       * =====================================================
       */

      const { data: devices, error: devicesError } = await supabaseAdmin
        .from("devices")
        .select(
          `
            id,
            device_name,
            platform,
            status,
            last_seen_at,
            created_at
          `,
        )
        .eq("user_id", userId)
        .order("created_at", {
          ascending: true,
        });

      if (devicesError) {
        request.log.error(
          {
            userId,
            error: devicesError,
          },
          "Failed to load devices",
        );

        return reply.code(500).send({
          error: "Failed to load devices",
        });
      }

      /*
       * =====================================================
       * 2. Load all trust relationships for this user
       * =====================================================
       *
       * We load both ACTIVE and REVOKED relationships.
       *
       * This allows the API to show:
       *
       *     connected
       *     revoked
       *
       * instead of losing the disconnect state.
       */

      const { data: relationships, error: relationshipsError } =
        await supabaseAdmin
          .from("device_trust_relationships")
          .select(
            `
            id,
            device_a_id,
            device_b_id,
            status,
            established_at,
            revoked_at
          `,
          )
          .eq("user_id", userId);

      if (relationshipsError) {
        request.log.error(
          {
            userId,
            error: relationshipsError,
          },
          "Failed to load device relationships",
        );

        return reply.code(500).send({
          error: "Failed to load device relationships",
        });
      }

      /*
       * =====================================================
       * 3. Build relationship status map
       * =====================================================
       *
       * Key:
       *
       *     deviceA:deviceB
       *
       * Relationship is bidirectional, so we store both
       * directions.
       *
       * Example:
       *
       *     A <-> B
       *
       * becomes:
       *
       *     A:B
       *     B:A
       */

      const relationshipMap = new Map<
        string,
        {
          status: "active" | "revoked";
          relationshipId: string;
          establishedAt: string;
          revokedAt: string | null;
        }
      >();

      for (const relationship of relationships ?? []) {
        const {
          device_a_id,
          device_b_id,
          status,
          id,
          established_at,
          revoked_at,
        } = relationship;

        const relationshipData = {
          status: status as "active" | "revoked",
          relationshipId: id,
          establishedAt: established_at,
          revokedAt: revoked_at,
        };

        relationshipMap.set(`${device_a_id}:${device_b_id}`, relationshipData);

        relationshipMap.set(`${device_b_id}:${device_a_id}`, relationshipData);
      }

      /*
       * =====================================================
       * 4. Build device response
       * =====================================================
       */

      const result = (devices ?? []).map((device) => {
        const connectedDevice = deviceRegistry.get(device.id);

        const isOnline =
          connectedDevice !== undefined &&
          connectedDevice.socket.readyState === 1;

        /*
         * Find relationships involving this device.
         */

        const deviceRelationships = (relationships ?? []).filter(
          (relationship) =>
            relationship.device_a_id === device.id ||
            relationship.device_b_id === device.id,
        );

        /*
         * -----------------------------------------------------
         * No relationship
         * -----------------------------------------------------
         */

        if (deviceRelationships.length === 0) {
          return {
            deviceId: device.id,
            deviceName: device.device_name,
            platform: device.platform,
            deviceStatus: device.status,

            connectionStatus: isOnline ? "online" : "offline",

            lastSeenAt: device.last_seen_at,
          };
        }

        /*
         * -----------------------------------------------------
         * Check active relationships
         * -----------------------------------------------------
         */

        const hasActiveRelationship = deviceRelationships.some(
          (relationship) => relationship.status === "active",
        );

        /*
         * -----------------------------------------------------
         * Check revoked relationships
         * -----------------------------------------------------
         */

        const hasRevokedRelationship = deviceRelationships.some(
          (relationship) => relationship.status === "revoked",
        );

        /*
         * ACTIVE takes precedence.
         *
         * A device can have multiple connections.
         *
         * Example:
         *
         * A <-> B = revoked
         * A <-> C = active
         *
         * B should be represented as revoked.
         * C should be represented as online/offline.
         *
         * Because this endpoint is returning one row per
         * device, the exact peer relationship cannot be
         * represented independently here without knowing
         * which device is making the request.
         */

        if (hasActiveRelationship) {
          return {
            deviceId: device.id,
            deviceName: device.device_name,
            platform: device.platform,
            deviceStatus: device.status,

            connectionStatus: isOnline ? "online" : "offline",

            lastSeenAt: device.last_seen_at,
          };
        }

        /*
         * -----------------------------------------------------
         * Only revoked relationships remain
         * -----------------------------------------------------
         */

        if (hasRevokedRelationship) {
          return {
            deviceId: device.id,
            deviceName: device.device_name,
            platform: device.platform,
            deviceStatus: device.status,

            connectionStatus: "revoked",

            lastSeenAt: device.last_seen_at,
          };
        }

        /*
         * -----------------------------------------------------
         * Fallback
         * -----------------------------------------------------
         */

        return {
          deviceId: device.id,
          deviceName: device.device_name,
          platform: device.platform,
          deviceStatus: device.status,

          connectionStatus: isOnline ? "online" : "offline",

          lastSeenAt: device.last_seen_at,
        };
      });

      /*
       * =====================================================
       * 5. Return
       * =====================================================
       */

      return reply.code(200).send({
        devices: result,
      });
    },
  );

  /*
   * =====================================================
   * REGISTER DEVICE
   * =====================================================
   */

  fastify.post(
    "/v1/devices",
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      const parsed = registerDeviceSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid device payload",
          details: parsed.error.flatten(),
        });
      }

      const { deviceId, deviceName, platform } = parsed.data;

      /*
       * Check whether the device already exists.
       */

      const { data: existingDevice, error: lookupError } = await supabaseAdmin
        .from("devices")
        .select("id, user_id, device_name, platform, status")
        .eq("id", deviceId)
        .maybeSingle();

      if (lookupError) {
        request.log.error(
          {
            error: lookupError,
          },
          "CLIPZEN: Failed to lookup device",
        );

        return reply.code(500).send({
          error: "Failed to lookup device",
        });
      }

      /*
       * Device belongs to another user.
       */

      if (existingDevice && existingDevice.user_id !== request.userId) {
        return reply.code(409).send({
          error: "Device already belongs to another user",
        });
      }

      /*
       * Existing device owned by this user.
       */

      if (existingDevice) {
        const { data: updatedDevice, error: updateError } = await supabaseAdmin
          .from("devices")
          .update({
            device_name: deviceName,
            platform,
            device_identifier: deviceId,
            status: "active",
            last_seen_at: new Date().toISOString(),
          })
          .eq("id", deviceId)
          .eq("user_id", request.userId)
          .select()
          .single();

        if (updateError) {
          request.log.error(
            {
              error: updateError,
            },
            "CLIPZEN: Failed to update device",
          );

          return reply.code(500).send({
            error: "Failed to update device",
          });
        }

        return reply.code(200).send({
          device: updatedDevice,
          created: false,
        });
      }

      /*
       * New device.
       */

      const { data: newDevice, error: insertError } = await supabaseAdmin
        .from("devices")
        .insert({
          id: deviceId,
          user_id: request.userId,
          device_name: deviceName,
          platform,
          device_identifier: deviceId,
          status: "active",
          last_seen_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (insertError) {
        request.log.error(
          {
            error: insertError,
          },
          "CLIPZEN: Failed to register device",
        );

        return reply.code(500).send({
          error: "Failed to register device",
        });
      }

      return reply.code(201).send({
        device: newDevice,
        created: true,
      });
    },
  );

  /*
   * =====================================================
   * REGISTER DEVICE PUBLIC KEY
   * =====================================================
   *
   * POST:
   * /v1/devices/:deviceId/keys
   *
   * Private keys NEVER reach this endpoint.
   */

  fastify.post(
    "/v1/devices/:deviceId/keys",
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      /*
       * Validate URL parameter.
       */

      const parsedParams = registerDeviceKeyParamsSchema.safeParse(
        request.params,
      );

      if (!parsedParams.success) {
        return reply.code(400).send({
          error: "Invalid device ID",
        });
      }

      /*
       * Validate request body.
       */

      const parsedBody = registerDeviceKeySchema.safeParse(request.body);

      if (!parsedBody.success) {
        return reply.code(400).send({
          error: "Invalid device key payload",
          details: parsedBody.error.flatten(),
        });
      }

      const { deviceId } = parsedParams.data;

      const { keyType, publicKey, algorithm, keyVersion } = parsedBody.data;

      /*
       * Make sure the key type and algorithm
       * always match.
       */

      if (keyType === "identity" && algorithm !== "ed25519") {
        return reply.code(400).send({
          error: "Identity keys must use ed25519",
        });
      }

      if (keyType === "key_agreement" && algorithm !== "x25519") {
        return reply.code(400).send({
          error: "Key agreement keys must use x25519",
        });
      }

      /*
       * Validate Base64.
       *
       * Ed25519 public key = 32 bytes.
       * X25519 public key  = 32 bytes.
       */

      const normalizedPublicKey = publicKey.replace(/\s/g, "");

      const base64Pattern =
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

      if (!base64Pattern.test(normalizedPublicKey)) {
        return reply.code(400).send({
          error: "Public key must be valid base64",
        });
      }

      const decodedKey = Buffer.from(normalizedPublicKey, "base64");

      if (decodedKey.length !== 32) {
        return reply.code(400).send({
          error: "Public key must decode to exactly 32 bytes",
        });
      }

      /*
       * Verify that the device exists.
       */

      const { data: device, error: deviceError } = await supabaseAdmin
        .from("devices")
        .select("id, user_id, status")
        .eq("id", deviceId)
        .maybeSingle();

      if (deviceError) {
        request.log.error(
          {
            error: deviceError,
          },
          "CLIPZEN: Failed to lookup device",
        );

        return reply.code(500).send({
          error: "Failed to lookup device",
        });
      }

      /*
       * Device does not exist.
       */

      if (!device) {
        return reply.code(404).send({
          error: "Device not found",
        });
      }

      /*
       * Make sure the authenticated user
       * owns this device.
       */

      if (device.user_id !== request.userId) {
        return reply.code(403).send({
          error: "You do not own this device",
        });
      }

      /*
       * Revoked devices cannot register keys.
       */

      if (device.status !== "active") {
        return reply.code(403).send({
          error: "Device is not active",
        });
      }

      /*
       * Check whether an active key with the
       * same type/version already exists.
       */

      const { data: existingKey, error: existingKeyError } = await supabaseAdmin
        .from("device_keys")
        .select(
          "id, device_id, key_type, public_key, key_version, algorithm, is_active",
        )
        .eq("device_id", deviceId)
        .eq("key_type", keyType)
        .eq("key_version", keyVersion)
        .eq("is_active", true)
        .maybeSingle();

      if (existingKeyError) {
        request.log.error(
          {
            error: existingKeyError,
          },
          "CLIPZEN: Failed to lookup existing device key",
        );

        return reply.code(500).send({
          error: "Failed to lookup existing device key",
        });
      }

      /*
       * Same public key already registered.
       *
       * This makes the endpoint idempotent.
       */

      if (existingKey) {
        if (existingKey.public_key === normalizedPublicKey) {
          return reply.code(200).send({
            key: existingKey,
            created: false,
          });
        }

        /*
         * Never silently replace an active key.
         *
         * Key rotation will be implemented
         * explicitly later.
         */

        return reply.code(409).send({
          error: "An active key already exists for this key type and version",
        });
      }

      /*
       * Insert the public key.
       */

      const { data: insertedKey, error: insertKeyError } = await supabaseAdmin
        .from("device_keys")
        .insert({
          device_id: deviceId,
          key_type: keyType,
          public_key: normalizedPublicKey,
          key_version: keyVersion,
          algorithm,
          is_active: true,
        })
        .select()
        .single();

      if (insertKeyError) {
        request.log.error(
          {
            error: insertKeyError,
          },
          "CLIPZEN: Failed to register device key",
        );

        return reply.code(500).send({
          error: "Failed to register device key",
        });
      }

      return reply.code(201).send({
        key: insertedKey,
        created: true,
      });
    },
  );

  /*
   * =====================================================
   * DISCONNECT DEVICE
   * =====================================================
   *
   * POST:
   * /v1/devices/:deviceId/disconnect
   *
   * Behavior:
   *
   * 1. Authenticate the user.
   * 2. Verify the target device belongs to the user.
   * 3. Find all active trust relationships involving
   *    the target device.
   * 4. Revoke those relationships.
   * 5. Close the device's active WebSocket connection.
   * 6. Remove the device from DeviceRegistry.
   *
   * IMPORTANT:
   *
   * The device itself remains registered and active.
   *
   * Only the trust relationships are revoked.
   *
   * Therefore the device can later connect again only
   * after a new pairing/connection flow establishes a
   * new active trust relationship.
   */
  fastify.post(
    "/v1/devices/:deviceId/disconnect",
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      /*
       * =================================================
       * 1. Validate device ID
       * =================================================
       */

      const params = request.params as {
        deviceId?: unknown;
      };

      const parsedDeviceId = z.string().uuid().safeParse(params.deviceId);

      if (!parsedDeviceId.success) {
        return reply.code(400).send({
          error: "Invalid device ID",
        });
      }

      const targetDeviceId = parsedDeviceId.data;

      /*
       * =================================================
       * 2. Load target device
       * =================================================
       */

      const { data: device, error: deviceError } = await supabaseAdmin
        .from("devices")
        .select(
          `
            id,
            user_id,
            device_name,
            platform,
            status
          `,
        )
        .eq("id", targetDeviceId)
        .maybeSingle();

      if (deviceError) {
        request.log.error(
          {
            event: "device.disconnect.lookup_failed",
            userId: request.userId,
            deviceId: targetDeviceId,
            error: deviceError,
          },
          "CLIPZEN: Failed to lookup device for disconnect",
        );

        return reply.code(500).send({
          error: "Failed to lookup device",
        });
      }

      /*
       * =================================================
       * 3. Device does not exist
       * =================================================
       */

      if (!device) {
        return reply.code(404).send({
          error: "Device not found",
        });
      }

      /*
       * =================================================
       * 4. Verify ownership
       * =================================================
       */

      if (device.user_id !== request.userId) {
        request.log.warn({
          event: "device.disconnect.ownership_denied",
          userId: request.userId,
          deviceId: targetDeviceId,
        });

        return reply.code(403).send({
          error: "You do not own this device",
        });
      }

      /*
       * =================================================
       * 5. Find active trust relationships
       * =================================================
       *
       * We only revoke ACTIVE relationships.
       *
       * Existing revoked relationships remain in the
       * database for history/auditing.
       */

      const { data: relationships, error: relationshipsError } =
        await supabaseAdmin
          .from("device_trust_relationships")
          .select(
            `
          id,
          device_a_id,
          device_b_id,
          status
        `,
          )
          .eq("user_id", request.userId)
          .eq("status", "active")
          .or(
            `device_a_id.eq.${targetDeviceId},device_b_id.eq.${targetDeviceId}`,
          );

      if (relationshipsError) {
        request.log.error(
          {
            event: "device.disconnect.relationship_lookup_failed",
            userId: request.userId,
            deviceId: targetDeviceId,
            error: relationshipsError,
          },
          "CLIPZEN: Failed to lookup device relationships",
        );

        return reply.code(500).send({
          error: "Failed to lookup device relationships",
        });
      }

      /*
       * =================================================
       * 6. Revoke active relationships
       * =================================================
       */

      const relationshipIds =
        relationships?.map((relationship) => relationship.id) ?? [];

      if (relationshipIds.length > 0) {
        const revokedAt = new Date().toISOString();

        const { error: revokeError } = await supabaseAdmin
          .from("device_trust_relationships")
          .update({
            status: "revoked",
            revoked_at: revokedAt,
          })
          .in("id", relationshipIds);

        if (revokeError) {
          request.log.error(
            {
              event: "device.disconnect.relationship_revoke_failed",
              userId: request.userId,
              deviceId: targetDeviceId,
              relationshipIds,
              error: revokeError,
            },
            "CLIPZEN: Failed to revoke device relationships",
          );

          return reply.code(500).send({
            error: "Failed to disconnect device",
          });
        }
      }

      /*
       * =================================================
       * 7. Close active WebSocket
       * =================================================
       */

      const connectedDevice = deviceRegistry.get(targetDeviceId);

      let wasConnected = false;

      if (connectedDevice) {
        wasConnected = true;

        try {
          connectedDevice.socket.close(1000, "Device disconnected");
        } catch (error) {
          /*
           * The relationship has already been revoked.
           *
           * Do not fail the whole disconnect operation
           * just because the socket close operation failed.
           */
          request.log.warn(
            {
              event: "device.disconnect.websocket_close_failed",
              userId: request.userId,
              deviceId: targetDeviceId,
              error,
            },
            "CLIPZEN: Failed to close device WebSocket",
          );
        }

        /*
         * Remove the device immediately from the registry.
         *
         * This makes the device appear offline immediately.
         */
        deviceRegistry.unregister(targetDeviceId);
      }

      /*
       * =================================================
       * 8. Log disconnect
       * =================================================
       */

      request.log.info({
        event: "device.disconnected",
        userId: request.userId,
        deviceId: targetDeviceId,
        relationshipCount: relationshipIds.length,
        wasConnected,
      });

      /*
       * =================================================
       * 9. Return result
       * =================================================
       *
       * IMPORTANT:
       *
       * deviceStatus remains whatever is stored in
       * devices.status, normally "active".
       *
       * The connection is now disconnected.
       *
       * Trust relationships are revoked.
       */

      return reply.code(200).send({
        disconnected: true,

        device: {
          deviceId: device.id,
          deviceName: device.device_name,
          platform: device.platform,
          deviceStatus: device.status,
          connectionStatus: "disconnected",
        },

        relationshipsRevoked: relationshipIds.length,

        reconnectRequired: true,
      });
    },
  );
}

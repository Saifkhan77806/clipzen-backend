import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { supabaseAdmin } from "../../config/clients.js";
import { authenticate } from "../../plugins/auth.js";

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

export async function deviceRoutes(fastify: FastifyInstance) {
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
}

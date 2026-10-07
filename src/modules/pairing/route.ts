import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { authenticate } from "../../plugins/auth.js";
import { supabaseAdmin } from "../../config/clients.js";

const acceptPairingSchema = z.object({
  deviceId: z.string().uuid(),
  pairingToken: z.string().min(1).max(512),
});

const createPairingSchema = z.object({
  deviceId: z.string().uuid(),
});

function hashPairingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function pairingRoutes(app: FastifyInstance) {
  /*
   * Create pairing token
   */
  app.post(
    "/v1/pairing/create",
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      const parsed = createPairingSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid request body",
        });
      }

      const { deviceId } = parsed.data;

      const { data: device, error: deviceError } = await supabaseAdmin
        .from("devices")
        .select("id, user_id, device_name, platform, status")
        .eq("id", deviceId)
        .maybeSingle();

      if (deviceError) {
        request.log.error(deviceError, "Failed to load device");

        return reply.code(500).send({
          error: "Failed to load device",
        });
      }

      if (!device) {
        return reply.code(404).send({
          error: "Device not found",
        });
      }

      if (device.user_id !== request.userId) {
        return reply.code(403).send({
          error: "Device does not belong to this user",
        });
      }

      if (device.status !== "active") {
        return reply.code(409).send({
          error: "Device is not active",
        });
      }

      const rawToken = randomBytes(32).toString("base64url");

      const tokenHash = hashPairingToken(rawToken);

      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      const { error: insertError } = await supabaseAdmin
        .from("device_pairing_tokens")
        .insert({
          device_id: device.id,
          token_hash: tokenHash,
          expires_at: expiresAt,
        });

      if (insertError) {
        request.log.error(insertError, "Failed to create pairing token");

        return reply.code(500).send({
          error: "Failed to create pairing token",
        });
      }

      return reply.code(201).send({
        pairingToken: rawToken,
        expiresAt,
        device: {
          deviceId: device.id,
          deviceName: device.device_name,
          platform: device.platform,
        },
      });
    },
  );

  /*
   * Accept pairing token
   */
  app.post(
    "/v1/pairing/accept",
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      const parsed = acceptPairingSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid request body",
        });
      }

      const { deviceId: acceptingDeviceId, pairingToken } = parsed.data;

      /*
       * Find the device making the pairing request.
       */
      const { data: acceptingDevice, error: deviceError } = await supabaseAdmin
        .from("devices")
        .select("id, user_id, device_name, platform, status")
        .eq("id", acceptingDeviceId)
        .maybeSingle();

      if (deviceError) {
        request.log.error(deviceError, "Failed to load accepting device");

        return reply.code(500).send({
          error: "Failed to load device",
        });
      }

      if (!acceptingDevice) {
        return reply.code(404).send({
          error: "Accepting device not found",
        });
      }

      /*
       * The authenticated user must own the accepting device.
       */
      if (acceptingDevice.user_id !== request.userId) {
        return reply.code(403).send({
          error: "Device does not belong to this user",
        });
      }

      if (acceptingDevice.status !== "active") {
        return reply.code(409).send({
          error: "Device is not active",
        });
      }

      /*
       * Hash the raw pairing token.
       *
       * The plaintext token is never stored
       * in the database.
       */
      const tokenHash = hashPairingToken(pairingToken);

      const { data: pairingRecord, error: pairingError } = await supabaseAdmin
        .from("device_pairing_tokens")
        .select(
          `
            id,
            device_id,
            expires_at,
            revoked_at,
            last_used_at
          `,
        )
        .eq("token_hash", tokenHash)
        .maybeSingle();

      if (pairingError) {
        request.log.error(pairingError, "Failed to find pairing token");

        return reply.code(500).send({
          error: "Failed to find pairing token",
        });
      }

      if (!pairingRecord) {
        return reply.code(404).send({
          error: "Invalid pairing token",
        });
      }

      /*
       * Token may only be used once.
       */
      if (pairingRecord.last_used_at) {
        return reply.code(409).send({
          error: "Pairing token has already been used",
        });
      }

      /*
       * Explicitly revoked tokens cannot be used.
       */
      if (pairingRecord.revoked_at) {
        return reply.code(409).send({
          error: "Pairing token has been revoked",
        });
      }

      /*
       * Check expiration.
       */
      if (
        pairingRecord.expires_at &&
        new Date(pairingRecord.expires_at).getTime() <= Date.now()
      ) {
        return reply.code(410).send({
          error: "Pairing token has expired",
        });
      }

      /*
       * The pairing token belongs to the
       * device that is being paired.
       */
      const sourceDeviceId = pairingRecord.device_id;

      /*
       * Prevent pairing a device with itself.
       */
      if (sourceDeviceId === acceptingDevice.id) {
        return reply.code(409).send({
          error: "A device cannot be paired with itself",
        });
      }

      /*
       * Load the device represented by the QR/token.
       */
      const { data: sourceDevice, error: sourceDeviceError } =
        await supabaseAdmin
          .from("devices")
          .select("id, user_id, device_name, platform, status")
          .eq("id", sourceDeviceId)
          .maybeSingle();

      if (sourceDeviceError) {
        request.log.error(sourceDeviceError, "Failed to load source device");

        return reply.code(500).send({
          error: "Failed to load source device",
        });
      }

      if (!sourceDevice) {
        return reply.code(404).send({
          error: "Source device not found",
        });
      }

      if (sourceDevice.status !== "active") {
        return reply.code(409).send({
          error: "Source device is not active",
        });
      }

      /*
       * Pairing is currently designed for devices
       * belonging to the same CLIPZEN account.
       */
      if (sourceDevice.user_id !== acceptingDevice.user_id) {
        return reply.code(403).send({
          error: "Devices must belong to the same user",
        });
      }

      /*
       * Check whether an active relationship
       * already exists.
       */
      const { data: existingRelationship, error: relationshipLookupError } =
        await supabaseAdmin
          .from("device_trust_relationships")
          .select("id, status, device_a_id, device_b_id")
          .eq("user_id", request.userId)
          .or(
            `and(device_a_id.eq.${sourceDeviceId},device_b_id.eq.${acceptingDevice.id}),and(device_a_id.eq.${acceptingDevice.id},device_b_id.eq.${sourceDeviceId})`,
          )
          .eq("status", "active")
          .maybeSingle();

      if (relationshipLookupError) {
        request.log.error(
          relationshipLookupError,
          "Failed to check device relationship",
        );

        return reply.code(500).send({
          error: "Failed to check device relationship",
        });
      }

      /*
       * If already paired, consume the token and
       * return the existing relationship.
       */
      if (existingRelationship) {
        const { error: consumeExistingError } = await supabaseAdmin
          .from("device_pairing_tokens")
          .update({
            last_used_at: new Date().toISOString(),
          })
          .eq("id", pairingRecord.id)
          .is("last_used_at", null);

        if (consumeExistingError) {
          request.log.error(
            consumeExistingError,
            "Failed to consume pairing token",
          );

          return reply.code(500).send({
            error: "Failed to consume pairing token",
          });
        }

        return reply.code(200).send({
          paired: true,
          alreadyPaired: true,
          relationshipId: existingRelationship.id,
          device: {
            deviceId: sourceDevice.id,
            deviceName: sourceDevice.device_name,
            platform: sourceDevice.platform,
          },
        });
      }

      /*
       * Create the trusted relationship.
       */
      const { data: relationship, error: relationshipError } =
        await supabaseAdmin
          .from("device_trust_relationships")
          .insert({
            user_id: request.userId,
            device_a_id: sourceDevice.id,
            device_b_id: acceptingDevice.id,
            status: "active",
          })
          .select("id, device_a_id, device_b_id, status, established_at")
          .single();

      if (relationshipError) {
        request.log.error(
          relationshipError,
          "Failed to create device relationship",
        );

        return reply.code(500).send({
          error: "Failed to create device relationship",
        });
      }

      /*
       * Consume the pairing token.
       */
      const { data: consumedToken, error: consumeError } = await supabaseAdmin
        .from("device_pairing_tokens")
        .update({
          last_used_at: new Date().toISOString(),
        })
        .eq("id", pairingRecord.id)
        .is("last_used_at", null)
        .select("id")
        .maybeSingle();

      if (consumeError) {
        request.log.error(consumeError, "Failed to consume pairing token");

        /*
         * The relationship was created, but the token
         * could not be consumed. We return an error so
         * this condition is visible during development.
         */
        return reply.code(500).send({
          error: "Pairing created but token could not be consumed",
        });
      }

      if (!consumedToken) {
        return reply.code(409).send({
          error: "Pairing token was already consumed",
        });
      }

      return reply.code(201).send({
        paired: true,
        alreadyPaired: false,
        relationshipId: relationship.id,
        device: {
          deviceId: sourceDevice.id,
          deviceName: sourceDevice.device_name,
          platform: sourceDevice.platform,
        },
      });
    },
  );
}

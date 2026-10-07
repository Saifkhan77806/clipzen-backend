import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "../../plugins/auth.js";
import { supabaseAdmin } from "../../config/clients.js";
import { encryptClipboardForDevice } from "../../utils/clipboardCrypto.js";

const sendClipboardSchema = z.object({
  deviceId: z.string().uuid(),

  text: z.string().min(1).max(1_000_000),
});

export async function clipboardRoutes(app: FastifyInstance) {
  app.post(
    "/v1/clipboard/send",
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      const parsed = sendClipboardSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid request body",
        });
      }

      const { deviceId: sourceDeviceId, text } = parsed.data;

      /*
       * Load source device.
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

      /*
       * Device must belong to
       * authenticated user.
       */
      if (sourceDevice.user_id !== request.userId) {
        return reply.code(403).send({
          error: "Device does not belong to this user",
        });
      }

      if (sourceDevice.status !== "active") {
        return reply.code(409).send({
          error: "Source device is not active",
        });
      }

      /*
       * Find active trust relationships
       * involving the source device.
       */
      const { data: relationships, error: relationshipsError } =
        await supabaseAdmin
          .from("device_trust_relationships")
          .select("id, device_a_id, device_b_id, status")
          .eq("user_id", request.userId)
          .eq("status", "active")
          .or(
            `device_a_id.eq.${sourceDeviceId},device_b_id.eq.${sourceDeviceId}`,
          );

      if (relationshipsError) {
        request.log.error(
          relationshipsError,
          "Failed to load device relationships",
        );

        return reply.code(500).send({
          error: "Failed to load device relationships",
        });
      }

      /*
       * Determine target device IDs.
       */
      const targetDeviceIds = (relationships ?? [])
        .map((relationship) =>
          relationship.device_a_id === sourceDeviceId
            ? relationship.device_b_id
            : relationship.device_a_id,
        )
        .filter((deviceId) => deviceId !== sourceDeviceId);

      if (targetDeviceIds.length === 0) {
        return reply.code(409).send({
          error: "No paired devices available",
        });
      }

      /*
       * Load target devices.
       */
      const { data: targetDevices, error: targetDevicesError } =
        await supabaseAdmin
          .from("devices")
          .select("id, device_name, platform, status")
          .in("id", targetDeviceIds)
          .eq("status", "active");

      if (targetDevicesError) {
        request.log.error(targetDevicesError, "Failed to load target devices");

        return reply.code(500).send({
          error: "Failed to load target devices",
        });
      }

      if (!targetDevices || targetDevices.length === 0) {
        return reply.code(409).send({
          error: "No active paired devices available",
        });
      }

      /*
       * Load active X25519 keys.
       */
      const { data: targetKeys, error: targetKeysError } = await supabaseAdmin
        .from("device_keys")
        .select("device_id, public_key, key_version, algorithm, key_type")
        .in(
          "device_id",
          targetDevices.map((device) => device.id),
        )
        .eq("key_type", "key_agreement")
        .eq("algorithm", "x25519")
        .eq("is_active", true);

      if (targetKeysError) {
        request.log.error(
          targetKeysError,
          "Failed to load target encryption keys",
        );

        return reply.code(500).send({
          error: "Failed to load target encryption keys",
        });
      }

      const keysByDeviceId = new Map(
        (targetKeys ?? []).map((key) => [key.device_id, key]),
      );

      /*
       * Encrypt once for each target device.
       */
      const encryptedTargets = [];

      for (const targetDevice of targetDevices) {
        const targetKey = keysByDeviceId.get(targetDevice.id);

        if (!targetKey) {
          request.log.warn(
            {
              deviceId: targetDevice.id,
            },
            "Target device has no active X25519 key",
          );

          continue;
        }

        try {
          const encrypted = await encryptClipboardForDevice(
            text,
            targetKey.public_key,
          );

          encryptedTargets.push({
            device: targetDevice,
            encrypted,
          });
        } catch (error) {
          request.log.error(
            {
              error,
              deviceId: targetDevice.id,
            },
            "Failed to encrypt clipboard for target device",
          );

          return reply.code(500).send({
            error: "Failed to encrypt clipboard",
          });
        }
      }

      if (encryptedTargets.length === 0) {
        return reply.code(409).send({
          error: "No paired devices have usable encryption keys",
        });
      }

      /*
       * Create one clipboard item for
       * each target because encryption is
       * target-specific.
       */
      const createdItems = [];

      for (const target of encryptedTargets) {
        const { data: clipboardItem, error: clipboardItemError } =
          await supabaseAdmin
            .from("clipboard_items")
            .insert({
              user_id: request.userId,

              source_device_id: sourceDeviceId,

              content_type: "text",

              ciphertext: target.encrypted.ciphertext,

              nonce: target.encrypted.nonce,

              authentication_tag: target.encrypted.authenticationTag,

              encryption_algorithm: target.encrypted.encryptionAlgorithm,

              key_version: target.encrypted.keyVersion,

              status: "accepted",

              accepted_at: new Date().toISOString(),
            })
            .select(
              `
                id,
                user_id,
                source_device_id,
                content_type,
                encryption_algorithm,
                key_version,
                status,
                created_at,
                accepted_at
              `,
            )
            .single();

        if (clipboardItemError) {
          request.log.error(
            {
              error: clipboardItemError,
              sourceDeviceId,
              targetDeviceId: target.device.id,
            },
            "Failed to create clipboard item",
          );

          return reply.code(500).send({
            error: "Failed to create clipboard item",
            details: clipboardItemError.message,
            code: clipboardItemError.code,
            hint: clipboardItemError.hint,
            detailsFromDatabase: clipboardItemError.details,
          });
        }

        const { data: delivery, error: deliveryError } = await supabaseAdmin
          .from("clipboard_deliveries")
          .insert({
            clipboard_item_id: clipboardItem.id,

            target_device_id: target.device.id,

            status: "pending",
          })
          .select(
            `
                id,
                clipboard_item_id,
                target_device_id,
                status,
                created_at
              `,
          )
          .single();

        if (deliveryError) {
          request.log.error(
            deliveryError,
            "Failed to create clipboard delivery",
          );

          return reply.code(500).send({
            error: "Failed to create clipboard delivery",
          });
        }

        createdItems.push({
          clipboardItem,
          delivery,
          targetDevice: {
            deviceId: target.device.id,

            deviceName: target.device.device_name,

            platform: target.device.platform,
          },
        });
      }

      return reply.code(201).send({
        sent: true,

        sourceDevice: {
          deviceId: sourceDevice.id,

          deviceName: sourceDevice.device_name,

          platform: sourceDevice.platform,
        },

        deliveries: createdItems,
      });
    },
  );
}

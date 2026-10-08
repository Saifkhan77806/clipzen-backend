import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { PROTOCOL_VERSION } from "../../types/protocol.js";
import { authenticate } from "../../plugins/auth.js";
import { supabaseAdmin } from "../../config/clients.js";
import { encryptClipboardForDevice } from "../../utils/clipboardCrypto.js";
import type { DeviceRegistry } from "../devices/registry.js";

const sendClipboardSchema = z.object({
  deviceId: z.uuid(),
  targetDeviceIds: z.array(z.uuid()).default([]),
  sendToAll: z.boolean().default(false),
  text: z.string().min(1).max(1_000_000),
});

const deliveryIdSchema = z.object({
  deliveryId: z.uuid(),
});

export async function clipboardRoutes(
  app: FastifyInstance,
  options: {
    deviceRegistry: DeviceRegistry;
  },
) {
  const { deviceRegistry } = options;

  async function recalculateClipboardItemStatus(
    clipboardItemId: string,
    userId: string,
  ) {
    const { data: clipboardItem, error: clipboardItemError } =
      await supabaseAdmin
        .from("clipboard_items")
        .select(
          `
          id,
          status,
          accepted_at,
          declined_at
        `,
        )
        .eq("id", clipboardItemId)
        .eq("user_id", userId)
        .maybeSingle();

    if (clipboardItemError) {
      throw clipboardItemError;
    }

    if (!clipboardItem) {
      return null;
    }

    const { data: deliveries, error: deliveriesError } = await supabaseAdmin
      .from("clipboard_deliveries")
      .select("status")
      .eq("clipboard_item_id", clipboardItemId);

    if (deliveriesError) {
      throw deliveriesError;
    }

    const statuses = (deliveries ?? []).map((delivery) => delivery.status);

    if (statuses.length === 0) {
      return clipboardItem.status;
    }

    const allApplied = statuses.every((status) => status === "applied");

    const allDeclined = statuses.every((status) => status === "declined");

    const allTerminal = statuses.every((status) =>
      ["applied", "declined", "failed", "cancelled"].includes(status),
    );

    const hasAccepted = statuses.some(
      (status) => status === "accepted" || status === "applied",
    );

    let nextStatus: string = "pending";

    if (allApplied) {
      nextStatus = "applied";
    } else if (allDeclined) {
      nextStatus = "declined";
    } else if (allTerminal) {
      const hasApplied = statuses.some((status) => status === "applied");

      nextStatus = hasApplied ? "accepted" : "failed";
    } else if (hasAccepted) {
      nextStatus = "accepted";
    }

    const now = new Date().toISOString();

    const update: {
      status: string;
      accepted_at?: string;
      declined_at?: string;
    } = {
      status: nextStatus,
    };

    if (hasAccepted && !clipboardItem.accepted_at) {
      update.accepted_at = now;
    }

    if (allDeclined && !clipboardItem.declined_at) {
      update.declined_at = now;
    }

    const { error: updateError } = await supabaseAdmin
      .from("clipboard_items")
      .update(update)
      .eq("id", clipboardItemId)
      .eq("user_id", userId);

    if (updateError) {
      throw updateError;
    }

    return nextStatus;
  }

  app.post(
    "/v1/clipboard/deliveries/:deliveryId/accept",
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      const params = deliveryIdSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({
          error: "Invalid delivery ID",
        });
      }

      const { deliveryId } = params.data;

      const { data: delivery, error: deliveryError } = await supabaseAdmin
        .from("clipboard_deliveries")
        .select(
          `
            id,
            clipboard_item_id,
            target_device_id,
            status,
            created_at
          `,
        )
        .eq("id", deliveryId)
        .maybeSingle();

      if (deliveryError) {
        request.log.error(deliveryError, "Failed to load clipboard delivery");

        return reply.code(500).send({
          error: "Failed to load clipboard delivery",
        });
      }

      if (!delivery) {
        return reply.code(404).send({
          error: "Clipboard delivery not found",
        });
      }

      const { data: clipboardItem, error: clipboardItemError } =
        await supabaseAdmin
          .from("clipboard_items")
          .select("id, user_id, source_device_id, status")
          .eq("id", delivery.clipboard_item_id)
          .maybeSingle();

      if (clipboardItemError) {
        request.log.error(clipboardItemError, "Failed to load clipboard item");

        return reply.code(500).send({
          error: "Failed to load clipboard item",
        });
      }

      if (!clipboardItem) {
        return reply.code(404).send({
          error: "Clipboard item not found",
        });
      }

      if (clipboardItem.user_id !== request.userId) {
        return reply.code(403).send({
          error: "Clipboard item does not belong to this user",
        });
      }

      const { data: targetDevice, error: targetDeviceError } =
        await supabaseAdmin
          .from("devices")
          .select("id, user_id, device_name, platform, status")
          .eq("id", delivery.target_device_id)
          .maybeSingle();

      if (targetDeviceError) {
        request.log.error(targetDeviceError, "Failed to load target device");

        return reply.code(500).send({
          error: "Failed to load target device",
        });
      }

      if (!targetDevice) {
        return reply.code(404).send({
          error: "Target device not found",
        });
      }

      if (targetDevice.user_id !== request.userId) {
        return reply.code(403).send({
          error: "Target device does not belong to this user",
        });
      }

      if (delivery.status !== "received") {
        return reply.code(409).send({
          error: "Delivery cannot be accepted from its current state",
          currentStatus: delivery.status,
          expectedStatus: "received",
        });
      }

      const acceptedAt = new Date().toISOString();

      const { data: updatedDelivery, error: updateError } = await supabaseAdmin
        .from("clipboard_deliveries")
        .update({
          status: "accepted",
        })
        .eq("id", deliveryId)
        .eq("status", "received")
        .select(
          `
            id,
            clipboard_item_id,
            target_device_id,
            status,
            created_at,
            delivered_at
          `,
        )
        .maybeSingle();

      if (updateError) {
        request.log.error(updateError, "Failed to accept clipboard delivery");

        return reply.code(500).send({
          error: "Failed to accept clipboard delivery",
        });
      }

      if (!updatedDelivery) {
        return reply.code(409).send({
          error: "Delivery was changed before it could be accepted",
        });
      }

      let clipboardStatus: string;

      try {
        clipboardStatus =
          (await recalculateClipboardItemStatus(
            delivery.clipboard_item_id,
            request.userId,
          )) ?? "pending";
      } catch (error) {
        request.log.error(error, "Failed to recalculate clipboard item status");

        return reply.code(500).send({
          error: "Delivery accepted but failed to update clipboard status",
        });
      }

      return reply.code(200).send({
        accepted: true,
        deliveryId: updatedDelivery.id,
        clipboardItemId: updatedDelivery.clipboard_item_id,
        status: updatedDelivery.status,
        acceptedAt,
        clipboardStatus,
      });
    },
  );

  app.post(
    "/v1/clipboard/deliveries/:deliveryId/decline",
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      const params = deliveryIdSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({
          error: "Invalid delivery ID",
        });
      }

      const { deliveryId } = params.data;

      const { data: delivery, error: deliveryError } = await supabaseAdmin
        .from("clipboard_deliveries")
        .select(
          `
            id,
            clipboard_item_id,
            target_device_id,
            status
          `,
        )
        .eq("id", deliveryId)
        .maybeSingle();

      if (deliveryError) {
        request.log.error(deliveryError, "Failed to load clipboard delivery");

        return reply.code(500).send({
          error: "Failed to load clipboard delivery",
        });
      }

      if (!delivery) {
        return reply.code(404).send({
          error: "Clipboard delivery not found",
        });
      }

      const { data: clipboardItem, error: clipboardItemError } =
        await supabaseAdmin
          .from("clipboard_items")
          .select("id, user_id")
          .eq("id", delivery.clipboard_item_id)
          .maybeSingle();

      if (clipboardItemError) {
        request.log.error(clipboardItemError, "Failed to load clipboard item");

        return reply.code(500).send({
          error: "Failed to load clipboard item",
        });
      }

      if (!clipboardItem) {
        return reply.code(404).send({
          error: "Clipboard item not found",
        });
      }

      if (clipboardItem.user_id !== request.userId) {
        return reply.code(403).send({
          error: "Clipboard item does not belong to this user",
        });
      }

      const { data: targetDevice, error: targetDeviceError } =
        await supabaseAdmin
          .from("devices")
          .select("id, user_id")
          .eq("id", delivery.target_device_id)
          .maybeSingle();

      if (targetDeviceError) {
        request.log.error(targetDeviceError, "Failed to load target device");

        return reply.code(500).send({
          error: "Failed to load target device",
        });
      }

      if (!targetDevice) {
        return reply.code(404).send({
          error: "Target device not found",
        });
      }

      if (targetDevice.user_id !== request.userId) {
        return reply.code(403).send({
          error: "Target device does not belong to this user",
        });
      }

      if (delivery.status !== "received") {
        return reply.code(409).send({
          error: "Delivery cannot be declined from its current state",
          currentStatus: delivery.status,
          expectedStatus: "received",
        });
      }

      const { data: updatedDelivery, error: updateError } = await supabaseAdmin
        .from("clipboard_deliveries")
        .update({
          status: "declined",
        })
        .eq("id", deliveryId)
        .eq("status", "received")
        .select(
          `
            id,
            clipboard_item_id,
            target_device_id,
            status,
            created_at,
            delivered_at
          `,
        )
        .maybeSingle();

      if (updateError) {
        request.log.error(updateError, "Failed to decline clipboard delivery");

        return reply.code(500).send({
          error: "Failed to decline clipboard delivery",
        });
      }

      if (!updatedDelivery) {
        return reply.code(409).send({
          error: "Delivery was changed before it could be declined",
        });
      }

      let clipboardStatus: string;

      try {
        clipboardStatus =
          (await recalculateClipboardItemStatus(
            delivery.clipboard_item_id,
            request.userId,
          )) ?? "pending";
      } catch (error) {
        request.log.error(error, "Failed to recalculate clipboard item status");

        return reply.code(500).send({
          error: "Delivery declined but failed to update clipboard status",
        });
      }

      return reply.code(200).send({
        declined: true,
        deliveryId: updatedDelivery.id,
        clipboardItemId: updatedDelivery.clipboard_item_id,
        status: updatedDelivery.status,
        clipboardStatus,
      });
    },
  );

  app.post(
    "/v1/clipboard/deliveries/:deliveryId/applied",
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      const params = deliveryIdSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({
          error: "Invalid delivery ID",
        });
      }

      const { deliveryId } = params.data;

      const { data: delivery, error: deliveryError } = await supabaseAdmin
        .from("clipboard_deliveries")
        .select(
          `
            id,
            clipboard_item_id,
            target_device_id,
            status
          `,
        )
        .eq("id", deliveryId)
        .maybeSingle();

      if (deliveryError) {
        request.log.error(deliveryError, "Failed to load clipboard delivery");

        return reply.code(500).send({
          error: "Failed to load clipboard delivery",
        });
      }

      if (!delivery) {
        return reply.code(404).send({
          error: "Clipboard delivery not found",
        });
      }

      const { data: clipboardItem, error: clipboardItemError } =
        await supabaseAdmin
          .from("clipboard_items")
          .select("id, user_id")
          .eq("id", delivery.clipboard_item_id)
          .maybeSingle();

      if (clipboardItemError) {
        request.log.error(clipboardItemError, "Failed to load clipboard item");

        return reply.code(500).send({
          error: "Failed to load clipboard item",
        });
      }

      if (!clipboardItem) {
        return reply.code(404).send({
          error: "Clipboard item not found",
        });
      }

      if (clipboardItem.user_id !== request.userId) {
        return reply.code(403).send({
          error: "Clipboard item does not belong to this user",
        });
      }

      const { data: targetDevice, error: targetDeviceError } =
        await supabaseAdmin
          .from("devices")
          .select("id, user_id")
          .eq("id", delivery.target_device_id)
          .maybeSingle();

      if (targetDeviceError) {
        request.log.error(targetDeviceError, "Failed to load target device");

        return reply.code(500).send({
          error: "Failed to load target device",
        });
      }

      if (!targetDevice) {
        return reply.code(404).send({
          error: "Target device not found",
        });
      }

      if (targetDevice.user_id !== request.userId) {
        return reply.code(403).send({
          error: "Target device does not belong to this user",
        });
      }

      if (delivery.status !== "accepted") {
        return reply.code(409).send({
          error: "Delivery cannot be marked applied from its current state",
          currentStatus: delivery.status,
          expectedStatus: "accepted",
        });
      }

      const { data: updatedDelivery, error: updateError } = await supabaseAdmin
        .from("clipboard_deliveries")
        .update({
          status: "applied",
        })
        .eq("id", deliveryId)
        .eq("status", "accepted")
        .select(
          `
            id,
            clipboard_item_id,
            target_device_id,
            status,
            created_at,
            delivered_at
          `,
        )
        .maybeSingle();

      if (updateError) {
        request.log.error(
          updateError,
          "Failed to mark clipboard delivery as applied",
        );

        return reply.code(500).send({
          error: "Failed to mark clipboard delivery as applied",
        });
      }

      if (!updatedDelivery) {
        return reply.code(409).send({
          error: "Delivery was changed before it could be marked applied",
        });
      }

      let clipboardStatus: string;

      try {
        clipboardStatus =
          (await recalculateClipboardItemStatus(
            delivery.clipboard_item_id,
            request.userId,
          )) ?? "pending";
      } catch (error) {
        request.log.error(error, "Failed to recalculate clipboard item status");

        return reply.code(500).send({
          error: "Delivery applied but failed to update clipboard status",
        });
      }

      return reply.code(200).send({
        applied: true,
        deliveryId: updatedDelivery.id,
        clipboardItemId: updatedDelivery.clipboard_item_id,
        status: updatedDelivery.status,
        clipboardStatus,
      });
    },
  );

  app.get(
    "/v1/clipboard/:clipboardItemId/status",
    {
      preHandler: authenticate,
    },
    async (request, reply) => {
      const params = z
        .object({
          clipboardItemId: z.uuid(),
        })
        .safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({
          error: "Invalid clipboard item ID",
        });
      }

      const { clipboardItemId } = params.data;

      const { data: clipboardItem, error: clipboardItemError } =
        await supabaseAdmin
          .from("clipboard_items")
          .select(
            `
            id,
            user_id,
            source_device_id,
            status,
            created_at,
            accepted_at,
            declined_at
          `,
          )
          .eq("id", clipboardItemId)
          .maybeSingle();

      if (clipboardItemError) {
        request.log.error(
          clipboardItemError,
          "Failed to load clipboard item status",
        );

        return reply.code(500).send({
          error: "Failed to load clipboard item status",
        });
      }

      if (!clipboardItem) {
        return reply.code(404).send({
          error: "Clipboard item not found",
        });
      }

      if (clipboardItem.user_id !== request.userId) {
        return reply.code(403).send({
          error: "Clipboard item does not belong to this user",
        });
      }

      const { data: deliveries, error: deliveriesError } = await supabaseAdmin
        .from("clipboard_deliveries")
        .select(
          `
            id,
            target_device_id,
            status,
            created_at,
            delivered_at,
            failed_at,
            error_message
          `,
        )
        .eq("clipboard_item_id", clipboardItemId)
        .order("created_at", {
          ascending: true,
        });

      if (deliveriesError) {
        request.log.error(
          deliveriesError,
          "Failed to load clipboard deliveries",
        );

        return reply.code(500).send({
          error: "Failed to load clipboard deliveries",
        });
      }

      return reply.code(200).send({
        clipboardItemId: clipboardItem.id,
        status: clipboardItem.status,
        createdAt: clipboardItem.created_at,
        acceptedAt: clipboardItem.accepted_at,
        declinedAt: clipboardItem.declined_at,

        deliveries: (deliveries ?? []).map((delivery) => ({
          deliveryId: delivery.id,
          targetDeviceId: delivery.target_device_id,
          status: delivery.status,
          createdAt: delivery.created_at,
          deliveredAt: delivery.delivered_at,
          failedAt: delivery.failed_at,
          errorMessage: delivery.error_message,
        })),
      });
    },
  );

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

      const { deviceId, targetDeviceIds, sendToAll, text } = parsed.data;

      /*
       * ---------------------------------------------------------
       * 1. Load source device
       * ---------------------------------------------------------
       */

      const { data: sourceDevice, error: sourceDeviceError } =
        await supabaseAdmin
          .from("devices")
          .select("id, user_id, device_name, platform, status")
          .eq("id", deviceId)
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
       * ---------------------------------------------------------
       * 2. Verify source device ownership
       * ---------------------------------------------------------
       */

      if (sourceDevice.user_id !== request.userId) {
        return reply.code(403).send({
          error: "Device does not belong to this user",
        });
      }

      /*
       * ---------------------------------------------------------
       * 3. Source device must be active
       * ---------------------------------------------------------
       */

      if (sourceDevice.status !== "active") {
        return reply.code(409).send({
          error: "Source device is not active",
        });
      }

      /*
       * ---------------------------------------------------------
       * 4. Load active trust relationships
       * ---------------------------------------------------------
       */

      const { data: relationships, error: relationshipsError } =
        await supabaseAdmin
          .from("device_trust_relationships")
          .select("id, device_a_id, device_b_id, status")
          .eq("user_id", request.userId)
          .eq("status", "active")
          .or(`device_a_id.eq.${deviceId},device_b_id.eq.${deviceId}`);

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
       * ---------------------------------------------------------
       * 5. Build paired-device set
       * ---------------------------------------------------------
       */

      const pairedDeviceIds = new Set<string>();

      for (const relationship of relationships ?? []) {
        const peerDeviceId =
          relationship.device_a_id === deviceId
            ? relationship.device_b_id
            : relationship.device_a_id;

        if (peerDeviceId !== deviceId) {
          pairedDeviceIds.add(peerDeviceId);
        }
      }

      /*
       * ---------------------------------------------------------
       * 6. Determine target devices
       * ---------------------------------------------------------
       */

      let selectedTargetDeviceIds: string[];

      if (sendToAll) {
        selectedTargetDeviceIds = [...pairedDeviceIds];
      } else {
        if (targetDeviceIds.length === 0) {
          return reply.code(400).send({
            error:
              "At least one targetDeviceId is required when sendToAll is false",
          });
        }

        selectedTargetDeviceIds = [...new Set(targetDeviceIds)];
      }

      if (selectedTargetDeviceIds.length === 0) {
        return reply.code(409).send({
          error: "No paired devices available",
        });
      }

      /*
       * ---------------------------------------------------------
       * 7. Load target devices
       * ---------------------------------------------------------
       */

      const { data: targetDevices, error: targetDevicesError } =
        await supabaseAdmin
          .from("devices")
          .select("id, user_id, device_name, platform, status")
          .in("id", selectedTargetDeviceIds);

      if (targetDevicesError) {
        request.log.error(targetDevicesError, "Failed to load target devices");

        return reply.code(500).send({
          error: "Failed to load target devices",
        });
      }

      const targetDeviceMap = new Map(
        (targetDevices ?? []).map((device) => [device.id, device]),
      );

      /*
       * ---------------------------------------------------------
       * 8. Validate every requested target
       * ---------------------------------------------------------
       */

      const invalidTargetDeviceIds = selectedTargetDeviceIds.filter(
        (targetId) => {
          const targetDevice = targetDeviceMap.get(targetId);

          if (!targetDevice) {
            return true;
          }

          if (targetDevice.user_id !== request.userId) {
            return true;
          }

          if (targetDevice.status !== "active") {
            return true;
          }

          if (!pairedDeviceIds.has(targetId)) {
            return true;
          }

          return false;
        },
      );

      if (invalidTargetDeviceIds.length > 0) {
        return reply.code(400).send({
          error: "One or more target devices are invalid",
          invalidTargetDeviceIds,
        });
      }

      const activeTargetDevices = selectedTargetDeviceIds.map(
        (targetId) => targetDeviceMap.get(targetId)!,
      );

      if (activeTargetDevices.length === 0) {
        return reply.code(409).send({
          error: "No active paired devices available",
        });
      }

      /*
       * ---------------------------------------------------------
       * 9. Load active X25519 keys
       * ---------------------------------------------------------
       */

      const { data: targetKeys, error: targetKeysError } = await supabaseAdmin
        .from("device_keys")
        .select("device_id, public_key, key_version, algorithm, key_type")
        .in(
          "device_id",
          activeTargetDevices.map((device) => device.id),
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
       * ---------------------------------------------------------
       * 10. Encrypt separately for every target
       * ---------------------------------------------------------
       *
       * IMPORTANT:
       * The encryption is target-specific.
       * Therefore the encrypted payload belongs to
       * clipboard_deliveries, NOT clipboard_items.
       * ---------------------------------------------------------
       */

      const encryptedTargets: Array<{
        device: {
          id: string;
          user_id: string;
          device_name: string;
          platform: string;
          status: string;
        };
        encrypted: {
          ciphertext: string;
          nonce: string;
          authenticationTag: string;
          encryptionAlgorithm: "x25519-hkdf-sha256-aes-256-gcm";
          keyVersion: number;
        };
      }> = [];

      const targetsWithoutKeys: string[] = [];

      for (const targetDevice of activeTargetDevices) {
        const targetKey = keysByDeviceId.get(targetDevice.id);

        if (!targetKey) {
          targetsWithoutKeys.push(targetDevice.id);
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

      if (targetsWithoutKeys.length > 0) {
        return reply.code(409).send({
          error: "One or more target devices have no usable encryption key",
          targetDeviceIds: targetsWithoutKeys,
        });
      }

      if (encryptedTargets.length === 0) {
        return reply.code(409).send({
          error: "No paired devices have usable encryption keys",
        });
      }

      /*
       * ---------------------------------------------------------
       * 11. Create ONE clipboard item
       * ---------------------------------------------------------
       *
       * The clipboard item represents the user's single
       * clipboard-send action.
       *
       * Target-specific encrypted data is stored on the
       * individual clipboard_deliveries rows.
       * ---------------------------------------------------------
       */

      const { data: clipboardItem, error: clipboardItemError } =
        await supabaseAdmin
          .from("clipboard_items")
          .insert({
            user_id: request.userId,
            source_device_id: deviceId,
            content_type: "text",

            /*
             * These fields are intentionally null because
             * encryption is target-specific and therefore
             * stored on clipboard_deliveries.
             */
            ciphertext: null,
            nonce: null,
            authentication_tag: null,
            encryption_algorithm: "x25519-hkdf-sha256-aes-256-gcm",
            key_version: 1,

            status: "pending",
            accepted_at: null,
            declined_at: null,
          })
          .select(
            `
            id,
            user_id,
            source_device_id,
            content_type,
            status,
            created_at,
            accepted_at,
            declined_at
          `,
          )
          .single();

      if (clipboardItemError) {
        request.log.error(
          {
            error: clipboardItemError,
            deviceId,
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

      /*
       * ---------------------------------------------------------
       * 12. Create delivery rows
       * ---------------------------------------------------------
       *
       * One delivery per target.
       *
       * Each delivery owns its own encrypted payload.
       * ---------------------------------------------------------
       */

      const createdDeliveries: Array<{
        deliveryId: string;
        clipboardItemId: string;
        targetDeviceId: string;
        targetDeviceName: string;
        platform: string;
        status: string;
        createdAt: string;
      }> = [];

      for (const target of encryptedTargets) {
        const { data: delivery, error: deliveryError } = await supabaseAdmin
          .from("clipboard_deliveries")
          .insert({
            clipboard_item_id: clipboardItem.id,

            target_device_id: target.device.id,

            status: "pending",

            /*
             * Target-specific encrypted payload.
             */
            ciphertext: target.encrypted.ciphertext,

            nonce: target.encrypted.nonce,

            authentication_tag: target.encrypted.authenticationTag,

            encryption_algorithm: target.encrypted.encryptionAlgorithm,

            key_version: target.encrypted.keyVersion,
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
            {
              error: deliveryError,
              clipboardItemId: clipboardItem.id,
              targetDeviceId: target.device.id,
            },
            "Failed to create clipboard delivery",
          );

          /*
           * Mark the clipboard item failed because we could
           * not create all requested delivery records.
           */
          await supabaseAdmin
            .from("clipboard_items")
            .update({
              status: "failed",
            })
            .eq("id", clipboardItem.id);

          return reply.code(500).send({
            error: "Failed to create clipboard delivery",
            details: deliveryError.message,
          });
        }

        createdDeliveries.push({
          deliveryId: delivery.id,
          clipboardItemId: delivery.clipboard_item_id,
          targetDeviceId: delivery.target_device_id,
          targetDeviceName: target.device.device_name,
          platform: target.device.platform,
          status: delivery.status,
          createdAt: delivery.created_at,
        });
      }

      /*
       * ---------------------------------------------------------
       * 13. Realtime delivery
       * ---------------------------------------------------------
       *
       * The server sends the encrypted delivery to the target
       * device if that device currently has an active WebSocket
       * connection.
       *
       * If the device is offline:
       *
       *     pending
       *
       * remains in the database for later synchronization.
       * ---------------------------------------------------------
       */

      let sentCount = 0;
      let pendingCount = 0;

      for (const target of encryptedTargets) {
        const createdDelivery = createdDeliveries.find(
          (delivery) => delivery.targetDeviceId === target.device.id,
        );

        if (!createdDelivery) {
          request.log.error(
            {
              clipboardItemId: clipboardItem.id,
              targetDeviceId: target.device.id,
            },
            "Failed to find created clipboard delivery",
          );

          continue;
        }

        /*
         * Re-check the trust relationship immediately before
         * realtime delivery.
         *
         * This prevents a relationship revoked after the
         * initial validation from receiving a new realtime
         * delivery.
         */
        const { data: currentRelationship, error: currentRelationshipError } =
          await supabaseAdmin
            .from("device_trust_relationships")
            .select("id")
            .eq("user_id", request.userId)
            .eq("status", "active")
            .or(
              [
                `and(device_a_id.eq.${deviceId},device_b_id.eq.${target.device.id})`,
                `and(device_a_id.eq.${target.device.id},device_b_id.eq.${deviceId})`,
              ].join(","),
            )
            .maybeSingle();

        if (currentRelationshipError) {
          request.log.error(
            {
              error: currentRelationshipError,
              clipboardItemId: clipboardItem.id,
              deliveryId: createdDelivery.deliveryId,
              targetDeviceId: target.device.id,
            },
            "Failed to re-check clipboard trust relationship",
          );

          await supabaseAdmin
            .from("clipboard_deliveries")
            .update({
              status: "failed",
              failed_at: new Date().toISOString(),
              error_message: "Failed to verify device trust relationship",
            })
            .eq("id", createdDelivery.deliveryId);

          continue;
        }

        if (!currentRelationship) {
          await supabaseAdmin
            .from("clipboard_deliveries")
            .update({
              status: "cancelled",
              failed_at: new Date().toISOString(),
              error_message: "Device trust relationship is no longer active",
            })
            .eq("id", createdDelivery.deliveryId);

          continue;
        }

        /*
         * Build the server -> device delivery message.
         *
         * IMPORTANT:
         * No plaintext clipboard text is sent here.
         */
        const deliveryMessage = {
          version: PROTOCOL_VERSION,

          type: "clipboard.delivery" as const,

          messageId: randomUUID(),

          deliveryId: createdDelivery.deliveryId,

          clipboardItemId: clipboardItem.id,

          sourceDeviceId: deviceId,

          timestamp: new Date().toISOString(),

          payload: {
            ciphertext: target.encrypted.ciphertext,

            nonce: target.encrypted.nonce,

            authenticationTag: target.encrypted.authenticationTag,

            encryptionAlgorithm: target.encrypted.encryptionAlgorithm,

            keyVersion: target.encrypted.keyVersion,
          },
        };

        const sent = deviceRegistry.send(target.device.id, deliveryMessage);

        if (sent) {
          const deliveredAt = new Date().toISOString();

          const { error: updateError } = await supabaseAdmin
            .from("clipboard_deliveries")
            .update({
              status: "sent",
              delivered_at: deliveredAt,
              failed_at: null,
              error_message: null,
            })
            .eq("id", createdDelivery.deliveryId);

          if (updateError) {
            request.log.error(
              {
                error: updateError,
                deliveryId: createdDelivery.deliveryId,
              },
              "Failed to update delivery status after WebSocket send",
            );
          } else {
            createdDelivery.status = "sent";

            sentCount++;
          }
        } else {
          /*
           * Device is currently offline.
           *
           * Keep delivery as pending so the
           * synchronization process can recover it later.
           */
          pendingCount++;
        }
      }

      /*
       * ---------------------------------------------------------
       * 14. Final response
       * ---------------------------------------------------------
       */

      return reply.code(201).send({
        sent: sentCount > 0,

        clipboardItemId: clipboardItem.id,

        sourceDevice: {
          deviceId: sourceDevice.id,

          deviceName: sourceDevice.device_name,

          platform: sourceDevice.platform,
        },

        deliverySummary: {
          total: createdDeliveries.length,

          sent: sentCount,

          pending: pendingCount,
        },

        deliveries: createdDeliveries.map((delivery) => ({
          deliveryId: delivery.deliveryId,

          clipboardItemId: delivery.clipboardItemId,

          targetDeviceId: delivery.targetDeviceId,

          targetDeviceName: delivery.targetDeviceName,

          platform: delivery.platform,

          status: delivery.status,

          createdAt: delivery.createdAt,
        })),
      });
    },
  );
}

import type { WebSocket } from "@fastify/websocket";
import { supabaseAdmin } from "../../config/clients.js";
import type { ClipboardDeliveryMessage } from "../../types/protocol.js";

interface DeliverClipboardParams {
  deliveryId: string;
  clipboardItemId: string;
  targetDeviceId: string;
}

export async function deliverClipboardToDevice(
  socket: WebSocket,
  params: DeliverClipboardParams,
): Promise<void> {
  const { deliveryId, clipboardItemId, targetDeviceId } = params;

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
    .eq("clipboard_item_id", clipboardItemId)
    .eq("target_device_id", targetDeviceId)
    .maybeSingle();

  if (deliveryError) {
    throw new Error(
      `Failed to load clipboard delivery: ${deliveryError.message}`,
    );
  }

  if (!delivery) {
    throw new Error("Clipboard delivery not found");
  }

  if (delivery.status !== "pending") {
    throw new Error(`Clipboard delivery is not pending: ${delivery.status}`);
  }

  const { data: clipboardItem, error: clipboardItemError } = await supabaseAdmin
    .from("clipboard_items")
    .select(
      `
          id,
          source_device_id,
          ciphertext,
          nonce,
          authentication_tag,
          encryption_algorithm,
          key_version
        `,
    )
    .eq("id", clipboardItemId)
    .maybeSingle();

  if (clipboardItemError) {
    throw new Error(
      `Failed to load clipboard item: ${clipboardItemError.message}`,
    );
  }

  if (!clipboardItem) {
    throw new Error("Clipboard item not found");
  }

  const message: ClipboardDeliveryMessage = {
    version: 1,
    type: "clipboard.delivery",
    messageId: crypto.randomUUID(),
    deliveryId: delivery.id,
    clipboardItemId: clipboardItem.id,
    sourceDeviceId: clipboardItem.source_device_id,
    timestamp: new Date().toISOString(),
    payload: {
      ciphertext: clipboardItem.ciphertext,
      nonce: clipboardItem.nonce,
      authenticationTag: clipboardItem.authentication_tag,
      encryptionAlgorithm: clipboardItem.encryption_algorithm,
      keyVersion: clipboardItem.key_version,
    },
  };

  socket.send(JSON.stringify(message));

  const { error: updateError } = await supabaseAdmin
    .from("clipboard_deliveries")
    .update({
      status: "delivered",
      delivered_at: new Date().toISOString(),
    })
    .eq("id", delivery.id)
    .eq("status", "pending");

  if (updateError) {
    throw new Error(
      `Failed to update clipboard delivery: ${updateError.message}`,
    );
  }
}

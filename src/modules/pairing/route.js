import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "../../config/clients";
import { authenticate } from "../../plugins/auth";
const createPairingSchema = z.object({
    deviceId: z.string().uuid(),
});
function hashPairingToken(token) {
    return createHash("sha256").update(token).digest("hex");
}
export async function pairingRoutes(app) {
    app.post("/v1/pairing/create", {
        preHandler: authenticate,
    }, async (request, reply) => {
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
    });
}
//# sourceMappingURL=route.js.map
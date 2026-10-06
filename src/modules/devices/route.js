import { z } from "zod";
import { supabaseAdmin } from "../../config/clients.js";
import { authenticate } from "../../plugins/auth.js";
const registerDeviceSchema = z.object({
    deviceId: z.string().uuid(),
    deviceName: z
        .string()
        .min(1)
        .max(128),
    platform: z.enum([
        "android",
        "windows",
        "macos",
        "linux",
        "ios",
    ]),
});
export async function deviceRoutes(fastify) {
    fastify.post("/v1/devices", {
        preHandler: authenticate,
    }, async (request, reply) => {
        const parsed = registerDeviceSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "Invalid device payload",
                details: parsed.error.flatten(),
            });
        }
        const { deviceId, deviceName, platform, } = parsed.data;
        /*
         * Check whether this device already exists.
         */
        const { data: existingDevice, error: lookupError, } = await supabaseAdmin
            .from("devices")
            .select("id, user_id, device_name, platform, status")
            .eq("id", deviceId)
            .maybeSingle();
        if (lookupError) {
            request.log.error({
                error: lookupError,
            }, "CLIPZEN: Failed to lookup device");
            return reply.code(500).send({
                error: "Failed to lookup device",
            });
        }
        /*
         * Device UUID already belongs to another user.
         */
        if (existingDevice &&
            existingDevice.user_id !==
                request.userId) {
            return reply.code(409).send({
                error: "Device already belongs to another user",
            });
        }
        /*
         * Existing device owned by this user.
         *
         * Re-register/update it instead of creating
         * a new device.
         */
        if (existingDevice) {
            const { data: updatedDevice, error: updateError, } = await supabaseAdmin
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
                request.log.error({
                    error: updateError,
                }, "CLIPZEN: Failed to update device");
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
        const { data: newDevice, error: insertError, } = await supabaseAdmin
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
            request.log.error({
                error: insertError,
            }, "CLIPZEN: Failed to register device");
            return reply.code(500).send({
                error: "Failed to register device",
            });
        }
        return reply.code(201).send({
            device: newDevice,
            created: true,
        });
    });
}
//# sourceMappingURL=route.js.map
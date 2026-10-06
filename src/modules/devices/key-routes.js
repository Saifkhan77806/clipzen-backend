import { z } from "zod";
import { supabaseAdmin } from "../../config/clients.js";
import { authenticate } from "../../plugins/auth.js";
const registerDeviceKeySchema = z.object({
    deviceId: z.uuid(),
    keyType: z.enum(["identity", "key_agreement"]),
    algorithm: z.enum(["ed25519", "x25519"]),
    publicKey: z.string().min(1).max(2048),
    keyVersion: z.number().int().positive(),
});
export async function deviceKeyRoutes(fastify) {
    fastify.post("/v1/devices/:deviceId/keys", {
        preHandler: authenticate,
    }, async (request, reply) => {
        const paramsSchema = z.object({
            deviceId: z.string().uuid(),
        });
        const bodySchema = z.object({
            keyType: z.enum(["identity", "key_agreement"]),
            publicKey: z.string().min(1).max(256),
            algorithm: z.enum(["ed25519", "x25519"]),
            keyVersion: z.number().int().positive().default(1),
        });
        const parsedParams = paramsSchema.safeParse(request.params);
        if (!parsedParams.success) {
            return reply.code(400).send({
                error: "Invalid device ID",
            });
        }
        const parsedBody = bodySchema.safeParse(request.body);
        if (!parsedBody.success) {
            return reply.code(400).send({
                error: "Invalid device key payload",
                details: parsedBody.error.flatten(),
            });
        }
        const { deviceId } = parsedParams.data;
        const { keyType, publicKey, algorithm, keyVersion } = parsedBody.data;
        /*
         * Make sure key type and algorithm
         * cannot be mismatched.
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
         * Decode the public key.
         */
        let decodedKey;
        try {
            decodedKey = Buffer.from(publicKey, "base64");
        }
        catch {
            return reply.code(400).send({
                error: "Public key is not valid base64",
            });
        }
        /*
         * Both Ed25519 and X25519 public keys
         * are exactly 32 bytes.
         */
        if (decodedKey.length !== 32) {
            return reply.code(400).send({
                error: "Public key must decode to 32 bytes",
            });
        }
        /*
         * Verify device ownership.
         */
        const { data: device, error: deviceError } = await supabaseAdmin
            .from("devices")
            .select("id, user_id, status")
            .eq("id", deviceId)
            .maybeSingle();
        if (deviceError) {
            request.log.error({
                error: deviceError,
            }, "CLIPZEN: Failed to lookup device");
            return reply.code(500).send({
                error: "Failed to lookup device",
            });
        }
        if (!device) {
            return reply.code(404).send({
                error: "Device not found",
            });
        }
        if (device.user_id !== request.userId) {
            return reply.code(403).send({
                error: "You do not own this device",
            });
        }
        if (device.status !== "active") {
            return reply.code(403).send({
                error: "Device is not active",
            });
        }
        /*
         * Check whether this key already exists.
         */
        const { data: existingKey, error: existingKeyError } = await supabaseAdmin
            .from("device_keys")
            .select("id, public_key, key_version, algorithm, is_active")
            .eq("device_id", deviceId)
            .eq("key_type", keyType)
            .eq("key_version", keyVersion)
            .eq("is_active", true)
            .maybeSingle();
        if (existingKeyError) {
            request.log.error({
                error: existingKeyError,
            }, "CLIPZEN: Failed to lookup existing device key");
            return reply.code(500).send({
                error: "Failed to lookup existing device key",
            });
        }
        /*
         * Same key registration is idempotent.
         */
        if (existingKey) {
            if (existingKey.public_key === publicKey) {
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
         * Insert public key.
         */
        const { data: insertedKey, error: insertError } = await supabaseAdmin
            .from("device_keys")
            .insert({
            device_id: deviceId,
            key_type: keyType,
            public_key: publicKey,
            key_version: keyVersion,
            algorithm,
            is_active: true,
        })
            .select()
            .single();
        if (insertError) {
            request.log.error({
                error: insertError,
            }, "CLIPZEN: Failed to register device key");
            return reply.code(500).send({
                error: "Failed to register device key",
            });
        }
        return reply.code(201).send({
            key: insertedKey,
            created: true,
        });
    });
}
//# sourceMappingURL=key-routes.js.map
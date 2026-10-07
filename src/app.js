import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { healthRoutes } from "./modules/health/routes.js";
import { realtimeRoutes } from "./modules/realtime/websocket.js";
import { DeviceRegistry } from "./modules/devices/registry.js";
import { deviceRoutes } from "./modules/devices/route.js";
import { deviceKeyRoutes } from "./modules/devices/key-routes.js";
import { pairingRoutes } from "./modules/pairing/route.js";
import { clipboardRoutes } from "./modules/clipboard/route.js";
export async function buildApp() {
    const app = Fastify({
        logger: true,
    });
    const deviceRegistry = new DeviceRegistry();
    await app.register(websocket);
    await app.register(healthRoutes);
    await app.register(deviceRoutes);
    await app.register(pairingRoutes);
    await app.register(clipboardRoutes);
    // await app.register(deviceKeyRoutes);
    await app.register(realtimeRoutes, {
        deviceRegistry,
    });
    return app;
}
//# sourceMappingURL=app.js.map
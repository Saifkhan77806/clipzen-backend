import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { healthRoutes } from "./modules/health/routes.js";
import { realtimeRoutes } from "./modules/realtime/websocket.js";

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  await app.register(websocket);
  await app.register(healthRoutes);
  await app.register(realtimeRoutes);

  return app;
}

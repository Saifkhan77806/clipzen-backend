import type { FastifyInstance } from "fastify";
import { PROTOCOL_VERSION } from "../../types/protocol.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/v1/health", async () => {
    return {
      status: "ok",
      service: "clipzen-server",
      version: PROTOCOL_VERSION,
    };
  });
}

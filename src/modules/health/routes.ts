import type { FastifyInstance } from "fastify";
import { PROTOCOL_VERSION } from "../../types/protocol.js";
import { authenticate } from "../../plugins/auth.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get(
    "/v1/health",
    {
      preHandler: authenticate,
    },
    async (request) => {
      return {
        status: "ok",
        version: PROTOCOL_VERSION,
        userId: request.userId,
      };
    },
  );
}

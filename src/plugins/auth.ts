import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify, createRemoteJWKSet } from "jose";

import { env } from "../config/env.js";

const JWKS = createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL));

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const authorization = request.headers.authorization;

  if (!authorization) {
    return reply.code(401).send({
      error: "Missing Authorization header",
    });
  }

  const [scheme, token] = authorization.split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return reply.code(401).send({
      error: "Invalid Authorization header",
    });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `${env.SUPABASE_URL}/auth/v1`,
    });

    if (!payload.sub) {
      return reply.code(401).send({
        error: "Token missing user identity",
      });
    }

    request.userId = payload.sub;
  } catch (error) {
    request.log.warn(
      {
        error,
      },
      "CLIPZEN: JWT verification failed",
    );

    return reply.code(401).send({
      error: "Invalid or expired token",
    });
  }
}

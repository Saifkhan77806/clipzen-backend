import type { FastifyReply, FastifyRequest } from "fastify";
declare module "fastify" {
    interface FastifyRequest {
        userId: string;
    }
}
export declare function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<undefined>;
//# sourceMappingURL=auth.d.ts.map
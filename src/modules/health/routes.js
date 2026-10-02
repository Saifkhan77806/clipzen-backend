import { PROTOCOL_VERSION } from "../../types/protocol.js";
export async function healthRoutes(app) {
    app.get("/v1/health", async () => {
        return {
            status: "ok",
            service: "clipzen-server",
            version: PROTOCOL_VERSION,
        };
    });
}
//# sourceMappingURL=routes.js.map
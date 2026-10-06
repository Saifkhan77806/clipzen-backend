import { env } from "./config/env.js";
import { buildApp } from "./app.js";
import { checkCloudServices } from "./config/clients.js";
async function startServer() {
    const app = await buildApp();
    try {
        const cloudServices = await checkCloudServices();
        console.log("CLIPZEN cloud services:", cloudServices);
        await app.listen({
            host: env.HOST,
            port: env.PORT,
        });
        app.log.info({
            event: "server.started",
            host: env.HOST,
            port: env.PORT,
            environment: env.NODE_ENV,
        });
    }
    catch (error) {
        app.log.error(error);
        process.exit(1);
    }
}
startServer();
//# sourceMappingURL=server.js.map
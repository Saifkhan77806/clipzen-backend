import "dotenv/config";
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV ?? "development";
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("Invalid PORT configuration");
}
export const env = {
    PORT,
    HOST,
    NODE_ENV,
};
//# sourceMappingURL=env.js.map
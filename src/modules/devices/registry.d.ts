import type { WebSocket } from "@fastify/websocket";
export interface ConnectedDevice {
    deviceId: string;
    socket: WebSocket;
    connectedAt: string;
}
export declare class DeviceRegistry {
    private readonly devices;
    register(device: ConnectedDevice): void;
    unregister(deviceId: string): void;
    get(deviceId: string): ConnectedDevice | undefined;
    getAll(): ConnectedDevice[];
    has(deviceId: string): boolean;
}
//# sourceMappingURL=registry.d.ts.map
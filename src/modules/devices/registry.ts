
import type { WebSocket } from "@fastify/websocket";

export interface ConnectedDevice {
  deviceId: string;
  socket: WebSocket;
  connectedAt: string;
}

export class DeviceRegistry {
  private readonly devices = new Map<string, ConnectedDevice>();

  register(device: ConnectedDevice): void {
    this.devices.set(device.deviceId, device);
  }

  unregister(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  get(deviceId: string): ConnectedDevice | undefined {
    return this.devices.get(deviceId);
  }

  getAll(): ConnectedDevice[] {
    return Array.from(this.devices.values());
  }

  has(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }
}

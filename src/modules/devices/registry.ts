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

  /*
   * Send a server-generated message to one
   * connected device.
   *
   * Returns true when the message was sent
   * to an active WebSocket connection.
   *
   * Returns false when the device is offline
   * or the socket is not writable.
   */
  send(deviceId: string, message: unknown): boolean {
    const device = this.devices.get(deviceId);

    if (!device) {
      return false;
    }

    /*
     * WebSocket.OPEN = 1
     */
    if (device.socket.readyState !== 1) {
      return false;
    }

    try {
      device.socket.send(JSON.stringify(message));

      return true;
    } catch {
      return false;
    }
  }
}

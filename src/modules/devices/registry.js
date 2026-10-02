export class DeviceRegistry {
    devices = new Map();
    register(device) {
        this.devices.set(device.deviceId, device);
    }
    unregister(deviceId) {
        this.devices.delete(deviceId);
    }
    get(deviceId) {
        return this.devices.get(deviceId);
    }
    getAll() {
        return Array.from(this.devices.values());
    }
    has(deviceId) {
        return this.devices.has(deviceId);
    }
}
//# sourceMappingURL=registry.js.map
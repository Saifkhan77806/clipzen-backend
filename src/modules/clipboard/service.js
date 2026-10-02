export class ClipboardService {
    handlePush(message) {
        return {
            version: message.version,
            type: "clipboard.received",
            messageId: message.messageId,
            sourceDeviceId: message.deviceId,
            timestamp: new Date().toISOString(),
            payload: {
                text: message.payload.text,
            },
        };
    }
}
//# sourceMappingURL=service.js.map
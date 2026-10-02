import type { ClipboardPushMessage } from "../../types/protocol.js";
export declare class ClipboardService {
    handlePush(message: ClipboardPushMessage): {
        version: 1;
        type: "clipboard.received";
        messageId: string;
        sourceDeviceId: string;
        timestamp: string;
        payload: {
            text: string;
        };
    };
}
//# sourceMappingURL=service.d.ts.map
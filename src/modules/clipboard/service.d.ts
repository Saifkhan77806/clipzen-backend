import type { ClipboardPushMessage, ClipboardReceivedMessage } from "../../types/protocol.js";
import type { ConnectedDevice } from "../devices/registry.js";
export declare class ClipboardService {
    routePush(message: ClipboardPushMessage, devices: ConnectedDevice[]): ClipboardReceivedMessage[];
}
//# sourceMappingURL=service.d.ts.map
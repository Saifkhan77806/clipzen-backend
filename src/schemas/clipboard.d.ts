import { z } from "zod";
export declare const clipboardPushSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    type: z.ZodLiteral<"clipboard.push">;
    messageId: z.ZodString;
    deviceId: z.ZodString;
    timestamp: z.ZodString;
    payload: z.ZodObject<{
        text: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export type ValidatedClipboardPush = z.infer<typeof clipboardPushSchema>;
//# sourceMappingURL=clipboard.d.ts.map
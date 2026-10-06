import { Redis } from "@upstash/redis";
export declare const supabaseAdmin: import("@supabase/supabase-js").SupabaseClient<any, "public", "public", any, any>;
export declare const redis: Redis;
export declare function checkCloudServices(): Promise<{
    redis: boolean;
    supabase: boolean;
}>;
//# sourceMappingURL=clients.d.ts.map
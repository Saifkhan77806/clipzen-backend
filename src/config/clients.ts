import { createClient } from "@supabase/supabase-js";
import { Redis } from "@upstash/redis";

import { env } from "./env.js";

export const supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SECRET_KEY,
);

export const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
});

export async function checkCloudServices() {
  const redisResult = await redis.ping();

  const { error: supabaseError } = await supabaseAdmin
    .from("health_check")
    .select("id")
    .limit(1);

  console.log("supabase error:-", supabaseError);

  return {
    redis: redisResult === "PONG",
    supabase: !supabaseError,
  };
}

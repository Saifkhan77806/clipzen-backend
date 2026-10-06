import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  HOST: z.string().default("0.0.0.0"),

  PORT: z.coerce.number().default(8080),

  SUPABASE_URL: z.string().url(),

  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),

  SUPABASE_SECRET_KEY: z.string().min(1),

  SUPABASE_JWKS_URL: z.string().url(),

  UPSTASH_REDIS_REST_URL: z.string().url(),

  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
});

export const env = envSchema.parse(process.env);

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_PUBLISHABLE_KEY!,
);

const email = process.env.TEST_EMAIL!;
const password = process.env.TEST_PASSWORD!;

const { data, error } = await supabase.auth.signInWithPassword({
  email,
  password,
});

if (error) {
  console.error(error);
  process.exit(1);
}

console.log("\nACCESS TOKEN:\n");
console.log(data.session?.access_token);

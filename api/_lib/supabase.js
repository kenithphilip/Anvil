import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL) console.warn("[supabase] SUPABASE_URL missing");

export const serviceClient = () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) throw new Error("Supabase service role credentials missing");
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "x-obara-source": "backend" } },
  });
};

export const userClient = (accessToken) => {
  if (!SUPABASE_URL || !SUPABASE_ANON) throw new Error("Supabase anon credentials missing");
  return createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: "Bearer " + accessToken } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
};

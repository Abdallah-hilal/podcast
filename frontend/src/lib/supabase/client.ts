import { createBrowserClient } from "@supabase/ssr";

// Singleton — createBrowserClient returns a NEW client on every call, which
// breaks any component that puts the client in a useEffect deps array
// (unstable ref → infinite re-run). One instance per browser tab is correct
// anyway: auth state and realtime subscriptions all share it.
let client: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  if (!client) {
    client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }
  return client;
}

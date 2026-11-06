// Server-component wrapper for the dynamic session route. Opts the segment out
// of Next.js 16 prerender validation (via `instant = false`) so the fully
// client-side SessionClient can mount against the real runtime `id`.
import SessionClient from "./SessionClient";

export const instant = false;

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SessionClient sessionId={id} />;
}

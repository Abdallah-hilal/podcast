// Server-component wrapper for the session-mix route — opts out of
// Next.js 16 prerender validation so the client component can mount against
// the runtime `id`.
import MixClient from "./MixClient";

export const instant = false;

export default async function MixPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <MixClient sessionId={id} />;
}

// Server-component wrapper for the recording detail route — opts out of
// Next.js 16 prerender validation so the fully client-side player can mount
// against the real runtime `id`.
import RecordingPlayer from "./RecordingPlayer";

export const instant = false;

export default async function RecordingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <RecordingPlayer recordingId={id} />;
}

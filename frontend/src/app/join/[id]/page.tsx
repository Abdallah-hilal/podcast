import JoinClient from "./JoinClient";

export const instant = false;

export default async function JoinPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <JoinClient sessionId={id} />;
}

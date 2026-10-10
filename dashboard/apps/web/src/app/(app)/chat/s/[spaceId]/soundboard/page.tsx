/**
 * A space's soundboard (/chat/s/<spaceId>/soundboard).
 *
 * Nothing is fetched here: the page draws its frame at once and the sounds,
 * the switches and the denials arrive behind it.
 */

import { requirePermission } from "@/lib/session";
import { SpaceSoundboardView } from "./space-soundboard-view";

export const dynamic = "force-dynamic";

export default async function SpaceSoundboardPage({
    params
}: {
    params: Promise<{ spaceId: string }>;
}) {
    const { spaceId } = await params;
    await requirePermission("chat.use");
    return <SpaceSoundboardView spaceId={spaceId} />;
}

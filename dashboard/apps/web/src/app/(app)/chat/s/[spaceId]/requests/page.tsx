/**
 * Who is asking to join a space (/chat/s/<spaceId>/requests).
 *
 * Nothing is fetched here: the page draws its frame at once and the queue
 * arrives behind it.
 */

import { requirePermission } from "@/lib/session";
import { JoinRequestsView } from "./join-requests-view";

export const dynamic = "force-dynamic";

export default async function SpaceJoinRequestsPage({
    params
}: {
    params: Promise<{ spaceId: string }>;
}) {
    const { spaceId } = await params;
    await requirePermission("chat.use");
    return <JoinRequestsView spaceId={spaceId} />;
}

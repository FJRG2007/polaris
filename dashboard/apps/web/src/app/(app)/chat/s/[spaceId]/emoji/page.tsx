/**
 * A space's own emoji (/chat/s/<spaceId>/emoji).
 *
 * Nothing is fetched here: the list is the same one every conversation in the
 * space draws from, kept by the client, so the page draws its frame at once and
 * the rows arrive behind it.
 */

import { requirePermission } from "@/lib/session";
import { SpaceEmojiView } from "./space-emoji-view";

export const dynamic = "force-dynamic";

export default async function SpaceEmojiPage({ params }: { params: Promise<{ spaceId: string }> }) {
    const { spaceId } = await params;
    await requirePermission("chat.use");
    return <SpaceEmojiView spaceId={spaceId} />;
}

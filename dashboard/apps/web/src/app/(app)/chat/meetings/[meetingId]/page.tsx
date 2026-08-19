/**
 * One meeting (/chat/meetings/<id>).
 *
 * The server hands over the id and the reader, and nothing else. Whether this
 * account may be in the room at all is answered by the actions the client calls:
 * an id in an address is a request, not a permission.
 */

import { requirePermission } from "@/lib/session";
import { MeetingRoom } from "./meeting-room";

export const dynamic = "force-dynamic";

export default async function MeetingPage({
    params
}: {
    params: Promise<{ meetingId: string }>;
}) {
    const [{ meetingId }, user] = await Promise.all([params, requirePermission("chat.use")]);
    return <MeetingRoom meetingId={meetingId} viewerId={user.id} />;
}

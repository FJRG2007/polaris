/**
 * One message, in the conversation it was said in.
 *
 * The address a "copy link" hands out. It opens the conversation the same way
 * the channel route does and then walks back through it until the message is on
 * screen, so a link to something said last month lands on that line rather than
 * at the bottom of the room.
 *
 * A message id in a URL is a request, not a permission: the actions this screen
 * calls check the conversation before returning any of it, and a link to a room
 * somebody is not in shows them the same "not yours to open" as the room itself.
 */

import { ChannelView } from "@/app/(app)/chat/channel-view";

export const dynamic = "force-dynamic";

export default async function ChatMessagePage({
    params
}: {
    params: Promise<{ channelId: string; messageId: string }>;
}) {
    const { channelId, messageId } = await params;
    return <ChannelView channelId={channelId} messageId={messageId} />;
}

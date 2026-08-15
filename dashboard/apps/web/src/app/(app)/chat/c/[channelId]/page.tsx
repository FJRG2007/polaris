/**
 * One conversation.
 *
 * The server hands over the id and nothing else. Everything on this screen
 * changes while somebody is looking at it, so it is fetched by the client that
 * keeps it live - and the header, the scroll area and the composer are on screen
 * before the first message has been asked for.
 *
 * Authorization still happens on the server, in the action the client calls: an
 * id in the URL is a request, not a permission.
 */

import { ChannelView } from "@/app/(app)/chat/channel-view";

export const dynamic = "force-dynamic";

export default async function ChatChannelPage({
    params
}: {
    params: Promise<{ channelId: string }>;
}) {
    const { channelId } = await params;
    return <ChannelView channelId={channelId} />;
}

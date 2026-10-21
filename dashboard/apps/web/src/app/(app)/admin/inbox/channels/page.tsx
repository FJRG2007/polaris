/**
 * Channels management, on its own page so channels are configured and reviewed
 * apart from the conversation view. The Watch app and the Inbox both send through
 * whatever is connected here. Email and SMS senders are not channels in that
 * sense - nothing arrives on them - and are set up under Email & SMS.
 */

import { requirePermission } from "@/lib/session";
import { ChannelsView } from "./channels-view";
import { listChannels } from "@/lib/messaging-service";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
    const user = await requirePermission("inbox.read");
    return <ChannelsView initialChannels={await listChannels(user.id)} />;
}

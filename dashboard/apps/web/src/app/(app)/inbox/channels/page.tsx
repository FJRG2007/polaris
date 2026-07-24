/**
 * Channels management, on its own page so channels are configured and reviewed
 * apart from the conversation view. The Watch app and the Inbox both send through
 * whatever is connected here.
 */

import { requireUser } from "@/lib/session";
import { bridgeConfigured } from "@/lib/messaging/bridge-client";
import { listChannels } from "@/lib/messaging-service";
import { ChannelsView } from "./channels-view";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
    const user = await requireUser();
    const [ready, channels] = await Promise.all([bridgeConfigured(), listChannels(user.id)]);
    return <ChannelsView initialChannels={channels} bridgeReady={ready} />;
}

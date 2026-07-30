/**
 * Channels management, on its own page so channels are configured and reviewed
 * apart from the conversation view. The Watch app and the Inbox both send through
 * whatever is connected here.
 *
 * Email senders live here too. They are not messaging channels - nothing arrives
 * on them and the bridge never runs them - but they are the same kind of thing to
 * configure, and putting them anywhere else would leave an operator hunting for
 * where mail is set up.
 */

import { requireUser } from "@/lib/session";
import { bridgeConfigured } from "@/lib/messaging/bridge-client";
import { listChannels } from "@/lib/messaging-service";
import { listEmailChannels } from "@/lib/mail-service";
import { ChannelsView } from "./channels-view";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
    const user = await requireUser();
    const [ready, channels, emailChannels] = await Promise.all([
        bridgeConfigured(),
        listChannels(user.id),
        listEmailChannels(user.id)
    ]);
    return (
        <ChannelsView initialChannels={channels} initialEmailChannels={emailChannels} bridgeReady={ready} />
    );
}

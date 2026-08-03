/**
 * Channels management, on its own page so channels are configured and reviewed
 * apart from the conversation view. The Watch app and the Inbox both send through
 * whatever is connected here.
 *
 * Email and SMS senders live here too. They are not messaging channels - nothing
 * arrives on them and the bridge never runs them - but they are the same kind of
 * thing to configure, and putting them anywhere else would leave an operator
 * hunting for where mail and texts are set up.
 */

import { requireUser } from "@/lib/session";
import { ChannelsView } from "./channels-view";
import { listChannels } from "@/lib/messaging-service";
import { listEmailChannels } from "@/lib/mail-service";
import { bridgeConfigured } from "@/lib/messaging/bridge-client";
import { listSmsSenders } from "@/lib/notifications/sms-service";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
    const user = await requireUser();
    const [ready, channels, emailChannels, smsSenders] = await Promise.all([
        bridgeConfigured(),
        listChannels(user.id),
        listEmailChannels(user.id),
        listSmsSenders(user.id)
    ]);
    return (
        <ChannelsView
            initialChannels={channels}
            initialEmailChannels={emailChannels}
            smsSenders={smsSenders}
            bridgeReady={ready}
        />
    );
}

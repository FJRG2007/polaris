/**
 * Channels management, on its own page so channels are configured and reviewed
 * under Email & SMS. Watch alarms, automation notices and two-factor codes send
 * through whatever is connected here. Email and SMS senders are not channels in that
 * sense - nothing arrives on them - and are set up under Email & SMS.
 */

import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { ChannelsLoader, cardsSkeleton } from "./loaders";
import { ViewHeadingSkeleton } from "@/app/(app)/admin/region-skeletons";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
    await requirePermission("inbox.read");
    const t = await getTranslations("admin");

    return (
        <ChannelsLoader
            revision={Date.now()}
            skeleton={
                <ViewHeadingSkeleton
                    title={t("inboxChannels.title")}
                    intro={t("inboxChannels.intro")}
                >
                    {cardsSkeleton}
                </ViewHeadingSkeleton>
            }
        />
    );
}

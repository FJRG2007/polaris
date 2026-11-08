/**
 * The channel marketplace: every messaging platform the Inbox can be connected
 * to. Email and SMS senders are added under Email & SMS.
 *
 * Every platform here runs on the messaging bridge. Without one installed there
 * is nothing to connect, so the page sends you to the senders that work without
 * it; with one installed but stopped, the view says so and links to the bridge
 * for a viewer who can open it.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { ConnectChannelLoader, cardsSkeleton } from "@/app/(app)/admin/inbox/loaders";
import { ViewHeadingSkeleton } from "@/app/(app)/admin/region-skeletons";

export const dynamic = "force-dynamic";

/**
 * Which screen this is - the channel picker, the way to the bridge app, or a
 * move to the email screen when there is no bridge - is decided from the data,
 * so it is decided in the region, after the heading has painted.
 */
export default async function ConnectChannelPage() {
    await requirePermission("inbox.read");
    const t = await getTranslations("admin");

    return (
        <ConnectChannelLoader
            revision={Date.now()}
            skeleton={
                <ViewHeadingSkeleton
                    title={t("inboxChannels.connect")}
                    intro={t("inboxChannels.connectPage.intro")}
                    className="mx-auto flex w-full max-w-4xl flex-col gap-6"
                    lead={
                        <Link
                            href="/admin/inbox/channels"
                            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                            <ArrowLeft className="size-3" /> {t("inboxChannels.title")}
                        </Link>
                    }
                >
                    {cardsSkeleton}
                </ViewHeadingSkeleton>
            }
        />
    );
}

/**
 * Messaging logs: recent inbound/outbound message activity across every channel,
 * so an operator can see what the bridge is sending and receiving and its delivery
 * state - useful for confirming a channel works end to end.
 */

import { requirePermission } from "@/lib/session";
import { LogsLoader, tableSkeleton } from "../loaders";
import { getTranslations } from "@/lib/i18n/request";
import { ViewHeadingSkeleton } from "@/app/(app)/admin/region-skeletons";

export const dynamic = "force-dynamic";

export default async function LogsPage() {
    await requirePermission("inbox.read");
    const t = await getTranslations("admin");

    return (
        <LogsLoader
            revision={Date.now()}
            skeleton={
                <ViewHeadingSkeleton title={t("inboxLogs.title")} intro={t("inboxLogs.intro")}>
                    {tableSkeleton}
                </ViewHeadingSkeleton>
            }
        />
    );
}

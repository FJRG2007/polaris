/**
 * The unified Inbox: conversations across every connected channel, with live
 * polling. Any signed-in user sees and handles their own channels. The messaging
 * bridge (a managed container) runs the platform adapters; this page is a thin
 * client over the messaging service.
 */

import { InboxLoader, tableSkeleton } from "./loaders";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { ViewHeadingSkeleton } from "../region-skeletons";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
    await requirePermission("inbox.read");
    const t = await getTranslations("admin");

    return (
        <InboxLoader
            revision={Date.now()}
            skeleton={
                <ViewHeadingSkeleton title={t("inbox.view.title")} className="flex flex-col gap-3">
                    {tableSkeleton}
                </ViewHeadingSkeleton>
            }
        />
    );
}

/**
 * Settings > Privacy > Activity sharing: what is shown beside your name while you play
 * or listen, source by source, and the games Polaris has seen you run.
 */

import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { listConnections } from "@/lib/connections/store";
import { connectionLinkAvailable } from "@/lib/connections/oauth";
import { activitySettingsOf } from "@/lib/presence-activity/settings";
import { ActivitySharingCard } from "../activity-sharing-card";

export const dynamic = "force-dynamic";

export default async function ActivityPrivacyPage() {
    const session = await requireUser();
    const t = await getTranslations("accountPrivacy");
    const [activity, spotifyLinks, spotifyOffered] = await Promise.all([
        activitySettingsOf(session.id),
        listConnections(session.id, "spotify"),
        connectionLinkAvailable("spotify", { admin: session.isAdmin, userId: session.id }).catch(
            () => false
        )
    ]);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("activity.page.title")}
                </h1>
                <p className="text-sm text-muted-foreground">{t("activity.description")}</p>
            </div>
            <ActivitySharingCard
                settings={activity.settings}
                seenGames={activity.seenGames}
                spotify={
                    spotifyLinks.length > 0 ? "linked" : spotifyOffered ? "unlinked" : "unavailable"
                }
                userId={session.id}
            />
        </div>
    );
}

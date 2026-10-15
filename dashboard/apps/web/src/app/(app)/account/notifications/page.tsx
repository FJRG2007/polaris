/**
 * Notifications page (/account/notifications): what Polaris told you, and how it
 * is allowed to reach you. The history comes from the live feed the app shell
 * holds, so it updates while the page is open, and pages back through everything
 * older on demand.
 */

import { getTranslations } from "@/lib/i18n/request";
import { requireUser } from "@/lib/session";
import { listDeliveries } from "@/lib/notification-service";
import { describeNotificationRules, getQuietHours } from "@/lib/notifications/preferences";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";
import { listDestinations } from "@/lib/notifications/destinations";
import { listSmsSenders } from "@/lib/notifications/sms-service";
import { NotificationsPageView } from "./notifications-page-view";
import { prisma } from "@polaris/db";
import { inGameChoice } from "@/lib/chat/in-game-choice";
import { clearsOnVisit } from "@/lib/badge-seen";
import { chatRelayReady, relaysChatToGames } from "@/lib/app-extensions/registry";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
    const user = await requireUser();
    const t = await getTranslations("accountNotifications");
    const [
        rules,
        destinations,
        senders,
        deliveries,
        inGameOffered,
        inGameReady,
        account,
        quietHours,
        display
    ] = await Promise.all([
        describeNotificationRules(user.id),
        listDestinations(user.id),
        listSmsSenders(user.id),
        listDeliveries(user.id),
        // Offered only where an installed app can show a message in a game.
        relaysChatToGames().catch(() => false),
        // And chosen only once a server knows which of its players is them.
        chatRelayReady(user.id).catch(() => false),
        prisma.user.findUnique({
            where: { id: user.id },
            select: { messagesInGame: true, badgesClearOnVisit: true }
        }),
        getQuietHours(user.id),
        resolveDisplayPreferencesFor(user.id)
    ]);

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("settings.page.title")}
                </h1>
                <p className="text-sm text-muted-foreground">{t("settings.page.intro")}</p>
            </div>
            <NotificationsPageView
                rules={rules}
                destinations={destinations}
                senders={senders}
                deliveries={deliveries}
                messagesInGame={
                    inGameOffered ? inGameChoice(account?.messagesInGame ?? null) : null
                }
                inGameReady={inGameReady}
                quiet={{ hours: quietHours, timeZone: display.timeZone }}
                // Only an administrator has a badge a visit can clear: the
                // Management queue. Chat and Mail clear by being read.
                badgesClearOnVisit={
                    user.isAdmin ? clearsOnVisit(account?.badgesClearOnVisit) : null
                }
            />
        </div>
    );
}

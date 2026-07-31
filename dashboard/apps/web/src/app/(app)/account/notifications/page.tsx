/**
 * Notifications page (/account/notifications): what Polaris told you, and how it
 * is allowed to reach you. The history comes from the live feed the app shell
 * holds, so it updates while the page is open, and pages back through everything
 * older on demand.
 */

import { requireUser } from "@/lib/session";
import { listDeliveries } from "@/lib/notification-service";
import { describeNotificationRules } from "@/lib/notifications/preferences";
import { listDestinations } from "@/lib/notifications/destinations";
import { listSmsSenders } from "@/lib/notifications/sms-service";
import { NotificationsPageView } from "./notifications-page-view";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
    const user = await requireUser();
    const [rules, destinations, senders, deliveries] = await Promise.all([
        describeNotificationRules(user.id),
        listDestinations(user.id),
        listSmsSenders(user.id),
        listDeliveries(user.id)
    ]);

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Notifications</h1>
                <p className="text-sm text-muted-foreground">
                    Alerts from Polaris and your integrations, and where each one is sent.
                </p>
            </div>
            <NotificationsPageView
                rules={rules}
                destinations={destinations}
                senders={senders}
                deliveries={deliveries}
            />
        </div>
    );
}

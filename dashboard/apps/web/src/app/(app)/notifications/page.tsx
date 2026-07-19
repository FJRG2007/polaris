/**
 * The full notifications list for the current user. The bell shows the most
 * recent few; this page shows the history with mark-read and clear controls.
 */

import { requireUser } from "@/lib/session";
import { listNotifications } from "@/lib/notification-service";
import { NotificationsView } from "./notifications-view";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
    const user = await requireUser();
    const items = await listNotifications(user.id, 100);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-medium">Notifications</h1>
                <p className="text-sm text-muted-foreground">Alerts from Polaris and your integrations.</p>
            </div>
            <NotificationsView items={items} />
        </div>
    );
}

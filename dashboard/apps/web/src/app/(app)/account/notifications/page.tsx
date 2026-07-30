/**
 * Notifications page (/account/notifications): the full alert history for the
 * signed-in user. The list itself comes from the live feed the app shell holds,
 * so it updates while the page is open.
 */

import { NotificationsView } from "./notifications-view";

export default function NotificationsPage() {
    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Notifications</h1>
                <p className="text-sm text-muted-foreground">Alerts from Polaris and your integrations.</p>
            </div>
            <NotificationsView />
        </div>
    );
}

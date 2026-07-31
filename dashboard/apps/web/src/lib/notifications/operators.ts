/**
 * Telling whoever can act on something.
 *
 * Several watchers raise the same shape of alert: one thing happened to the
 * deployment, and everybody holding the permission that lets them do something
 * about it should hear about it once, through their own rules. This is that fan-out
 * in one place, so a new watcher does not come with its own copy of it.
 */

import { usersWithPermission } from "@polaris/auth";
import { notify } from "@/lib/notifications/dispatch";
import type { NotificationLevel, Permission } from "@polaris/core";

export interface OperatorAlert {
    /** Who is told: the people allowed to act on it. */
    permission: Permission;
    /** A catalogue event id. */
    event: string;
    title: string;
    body: string;
    /** In-app path the alert points at. */
    href: string;
    level?: NotificationLevel;
    actionRequired?: boolean;
}

/** Raise one alert with every recipient, never failing its caller. */
export async function notifyOperators(alert: OperatorAlert): Promise<void> {
    const recipients = await usersWithPermission(alert.permission);
    await Promise.allSettled(
        recipients.map((userId) =>
            notify({
                userId,
                event: alert.event,
                title: alert.title,
                body: alert.body,
                href: alert.href,
                level: alert.level,
                audience: "admins",
                actionRequired: alert.actionRequired
            })
        )
    );
}

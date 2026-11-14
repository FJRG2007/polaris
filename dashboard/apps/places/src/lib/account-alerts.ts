/**
 * The bell for a connection that stopped working for a reason only its owner
 * can fix.
 *
 * A key that was revoked, or a plan at the maker that ran out, stops every
 * device on the account at once - and from the house it looks like a plug that
 * ignores the button. The banner on the devices screen says so to whoever opens
 * it; this says so to whoever the house belongs to, once per connection and
 * cause. Once is the account layer's transition (`markAccount` answers whether
 * the status changed), with a `dedupKey` behind it so two failures racing each
 * other fold into one bell entry instead of two.
 */

import { placesTFor } from "./i18n";
import { prisma } from "@polaris/db";
import { isMuted } from "@polaris/core";
import { host } from "@polaris/app-host";
import { placesRefusalText } from "./refusal-text";

/** The notification it rings as (`packages/core` notifications). */
export const CONNECTION_EVENT = "places.connection";

/** The statuses that are the account's to fix, not a device's to wait out. */
export const ATTENTION_STATUSES: ReadonlySet<string> = new Set(["unauthorized", "lapsed"]);

export function connectionDedupKey(accountId: string, status: string): string {
    return `${CONNECTION_EVENT}:${accountId}:${status}`;
}

export async function tellConnectionFailed(accountId: string, status: string): Promise<void> {
    if (!ATTENTION_STATUSES.has(status)) return;
    try {
        const account = await prisma.placeDeviceAccount.findFirst({
            where: { id: accountId },
            select: { installedAppId: true, label: true, statusNote: true }
        });
        if (!account) return;
        const install = await prisma.installedApp.findFirst({
            where: { id: account.installedAppId },
            select: { ownerId: true }
        });
        if (!install) return;
        if (isMuted(await host.notificationsPreferences.ruleFor(install.ownerId, CONNECTION_EVENT)))
            return;
        const t = await placesTFor(install.ownerId);
        const why = account.statusNote ? placesRefusalText(t, account.statusNote) : "";
        const lapsed = status === "lapsed";
        await host.notificationsDispatch.notify({
            userId: install.ownerId,
            event: CONNECTION_EVENT,
            title: lapsed
                ? t("connectionAlerts.lapsed.title", { name: account.label })
                : t("connectionAlerts.refused.title", { name: account.label }),
            body:
                why ||
                (lapsed ? t("connectionAlerts.lapsed.body") : t("connectionAlerts.refused.body")),
            href: "/places/devices",
            metadata: { accountId },
            dedupKey: connectionDedupKey(accountId, status)
        });
    } catch (error) {
        console.error("places: a connection alert could not be raised:", error);
    }
}

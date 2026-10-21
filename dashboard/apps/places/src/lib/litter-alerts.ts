/**
 * A litter box that has started needing somebody: a full bin, litter running
 * low, a fault it stopped on.
 *
 * Read off two successive readings of the same box (`litterAttention`), so it
 * is said once when it begins rather than every minute while the bin stays
 * full. Each one is written into the device's history and, unless its owner
 * muted that event, rung on the bell in the owner's language.
 *
 * Server-only. Never throws: a sync must not fail because a bell could not
 * ring.
 */

import { placesTFor } from "./i18n";
import { prisma } from "@polaris/db";
import { isMuted } from "@polaris/core";
import * as kinds from "./device-kinds";
import { host } from "@polaris/app-host";
import type { DeviceSnapshot } from "./drivers/contract";

const { notify } = host.notificationsDispatch;
const { ruleFor } = host.notificationsPreferences;

/** The notification each need rings as (`packages/core` notifications). */
export const LITTER_EVENTS: Readonly<Record<kinds.LitterAttention, string>> = {
    "bin-full": "places.litter-bin",
    "litter-low": "places.litter-low",
    fault: "places.litter-fault"
};

/** What each litter box on the account said at its last reading, by its id
 *  there. One query, for the boxes in this reading only. */
export async function previousLitter(
    accountId: string,
    snapshots: readonly DeviceSnapshot[]
): Promise<Map<string, kinds.LitterView | null>> {
    const ids = snapshots
        .filter((snapshot) => snapshot.kind === "litter")
        .map((snapshot) => snapshot.externalId);
    if (ids.length === 0) return new Map();
    const rows = await prisma.placeDevice.findMany({
        where: { accountId, externalId: { in: ids } },
        select: { externalId: true, litter: true }
    });
    return new Map(rows.map((row) => [row.externalId, kinds.litterView(row.litter)]));
}

export async function tellLitter(
    installedAppId: string,
    device: { readonly id: string; readonly name: string; readonly kind: string },
    before: kinds.LitterView | null,
    after: kinds.LitterView | null
): Promise<void> {
    if (kinds.deviceKind(device.kind) !== "litter") return;
    const needs = kinds.litterAttention(before, after);
    if (needs.length === 0) return;
    try {
        const install = await prisma.installedApp.findFirst({
            where: { id: installedAppId },
            select: { ownerId: true }
        });
        const t = install ? await placesTFor(install.ownerId) : null;
        for (const which of needs) {
            await prisma.placeDeviceEvent.create({
                data: {
                    deviceId: device.id,
                    action: which,
                    via: "device",
                    outcome: "ok",
                    note: which === "fault" ? (after?.fault ?? null) : null,
                    at: new Date()
                }
            });
            if (!install || !t) continue;
            const event = LITTER_EVENTS[which];
            if (isMuted(await ruleFor(install.ownerId, event))) continue;
            const words = { name: device.name, fault: after?.fault ?? "" };
            await notify({
                userId: install.ownerId,
                event,
                title: t(`litterAlerts.${which}.title`, words),
                body: t(`litterAlerts.${which}.body`, words),
                href: "/places/devices",
                metadata: { deviceId: device.id }
            });
        }
    } catch (error) {
        console.error("places: a litter box alert could not be raised:", error);
    }
}

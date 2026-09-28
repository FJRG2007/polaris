/**
 * The data of apps that no longer exist, removed once nobody can want it back.
 *
 * Deleting an app keeps its volumes, on purpose: a delete can be a mistake, and
 * a world or a database is the one thing a redeploy cannot bring back. But kept
 * for ever, they are what a server's disk fills with - lirio-0 held 2 GB of five
 * Minecraft servers deleted in August, a month later, listed as "Check first"
 * for somebody to find and decide about by hand.
 *
 * So the storage screen's own verdict decides, and only its strictest one: a
 * volume goes when it is judged safe - made by Polaris for an app that is gone,
 * with a week both since the app went and since anything used it. A volume
 * Polaris did not make, one in use, one that still has an owner, and one inside
 * that week are never touched. Each removal goes through `removeHostVolume`,
 * which checks all of that again at the moment of the call, and is audited with
 * its size; the people who manage the server are told what went.
 *
 * On unless switched off on the storage screen.
 *
 * Server-only. Safe to re-run.
 */

import { recordAudit } from "@/lib/audit-service";
import { getSetting, setSetting } from "@/lib/setting-store";
import { hostVolumes, removeHostVolume } from "./host-volumes";
import { notifyOperators } from "@/lib/notifications/operators";

/** The switch on the storage screen. Anything but "off" is on. */
export const AUTO_REMOVE_KEY = "storage.removeLeftoverVolumes";

export async function autoRemoveOn(): Promise<boolean> {
    return (await getSetting(AUTO_REMOVE_KEY).catch(() => null)) !== "off";
}

export async function setAutoRemove(on: boolean): Promise<void> {
    // Stored only when off, so the default is what an install that never touched
    // it gets - including every one that predates the switch.
    await setSetting(AUTO_REMOVE_KEY, on ? null : "off");
}

/** What one pass removed. */
export interface RemovedVolume {
    readonly name: string;
    readonly bytes: number | null;
    readonly description: string | null;
}

function size(bytes: number | null): string {
    if (bytes === null) return "size unknown";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Remove every volume the storage screen judges safe to delete. */
export async function removeLeftoverVolumes(): Promise<RemovedVolume[]> {
    if ((await getSetting(AUTO_REMOVE_KEY)) === "off") return [];
    const volumes = await hostVolumes({ strict: true });
    // A machine that would not say what it holds is not a machine holding nothing.
    if (!volumes) return [];

    const removed: RemovedVolume[] = [];
    for (const volume of volumes) {
        if (volume.verdict !== "safe") continue;
        const result = await removeHostVolume(volume.name).catch(() => null);
        if (!result?.ok) continue;
        removed.push({ name: volume.name, bytes: volume.bytes, description: volume.description });
        await recordAudit({
            actorId: null,
            action: "server.volume.removed",
            targetType: "volume",
            targetId: volume.name,
            metadata: {
                bytes: volume.bytes,
                project: volume.project,
                automatic: true,
                reason: volume.reason
            }
        });
    }

    if (removed.length > 0) {
        const total = removed.reduce((sum, volume) => sum + (volume.bytes ?? 0), 0);
        await notifyOperators({
            permission: "system.manage",
            event: "server.space",
            title:
                removed.length === 1
                    ? `Polaris removed a leftover volume (${size(total)})`
                    : `Polaris removed ${removed.length} leftover volumes (${size(total)})`,
            body: removed
                .map((volume) => `${volume.description ?? volume.name} - ${size(volume.bytes)}`)
                .join("\n"),
            href: "/apps/servers"
        });
    }
    return removed;
}

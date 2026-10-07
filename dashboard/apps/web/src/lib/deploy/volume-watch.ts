/**
 * Keeping the NAS volumes of running services attached, and saying when they are not.
 *
 * A NAS volume is a bind onto a kernel mount of the share. Two things take it away
 * without anybody touching the service: the share's mount dies (the NAS rebooted,
 * or came back on another address), or the share is mounted again while the
 * service holds the old one - a bind resolves once, when the container starts.
 * Either way the service keeps running and every file on the volume answers "Host
 * is down", and nothing used to notice until a person did.
 *
 * So every few minutes this asks, for each service with a NAS volume:
 *
 * - whether the share is mounted and answering on that machine, mounting it again
 *   when it is not (which restarts every service bound to it, see
 *   `restartAppsOnShare`), and
 * - whether the volumes answer inside the service itself, restarting it once when
 *   they do not.
 *
 * What it cannot mend is said to the service's owner and followers, once per
 * outage, and so is its return.
 */

import { prisma } from "@polaris/db";
import { getCapabilities } from "@polaris/config";
import { withTimeout } from "@polaris/core";
import * as deployReleases from "./releases";
import type { RuntimePorts } from "@polaris/deploy";
import { getPorts, type TargetRow } from "./runtime";
import { resolveMountTarget } from "@/lib/storage-service";
import { notifyVolumeHealth, type VolumeHealth } from "@/lib/notifications/volume-events";

const FIRST_PASS_MS = 90_000;
const WATCH_INTERVAL_MS = 3 * 60_000;
/** A NAS that is off holds a mount call for as long as the kernel's connect
 *  retries take; the pass moves on rather than waiting it out. */
const MOUNT_WAIT_MS = 60_000;
const LOOK_WAIT_MS = 20_000;

/** What a path on a mount that died answers, in the words of the tools inside a
 *  container (coreutils and busybox) and of the kernel. */
const DEAD_MOUNT =
    /host is down|stale file handle|transport endpoint is not connected|input\/output error|no such device|ehostdown|estale|enotconn/i;

interface Watched {
    id: string;
    slug: string;
    target: TargetRow;
    ownerId: string;
    projectSlug: string;
    volumes: Array<{ name: string; mountPath: string; connectionId: string; storage: string }>;
}

/** Services told their volumes are down, with what was said, so the outage is one
 *  notice and its end is another. In this process only. */
const told = new Map<string, Exclude<VolumeHealth, "back" | "reconnected">>();

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

/** Forget what was said about a service's volumes, once something else has said
 *  they are back - a share mounted again restarts it and tells its owner so. */
export function forgetVolumeNotice(applicationId: string): void {
    told.delete(applicationId);
}

export function startVolumeWatcher(): void {
    if (timer) return;
    schedule(FIRST_PASS_MS);
}

function schedule(delayMs: number): void {
    timer = setTimeout(() => {
        void checkNasVolumes().finally(() => schedule(WATCH_INTERVAL_MS));
    }, delayMs);
    timer.unref();
}

/** One pass over every running service with a NAS volume. Shares a pass already
 *  running rather than starting a second. Never throws. */
export function checkNasVolumes(): Promise<void> {
    inFlight ??= pass()
        .catch((error) => console.error("polaris: NAS volume check failed:", error))
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}

async function pass(): Promise<void> {
    const watched = await watchedServices();
    // One connection per machine and owner: a remote machine is reached over SSH,
    // and opening it once per service would be a login per service per pass.
    const byMachine = new Map<string, Watched[]>();
    for (const app of watched) {
        const key = `${app.target.hostId ?? "local"}:${app.ownerId}`;
        byMachine.set(key, [...(byMachine.get(key) ?? []), app]);
    }
    for (const apps of byMachine.values()) {
        let ports: RuntimePorts;
        try {
            ports = await getPorts(apps[0]!.target, apps[0]!.ownerId);
        } catch (error) {
            // The machine itself is away, which its own screens already say; the
            // volumes on it are not the news.
            console.error(
                `polaris: NAS volume check could not reach ${apps[0]!.slug}'s machine:`,
                error
            );
            continue;
        }
        try {
            await checkMachine(ports, apps);
        } finally {
            await ports.dispose().catch(() => undefined);
        }
    }
    // A service that stopped, was removed or lost its NAS volumes is no longer
    // watched, and whatever was said about it is over.
    const ids = new Set(watched.map((app) => app.id));
    for (const id of told.keys()) if (!ids.has(id)) told.delete(id);
}

async function watchedServices(): Promise<Watched[]> {
    const rows = await prisma.application.findMany({
        where: {
            desiredState: "running",
            currentDeploymentId: { not: null },
            volumes: { some: { kind: "nas", connectionId: { not: null } } }
        },
        select: {
            id: true,
            slug: true,
            target: true,
            environment: { select: { project: { select: { ownerId: true, slug: true } } } },
            volumes: {
                where: { kind: "nas", connectionId: { not: null } },
                select: {
                    name: true,
                    mountPath: true,
                    connectionId: true,
                    connection: { select: { name: true } }
                }
            }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        target: row.target as TargetRow,
        ownerId: row.environment.project.ownerId,
        projectSlug: row.environment.project.slug,
        volumes: row.volumes.map((volume) => ({
            name: volume.name,
            mountPath: volume.mountPath,
            connectionId: volume.connectionId as string,
            storage: volume.connection?.name ?? volume.name
        }))
    }));
}

async function checkMachine(ports: RuntimePorts, apps: Watched[]): Promise<void> {
    // The shares first: a service cannot have its volumes while the share under
    // them is not mounted, and mounting it again restarts everybody bound to it.
    const unreachable = new Map<string, string>();
    /** Services the share step restarted, each already told it was reconnected. */
    const restarted = new Set<string>();
    const shares = new Set(apps.flatMap((app) => app.volumes.map((volume) => volume.connectionId)));
    const machine =
        apps[0]!.target.kind === "local" || !apps[0]!.target.hostId ? null : apps[0]!.target.hostId;
    // An edition with no host daemon mounts nothing here, so there is no share to
    // keep attached - and every pass would otherwise read as a NAS that is away.
    if (machine === null && !getCapabilities().nativeMounts) return;
    for (const connectionId of shares) {
        try {
            const mount = await resolveMountTarget(connectionId, apps[0]!.ownerId);
            // A kind the host does not mount itself: nothing here to keep attached.
            if (!mount) continue;
            const created = await withTimeout(
                ports.ensureMount(mount),
                MOUNT_WAIT_MS,
                "the storage did not answer in time"
            );
            if (created) {
                const { restartAppsOnShare } = await import("@/lib/deploy-service");
                for (const id of await restartAppsOnShare(connectionId, machine)) restarted.add(id);
            }
        } catch (error) {
            unreachable.set(connectionId, error instanceof Error ? error.message : String(error));
        }
    }

    for (const app of apps) {
        const lost = app.volumes.filter((volume) => unreachable.has(volume.connectionId));
        if (lost.length > 0) {
            await say(app, "unreachable", lost);
            continue;
        }
        const container = deployReleases.serviceRef(app.projectSlug, app.slug, app.id).name;
        if (await answers(ports, container, app)) {
            // Restarted onto the share a moment ago, which said so already.
            if (restarted.has(app.id)) told.delete(app.id);
            else await settle(app);
            continue;
        }
        // Restarted once already this outage without the volumes coming back: a
        // restart every pass would only cut its connections again.
        if (told.get(app.id) === "detached") continue;
        // The share is fine on the machine, so the service holds a mount that is
        // not it any more. A restart binds it again.
        try {
            await ports.container(container, "restart");
        } catch (error) {
            console.error(`polaris: could not restart ${app.slug} onto its NAS volumes:`, error);
        }
        if (await answers(ports, container, app)) {
            told.delete(app.id);
            await notifyVolumeHealth(subjectOf(app, app.volumes), "reconnected");
        } else {
            await say(app, "detached", app.volumes);
        }
    }
}

/**
 * Whether the service's NAS volumes answer from inside it. Only a dead mount's own
 * answer counts against it: a container that is stopped, or an image with no `ls`
 * in it, says nothing about the volumes and is taken as fine.
 */
async function answers(ports: RuntimePorts, container: string, app: Watched): Promise<boolean> {
    try {
        const result = await withTimeout(
            ports.runIn(container, ["ls", "-d", ...app.volumes.map((volume) => volume.mountPath)]),
            LOOK_WAIT_MS,
            "the service did not answer in time"
        );
        return !(result.code !== 0 && DEAD_MOUNT.test(result.output));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return !DEAD_MOUNT.test(message);
    }
}

/** Say a service's volumes are down, once for as long as they stay that way. */
async function say(
    app: Watched,
    health: "unreachable" | "detached",
    volumes: Watched["volumes"]
): Promise<void> {
    if (told.get(app.id) === health) return;
    told.set(app.id, health);
    await notifyVolumeHealth(subjectOf(app, volumes), health);
}

/** The volumes answer: if they had been said to be down, say they are back. */
async function settle(app: Watched): Promise<void> {
    if (!told.has(app.id)) return;
    told.delete(app.id);
    await notifyVolumeHealth(subjectOf(app, app.volumes), "back");
}

function subjectOf(app: Watched, volumes: Watched["volumes"]) {
    return {
        applicationId: app.id,
        storage: [...new Set(volumes.map((volume) => volume.storage))].join(", "),
        volumes: volumes.map((volume) => volume.name)
    };
}

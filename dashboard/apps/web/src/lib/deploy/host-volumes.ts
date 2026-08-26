/**
 * The volumes on the machine Polaris runs on, and which of them nothing needs
 * any more.
 *
 * Volumes are usually the largest thing on the disk and the only thing on it
 * that does not come back: build cache and dangling layers are rebuilt or
 * re-pulled, a volume is somebody's database, save file or upload. That is why
 * `host-space.ts` will not touch one, and why the daemon's allowlist has no
 * `/volumes/prune` in it.
 *
 * It is also why the disk fills up. An app removed by hand, a stack recreated
 * under a new project name, a database swapped for another - each leaves a
 * volume nothing references, and the only tool the internet offers for that is
 * `docker system prune -a`, which deletes everything that is not in use AT THAT
 * MOMENT. An app that happens to be stopped is not spare, and that command
 * cannot tell the difference. Neither can `docker volume prune`.
 *
 * So Polaris does not prune. It lists, it says what it knows about each one, and
 * it removes exactly the one that was named:
 *
 *   - A volume a container references is never offered, whether that container
 *     is running or stopped. The daemon refuses it too, which is the backstop.
 *   - A volume Polaris has a record for is never offered, however long it has
 *     been sitting there: it belongs to an app, and an app can be stopped for a
 *     month.
 *   - A volume younger than a day is never offered, because a deploy in progress
 *     has volumes nothing has attached yet.
 *   - What is left is shown with its size, its age and whatever it was labelled
 *     with, and goes one at a time, from a button, into the audit trail.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HostdClient } from "@polaris/hostd-client";

/** How new is too new to be called spare. A deploy that is still building has
 *  created its volumes and attached none of them. */
const SETTLING_MS = 24 * 60 * 60 * 1000;

/** One volume on the machine, as a screen shows it. */
export interface HostVolume {
    readonly name: string;
    /** What it is holding, or null where the daemon did not measure it. */
    readonly bytes: number | null;
    /** Whether a container - running or not - still references it. */
    readonly inUse: boolean;
    /** The compose project it was created under, when it says so. */
    readonly project: string | null;
    readonly createdAt: string | null;
    /** The app Polaris knows this volume belongs to, or null when it has no
     *  record of it. Set even while that app is stopped. */
    readonly owner: string | null;
    /** Whether it may be offered for removal: nothing references it, Polaris has
     *  no record of it, and it is old enough to have settled. */
    readonly spare: boolean;
}

interface DockerVolume {
    Name?: string;
    CreatedAt?: string;
    Labels?: Record<string, string> | null;
    UsageData?: { Size?: number; RefCount?: number } | null;
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function bytes(value: unknown): number | null {
    // The daemon reports -1 for "not measured", which is not a size.
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

async function read(daemon: HostdClient, path: string): Promise<unknown | null> {
    const reply = await daemon.dockerRequest("GET", path).catch(() => null);
    if (!reply || reply.status !== 200) return null;
    try {
        return JSON.parse(reply.body) as unknown;
    } catch {
        return null;
    }
}

/** The volume names Polaris created for something, whatever state that thing is
 *  in. Read from its own records rather than from the daemon: a stopped app's
 *  volume looks exactly like an abandoned one to Docker. */
async function claimed(): Promise<Map<string, string>> {
    const rows = await prisma.volume
        .findMany({
            where: { kind: "volume", source: { not: null } },
            select: { source: true, application: { select: { name: true } } }
        })
        .catch(() => []);
    const names = new Map<string, string>();
    for (const row of rows) {
        if (row.source) names.set(row.source, row.application?.name ?? "an app on this machine");
    }
    return names;
}

/**
 * Every volume on the machine Polaris runs on, largest first.
 *
 * Null - never an empty list - when the daemon will not answer, so a screen can
 * tell "this machine holds no volumes" from "this machine would not say".
 *
 * Sizes come from `/system/df`, which is the only call that measures them;
 * `/volumes` is what knows when each one was created and what it was labelled
 * with. A volume missing from either is still listed, with what is known.
 */
export async function hostVolumes(): Promise<HostVolume[] | null> {
    const daemon = new HostdClient();
    const [listing, df, records] = await Promise.all([
        read(daemon, "/volumes"),
        read(daemon, "/system/df"),
        claimed()
    ]);
    if (!listing) return null;

    const meta = new Map<string, DockerVolume>();
    for (const entry of ((listing as { Volumes?: DockerVolume[] }).Volumes ?? []) as DockerVolume[]) {
        const name = text(entry?.Name);
        if (name) meta.set(name, entry);
    }
    const usage = new Map<string, DockerVolume>();
    for (const entry of ((df as { Volumes?: DockerVolume[] } | null)?.Volumes ?? []) as DockerVolume[]) {
        const name = text(entry?.Name);
        if (name) usage.set(name, entry);
    }

    const now = Date.now();
    const volumes = [...new Set([...meta.keys(), ...usage.keys()])].map<HostVolume>((name) => {
        const entry = meta.get(name);
        const measured = usage.get(name);
        const createdAt = text(entry?.CreatedAt);
        const age = createdAt ? now - new Date(createdAt).getTime() : Number.POSITIVE_INFINITY;
        const owner = records.get(name) ?? null;
        // RefCount is absent on the plain listing, so "in use" is read from the
        // measured record and an unmeasured volume is assumed to be in use.
        // Guessing the other way would offer to delete a database.
        const refs = measured ? (measured.UsageData?.RefCount ?? 0) : 1;
        const inUse = refs > 0;
        return {
            name,
            bytes: bytes(measured?.UsageData?.Size),
            inUse,
            project: text(entry?.Labels?.["com.docker.compose.project"]),
            createdAt,
            owner,
            spare: !inUse && owner === null && Number.isFinite(age) && age > SETTLING_MS
        };
    });

    return volumes.sort((left, right) => (right.bytes ?? 0) - (left.bytes ?? 0));
}

/** Why a volume was not removed, in the terms the screen says it in. */
export type VolumeRemoval = { ok: true } | { ok: false; reason: string };

/**
 * Remove one volume, named in full.
 *
 * Re-checked here rather than trusted from the screen: the list it was chosen
 * from is a picture of a moment, and a container may have attached the volume
 * since. The daemon refuses an attached volume as well, which is the backstop
 * for the gap between this check and the call.
 */
export async function removeHostVolume(name: string): Promise<VolumeRemoval> {
    const volumes = await hostVolumes();
    if (!volumes) return { ok: false, reason: "This machine would not say what it is holding." };
    const volume = volumes.find((entry) => entry.name === name);
    if (!volume) return { ok: false, reason: "That volume is not on this machine any more." };
    if (volume.inUse) return { ok: false, reason: "Something is using it now. Nothing was removed." };
    if (volume.owner) return { ok: false, reason: `It belongs to ${volume.owner}. Nothing was removed.` };

    const reply = await new HostdClient()
        .dockerRequest("DELETE", `/volumes/${encodeURIComponent(name)}`)
        .catch(() => null);
    if (!reply) return { ok: false, reason: "This machine would not answer. Nothing was removed." };
    if (reply.status === 204) return { ok: true };
    if (reply.status === 409) return { ok: false, reason: "Something is using it now. Nothing was removed." };
    if (reply.status === 404) return { ok: false, reason: "That volume is not on this machine any more." };
    return { ok: false, reason: "This machine refused to remove it." };
}

/**
 * Keeping a machine's kept release images to the ones a rollback can use.
 *
 * Every successful deploy pins its image as `polaris-release/<service>:<hash>`,
 * and every prune Polaris runs leaves anything under that label alone - that is
 * what keeps a rollback target alive. The only thing that ever removed one was
 * the per-service tidy-up after a promotion, and it removed only what the
 * database said was kept. Everything it did not know about stayed forever: the
 * image of a deploy that failed after it was pinned, of one that was cancelled,
 * of a service that was deleted or renamed, and of a removal that failed once.
 * One production host filled to 99% that way - one service held eight versions
 * of a 1.25 GB image - and the database on it crash-looped for want of a byte.
 *
 * So this reads the images the engine actually holds, not the rows that say what
 * it should hold, and removes every release image nothing can still want:
 *
 * - never one a container is on, running or stopped (and the engine refuses a
 *   non-forced removal of one anyway);
 * - never the image a service is serving, a pinned one, one a running release
 *   or canary runs, one an in-flight rollback is about to run, or one inside the
 *   service's rollback window (`ROLLBACK_WINDOW`);
 * - never one a deploy in flight has just pinned and not yet started, nor any
 *   image younger than `GRACE_MS`, so a pin that lands between the listing and
 *   the removal is not taken.
 *
 * Whatever it removes is marked as no longer kept, so the history stops offering
 * a rollback to it; and a kept row whose image is no longer on the machine at all
 * is marked the same way, so a rollback is never offered for an image that is
 * already gone.
 *
 * Runs after every promotion and on the housekeeping timer, so an install that
 * filled up before this existed is cleaned on its first pass after the update.
 *
 * Server-only. Safe to re-run.
 */

import { prisma } from "@polaris/db";
import { HostdClient } from "@polaris/hostd-client";
import { imagesOutsideWindow } from "@/lib/deploy/releases";
import { getHostConnectionUnscoped } from "@/lib/host-service";
import { IN_FLIGHT_DEPLOY_STATUSES } from "@/lib/deploy/status";
import { onServer, serversWithDeployments } from "@/lib/deploy/server-space";
import { RELEASE_REPOSITORY, isReleaseImage, quoteArg, shortHash } from "@polaris/deploy";
import {
    ImageStoreBusy,
    LOCAL_MACHINE,
    sshMachine,
    withImagePrune
} from "@/lib/deploy/image-store-lock";

/**
 * How many releases of one service keep their image besides the one serving it:
 * one, so the newest previous release is an instant rollback. Current plus one is
 * two images per service, which is the most a host should ever hold for one.
 */
export const ROLLBACK_WINDOW = 1;

/** An image this young is left alone whatever else is true of it. A deploy pins
 *  its image a moment before it starts a container on it, and a sweep that runs
 *  in between must not take it. */
export const GRACE_MS = 2 * 60 * 60_000;

/** One release image as the engine lists it. */
export interface EngineReleaseImage {
    /** `polaris-release/<service>:<hash>`. */
    readonly ref: string;
    /** When the engine says it was made, epoch milliseconds; null when it would
     *  not say, which is read as "too young to touch". */
    readonly createdAt: number | null;
    /** Whether any container, running or stopped, is on it. */
    readonly inUse: boolean;
    /** Bytes, where the engine said. */
    readonly size: number;
}

/**
 * Which listed release images can go: every one that is not protected, not in
 * use, and older than the grace period. Pure, so the rule is the thing tested.
 */
export function releaseImagesToRemove(
    listed: readonly EngineReleaseImage[],
    protectedRefs: ReadonlySet<string>,
    now: number,
    graceMs: number = GRACE_MS
): EngineReleaseImage[] {
    return listed.filter(
        (image) =>
            isReleaseImage(image.ref) &&
            !image.inUse &&
            !protectedRefs.has(image.ref) &&
            image.createdAt !== null &&
            now - image.createdAt >= graceMs
    );
}

/** What the database says about one deployment, as far as retention cares. */
export interface RetentionRow {
    readonly id: string;
    readonly deployableId: string;
    readonly imageTag: string | null;
    readonly status: string;
    readonly pinned: boolean;
    readonly imageKept: boolean;
    readonly rollbackOfId: string | null;
}

/**
 * Every release image something can still want, from the database's side.
 *
 * `rows` are the deployments of existing services that are kept, pinned,
 * running, in flight, serving, or the source of an in-flight rollback.
 * In-flight deploys are protected by the tag their pin will have, which is
 * derived from the deployment itself - the row does not carry it until the
 * deploy settles.
 */
export function protectedReleaseRefs(
    rows: readonly RetentionRow[],
    currentByApp: ReadonlyMap<string, string | null>,
    window: number = ROLLBACK_WINDOW
): { refs: Set<string>; inFlightHashes: Set<string> } {
    const refs = new Set<string>();
    const inFlightHashes = new Set<string>();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const inFlight = new Set<string>(IN_FLIGHT_DEPLOY_STATUSES);
    const kept = new Map<string, RetentionRow[]>();
    for (const row of rows) {
        const current = currentByApp.get(row.deployableId) === row.id;
        if (
            row.imageTag &&
            (current || row.pinned || row.status === "running" || inFlight.has(row.status))
        ) {
            refs.add(row.imageTag);
        }
        if (inFlight.has(row.status)) {
            inFlightHashes.add(shortHash(row.id, 12));
            const source = row.rollbackOfId ? byId.get(row.rollbackOfId) : undefined;
            if (source?.imageTag) refs.add(source.imageTag);
        }
        if (row.imageKept) kept.set(row.deployableId, [...(kept.get(row.deployableId) ?? []), row]);
    }
    // The rollback window, counted the way the per-service tidy-up counts it.
    for (const [appId, list] of kept) {
        const gone = new Set(imagesOutsideWindow(list, currentByApp.get(appId) ?? null, window));
        for (const row of list) if (row.imageTag && !gone.has(row.imageTag)) refs.add(row.imageTag);
    }
    return { refs, inFlightHashes };
}

/** Adds the refs of in-flight pins to a protected set, by their tag. */
function withInFlight(
    listed: readonly EngineReleaseImage[],
    refs: ReadonlySet<string>,
    inFlightHashes: ReadonlySet<string>
): Set<string> {
    const all = new Set(refs);
    for (const image of listed) {
        const tag = image.ref.slice(image.ref.lastIndexOf(":") + 1);
        if (inFlightHashes.has(tag)) all.add(image.ref);
    }
    return all;
}

/** Docker's `CreatedAt` column: `2026-10-01 12:00:00 +0000 UTC`. Null when it is
 *  not that shape. */
export function parseEngineDate(value: string): number | null {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})/.exec(
        value.trim()
    );
    if (!match) return null;
    const parsed = Date.parse(`${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`);
    return Number.isFinite(parsed) ? parsed : null;
}

/** Bytes from a size docker prints (`1.25GB`, `512MB`, `0B`). Decimal units, the
 *  way the engine prints them. Zero when unreadable. */
export function parseEngineSize(value: string): number {
    const match = /^([\d.]+)\s*([kmgt]?i?b)$/i.exec(value.trim());
    if (!match) return 0;
    const units: Record<string, number> = {
        b: 1,
        kb: 1e3,
        mb: 1e6,
        gb: 1e9,
        tb: 1e12,
        kib: 1024,
        mib: 1024 ** 2,
        gib: 1024 ** 3,
        tib: 1024 ** 4
    };
    const unit = units[(match[2] ?? "").toLowerCase()];
    const size = Number(match[1]);
    return unit && Number.isFinite(size) ? Math.round(size * unit) : 0;
}

/** The last line of a listing that finished. */
const LISTED = "polaris-listed|";
const PS_LISTED = "polaris-ps|";

/** Lists a server's release images and the image every container is on. */
export const LIST_RELEASE_IMAGES = [
    `docker images --filter 'reference=${RELEASE_REPOSITORY}/*' --format 'img|{{.Repository}}:{{.Tag}}|{{.CreatedAt}}|{{.Size}}' && echo '${LISTED}'`,
    `docker ps -a --format 'ctr|{{.Image}}' && echo '${PS_LISTED}'`
].join("; ");

/**
 * A server's listing, or null when it did not finish - either half missing is
 * "could not tell what is in use", which is never a reason to remove anything.
 */
export function parseServerListing(said: string): EngineReleaseImage[] | null {
    const lines = said.split("\n").map((line) => line.trim());
    if (!lines.includes(LISTED) || !lines.includes(PS_LISTED)) return null;
    const used = new Set(
        lines.filter((line) => line.startsWith("ctr|")).map((line) => line.slice(4))
    );
    return lines
        .filter((line) => line.startsWith("img|"))
        .map((line) => {
            const [ref = "", created = "", size = ""] = line.slice(4).split("|");
            return {
                ref,
                createdAt: parseEngineDate(created),
                inUse: used.has(ref),
                size: parseEngineSize(size)
            };
        })
        .filter((image) => isReleaseImage(image.ref));
}

/** The shape of `/system/df` read here; anything else in the reply is ignored. */
interface DfImage {
    RepoTags?: string[] | null;
    Created?: number;
    Containers?: number;
    Size?: number;
}

/** The release images in a `/system/df` reply, or null when it is not one. */
export function parseDfReleaseImages(body: string): EngineReleaseImage[] | null {
    let parsed: { Images?: DfImage[] | null };
    try {
        parsed = JSON.parse(body) as typeof parsed;
    } catch {
        return null;
    }
    if (!parsed || !Array.isArray(parsed.Images)) return null;
    return parsed.Images.flatMap((image) =>
        (image.RepoTags ?? []).filter(isReleaseImage).map((ref) => ({
            ref,
            createdAt: typeof image.Created === "number" ? image.Created * 1000 : null,
            // Unknown (-1) counts as in use: a count the daemon did not take is
            // not proof that nothing is on it.
            inUse: typeof image.Containers !== "number" || image.Containers !== 0,
            size: typeof image.Size === "number" && image.Size > 0 ? image.Size : 0
        }))
    );
}

/** One machine Polaris deploys to, as the sweep reaches it. */
interface Machine {
    /** `local`, or the host's id. */
    readonly id: string;
    readonly lock: string;
    list(): Promise<EngineReleaseImage[] | null>;
    /** Removes each image it can; answers the ones that are gone. */
    remove(refs: readonly string[]): Promise<string[]>;
}

function localMachine(): Machine {
    const daemon = new HostdClient();
    return {
        id: LOCAL_MACHINE,
        lock: LOCAL_MACHINE,
        async list() {
            const reply = await daemon
                .dockerRequest("GET", "/system/df?type=image")
                .catch(() => null);
            if (!reply || reply.status !== 200) return null;
            return parseDfReleaseImages(reply.body);
        },
        async remove(refs) {
            const gone: string[] = [];
            for (const ref of refs) {
                // Not forced: an image a container is on is refused by the engine.
                const reply = await daemon
                    .dockerRequest("DELETE", `/images/${ref}`)
                    .catch(() => null);
                if (reply && ((reply.status >= 200 && reply.status < 300) || reply.status === 404))
                    gone.push(ref);
            }
            return gone;
        }
    };
}

async function serverMachine(hostId: string): Promise<Machine | null> {
    const connection = await getHostConnectionUnscoped(hostId).catch(() => null);
    if (!connection) return null;
    return {
        id: hostId,
        lock: sshMachine(connection.address, connection.port),
        async list() {
            const said = await onServer(hostId, LIST_RELEASE_IMAGES);
            return said === null ? null : parseServerListing(said);
        },
        async remove(refs) {
            const safe = refs.filter(isReleaseImage);
            if (safe.length === 0) return [];
            const command = safe
                .map(
                    (ref) =>
                        `docker image rm ${quoteArg(ref)} >/dev/null 2>&1 && echo ${quoteArg(`gone|${ref}`)}`
                )
                .join("; ");
            const said = await onServer(hostId, `${command}; true`);
            if (said === null) return [];
            const gone = new Set(
                said
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line.startsWith("gone|"))
                    .map((line) => line.slice(5))
            );
            return safe.filter((ref) => gone.has(ref));
        }
    };
}

/** The machine a deploy target runs its containers on: `local`, a host id, or
 *  null where that is not one machine - a swarm places its tasks across nodes,
 *  so one node's listing says nothing about whether an image is still there. */
/** The machine a service's release images live on, as a sweep names it. */
export function machineOfTarget(
    target: { kind: string; hostId: string | null; runtime: string } | null
): string | null {
    if (!target || target.runtime !== "compose") return null;
    if (target.kind === "local") return LOCAL_MACHINE;
    if (target.kind === "host" && target.hostId) return target.hostId;
    return null;
}

/** What the database protects, read once per sweep. */
async function protectedFromDatabase(window: number): Promise<{
    refs: Set<string>;
    inFlightHashes: Set<string>;
    keptByMachine: Map<string, { id: string; imageTag: string; createdAt: Date }[]>;
}> {
    const apps = await prisma.application.findMany({
        select: {
            id: true,
            currentDeploymentId: true,
            target: { select: { kind: true, hostId: true, runtime: true } }
        }
    });
    const currentByApp = new Map(apps.map((app) => [app.id, app.currentDeploymentId]));
    const machineOf = new Map(apps.map((app) => [app.id, machineOfTarget(app.target)]));
    const currentIds = apps
        .map((app) => app.currentDeploymentId)
        .filter((id): id is string => id !== null);
    const rows = await prisma.deployment.findMany({
        where: {
            deployableType: "application",
            deployableId: { in: apps.map((app) => app.id) },
            OR: [
                { imageKept: true },
                { pinned: true },
                { status: { in: ["running", ...IN_FLIGHT_DEPLOY_STATUSES] } },
                { id: { in: currentIds } }
            ]
        },
        select: {
            id: true,
            deployableId: true,
            imageTag: true,
            status: true,
            pinned: true,
            imageKept: true,
            rollbackOfId: true,
            createdAt: true
        },
        orderBy: { createdAt: "desc" }
    });
    // A rollback in flight runs its source's image; the source may be outside
    // every other condition above.
    const missing = rows
        .filter((row) => row.rollbackOfId && !rows.some((other) => other.id === row.rollbackOfId))
        .map((row) => row.rollbackOfId as string);
    const sources =
        missing.length > 0
            ? await prisma.deployment.findMany({
                  where: { id: { in: missing } },
                  select: {
                      id: true,
                      deployableId: true,
                      imageTag: true,
                      status: true,
                      pinned: true,
                      imageKept: true,
                      rollbackOfId: true,
                      createdAt: true
                  }
              })
            : [];
    const { refs, inFlightHashes } = protectedReleaseRefs(
        [...rows, ...sources],
        currentByApp,
        window
    );
    const keptByMachine = new Map<string, { id: string; imageTag: string; createdAt: Date }[]>();
    for (const row of rows) {
        if (!row.imageKept || !row.imageTag) continue;
        const machine = machineOf.get(row.deployableId);
        if (!machine) continue;
        keptByMachine.set(machine, [
            ...(keptByMachine.get(machine) ?? []),
            { id: row.id, imageTag: row.imageTag, createdAt: row.createdAt }
        ]);
    }
    return { refs, inFlightHashes, keptByMachine };
}

/** What one machine's pass did. */
export interface ReleaseSweep {
    readonly machine: string;
    readonly removed: number;
    readonly freed: number;
    /** False when the machine could not be listed, or was busy. */
    readonly ran: boolean;
    /** True when it was skipped because a deploy was fetching or building there. */
    readonly busy?: boolean;
}

async function sweepMachine(
    machine: Machine,
    database: Awaited<ReturnType<typeof protectedFromDatabase>>
): Promise<ReleaseSweep> {
    const idle = { machine: machine.id, removed: 0, freed: 0, ran: false };
    try {
        return await withImagePrune(
            machine.lock,
            async () => {
                const listedAt = Date.now();
                const listed = await machine.list();
                if (!listed) return idle;
                const protectedRefs = withInFlight(listed, database.refs, database.inFlightHashes);
                const doomed = releaseImagesToRemove(listed, protectedRefs, listedAt);
                const gone =
                    doomed.length > 0 ? await machine.remove(doomed.map((image) => image.ref)) : [];
                // Whatever is gone from this machine, by this pass or before it, is
                // no rollback target any more. Only rows older than the grace: one
                // that settled after the listing was taken is not in it yet.
                const present = new Set(listed.map((image) => image.ref));
                const goneSet = new Set(gone);
                const stale = (database.keptByMachine.get(machine.id) ?? [])
                    .filter(
                        (row) =>
                            goneSet.has(row.imageTag) ||
                            (!present.has(row.imageTag) &&
                                listedAt - row.createdAt.getTime() >= GRACE_MS)
                    )
                    .map((row) => row.id);
                if (stale.length > 0) {
                    await prisma.deployment.updateMany({
                        where: { id: { in: stale } },
                        data: { imageKept: false, pinned: false }
                    });
                }
                const freed = doomed
                    .filter((image) => goneSet.has(image.ref))
                    .reduce((sum, image) => sum + image.size, 0);
                return { machine: machine.id, removed: gone.length, freed, ran: true };
            },
            { whenIdle: true }
        );
    } catch (error) {
        if (error instanceof ImageStoreBusy) return { ...idle, busy: true };
        throw error;
    }
}

/**
 * Remove the release images nothing can still want, on one machine (`local` or
 * a host id) or on every machine Polaris deploys to.
 *
 * `window` is how many earlier releases per service stay for a rollback. A disk
 * that is running out passes 0: a rollback target is worth less than the
 * database on that disk being able to write, and the serving and pinned images
 * stay whatever it is.
 */
export async function sweepReleaseImages(
    only?: string,
    window: number = ROLLBACK_WINDOW
): Promise<ReleaseSweep[]> {
    const database = await protectedFromDatabase(window);
    const machines: Machine[] = [];
    if (!only || only === LOCAL_MACHINE) machines.push(localMachine());
    const hosts =
        only && only !== LOCAL_MACHINE
            ? [only]
            : only
              ? []
              : (await serversWithDeployments()).map((server) => server.id);
    for (const hostId of hosts) {
        const machine = await serverMachine(hostId);
        if (machine) machines.push(machine);
    }
    const swept: ReleaseSweep[] = [];
    // One at a time: one machine failing must not stop the others.
    for (const machine of machines) {
        swept.push(
            await sweepMachine(machine, database).catch((error: unknown) => {
                console.error(`polaris: release image sweep on ${machine.id} failed:`, error);
                return { machine: machine.id, removed: 0, freed: 0, ran: false };
            })
        );
    }
    return swept;
}

/** The same, for the machine one service deploys to - after its promotion. */
export async function sweepReleaseImagesFor(applicationId: string): Promise<void> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { target: { select: { kind: true, hostId: true, runtime: true } } }
    });
    const machine = app ? machineOfTarget(app.target) : null;
    if (machine) await sweepReleaseImages(machine);
}

/**
 * How much room the container store is taking on this machine, and giving some
 * of it back.
 *
 * Written after a deploy failed with this, and nothing else:
 *
 *   failed commit on ref "layer-sha256:d54b0e...": commit failed: rename
 *   .../ingest/3f7c.../data .../blobs/sha256/d54b0e...: no such file or directory
 *
 * The disk was at 97%. The image had nowhere to land, the store reported that as
 * a rename it could not finish, and nobody reading it would guess at disk space.
 * Worse, there was nothing an operator could do about it from Polaris at all -
 * the only fix was a terminal and two docker commands, on a product whose first
 * rule is that the command line is not a requirement for anything.
 *
 * So: the split is readable, and the two kinds of room that hold nothing anybody
 * wrote can be handed back from a button.
 *
 * What it deliberately cannot touch is volumes. They are usually the largest
 * thing on the disk and every byte of them is somebody's save file, database or
 * upload; build cache and untagged layers come back on the next build or pull,
 * at the cost of time. That line is drawn in the daemon's allowlist as well as
 * here, so no caller can cross it by asking differently.
 *
 * Server-only.
 */

import { HostdClient } from "@polaris/hostd-client";

/** What the container store is holding, in bytes. */
export interface HostSpace {
    readonly images: number;
    readonly containers: number;
    readonly volumes: number;
    readonly buildCache: number;
    /**
     * What pressing the button would give back: build cache nothing is using,
     * plus layers no tag points at any more.
     *
     * An estimate, and named as one everywhere it is shown. The daemon reports
     * what each record is and whether it is in use; what a prune actually
     * removes is decided when it runs, and it reports that exactly.
     */
    readonly reclaimable: number;
}

/** The shapes of `/system/df` this reads. Everything else the daemon sends is
 *  ignored rather than typed: this is an untrusted reply from a socket. */
interface DfImage {
    Size?: number;
    Containers?: number;
}
interface DfContainer {
    SizeRw?: number;
}
interface DfVolume {
    UsageData?: { Size?: number; RefCount?: number } | null;
}
interface DfBuildCache {
    Size?: number;
    InUse?: boolean;
    Shared?: boolean;
}

function bytes(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** What the container store is holding on the machine Polaris runs on, or null
 *  where the daemon cannot answer - the limited edition, or a host whose socket
 *  is not reachable. Null is "cannot say", never "nothing". */
export async function hostSpace(): Promise<HostSpace | null> {
    const reply = await new HostdClient().dockerRequest("GET", "/system/df").catch(() => null);
    if (!reply || reply.status !== 200) return null;

    let body: {
        Images?: DfImage[];
        Containers?: DfContainer[];
        Volumes?: DfVolume[];
        BuildCache?: DfBuildCache[];
    };
    try {
        body = JSON.parse(reply.body) as typeof body;
    } catch {
        return null;
    }

    const images = (body.Images ?? []).reduce((total, image) => total + bytes(image.Size), 0);
    const containers = (body.Containers ?? []).reduce(
        (total, container) => total + bytes(container.SizeRw),
        0
    );
    const volumes = (body.Volumes ?? []).reduce(
        (total, volume) => total + bytes(volume.UsageData?.Size),
        0
    );
    const cache = body.BuildCache ?? [];
    const buildCache = cache.reduce((total, record) => total + bytes(record.Size), 0);

    // Build cache nothing is currently using, and images no container is on.
    // Shared cache records are counted once by the daemon and would be
    // double-counted here, so they are left out of the estimate.
    const looseCache = cache
        .filter((record) => record.InUse !== true && record.Shared !== true)
        .reduce((total, record) => total + bytes(record.Size), 0);
    const looseImages = (body.Images ?? [])
        .filter((image) => bytes(image.Containers) === 0)
        .reduce((total, image) => total + bytes(image.Size), 0);

    return { images, containers, volumes, buildCache, reclaimable: looseCache + looseImages };
}

/**
 * Hand back the room that holds nothing anybody wrote.
 *
 * Both prunes run even if the first frees nothing, because they hold different
 * things and an operator pressing this once means both. What comes back is what
 * the daemon actually removed rather than the estimate above - that is the
 * number worth showing, and the two do not always agree.
 */
export async function reclaimHostSpace(): Promise<number | null> {
    const daemon = new HostdClient();
    let freed = 0;
    let answered = false;

    for (const path of ["/build/prune", "/images/prune"]) {
        const reply = await daemon.dockerRequest("POST", path).catch(() => null);
        if (!reply || reply.status < 200 || reply.status >= 300) continue;
        answered = true;
        try {
            const body = JSON.parse(reply.body) as { SpaceReclaimed?: number };
            freed += bytes(body.SpaceReclaimed);
        } catch {
            // It removed something and would not say how much. The caller reads
            // the space again afterwards, which is the honest number anyway.
        }
    }
    return answered ? freed : null;
}

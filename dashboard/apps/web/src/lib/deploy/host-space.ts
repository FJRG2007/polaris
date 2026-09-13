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
 * upload; build cache and the images no container is on come back from a build
 * or a pull, at the cost of the time to fetch them. That line is drawn in the
 * daemon's allowlist as well as here, so no caller can cross it by asking
 * differently.
 *
 * The one image this does not reach is a release Polaris pinned so a service can
 * be rolled back to it. Those carry a label, the prune excludes it, and they are
 * left out of the estimate as well - room that cannot be handed back has no
 * business being offered.
 *
 * Server-only.
 */

import { HostdClient } from "@polaris/hostd-client";
import { RELEASE_LABEL, RELEASE_REPOSITORY } from "@polaris/deploy";

/** What the container store is holding, in bytes. */
export interface HostSpace {
    readonly images: number;
    readonly containers: number;
    readonly volumes: number;
    readonly buildCache: number;
    /**
     * What pressing the button would give back: build cache nothing is using,
     * plus every image no container is on that is not a pinned release.
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
    RepoTags?: string[] | null;
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

/**
 * Whether this image is one Polaris pinned so a service can be rolled back to it.
 *
 * Read off the tags rather than the label, because `/system/df` reports tags and
 * not labels - and the repository is Polaris's own, so nothing an operator pulled
 * or built by hand can land in it. An image with no tags left is untagged rather
 * than pinned, which is exactly the kind a prune is for.
 */
function isPinnedRelease(image: DfImage): boolean {
    const tags = (image.RepoTags ?? []).filter((tag) => tag && tag !== "<none>:<none>");
    return tags.length > 0 && tags.every((tag) => tag.startsWith(`${RELEASE_REPOSITORY}/`));
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
    // A pinned release is not loose. It is the file a rollback restores, the
    // prune excludes it by its label, and counting it here would offer room that
    // pressing the button cannot hand back.
    const looseImages = (body.Images ?? [])
        .filter((image) => bytes(image.Containers) === 0 && !isPinnedRelease(image))
        .reduce((total, image) => total + bytes(image.Size), 0);

    return { images, containers, volumes, buildCache, reclaimable: looseCache + looseImages };
}

/**
 * The images prune, asking for every image no container is on rather than only
 * the untagged ones.
 *
 * `dangling=false` is Docker's way of saying "unused, tagged or not". Without it
 * a prune takes only the layers no tag points at any more, which on a real
 * machine is the smaller half: what actually accumulates is whole images that
 * were pulled for something that has since been removed - a database engine
 * tried once, the base images of a build, the image of an app somebody stopped.
 * That was the ten gigabytes this module measured as reclaimable, offered to
 * hand back, and then did not remove.
 *
 * `label!=polaris.release` is the line that makes it safe, and it is the same
 * one the sweep over enrolled servers has always drawn: an image Polaris pinned
 * so a service can be rolled back to it carries that label, so a rollback target
 * is never what gets taken. Everything else comes back from a pull, at the cost
 * of the time to fetch it - which is why an app that is merely stopped loses
 * nothing but a download on its next start.
 *
 * Encoded rather than inlined: the daemon's allowlist refuses a path with a
 * space in it, and a JSON filter has braces and quotes the socket should not be
 * handed raw.
 */
export function unusedImagesPrunePath(): string {
    const filters = JSON.stringify({ dangling: ["false"], "label!": [RELEASE_LABEL] });
    return `/images/prune?filters=${encodeURIComponent(filters)}`;
}

/**
 * Hand back the room that holds nothing anybody wrote.
 *
 * Both prunes run even if the first frees nothing, because they hold different
 * things and an operator pressing this once means both. What comes back is what
 * the daemon actually removed rather than the estimate above - that is the
 * number worth showing, and the two do not always agree.
 *
 * What this will never reach is a volume: not through a filter, not by asking
 * differently, and not by accident. The daemon's allowlist has no route for
 * pruning them at all.
 */
export async function reclaimHostSpace(): Promise<number | null> {
    const daemon = new HostdClient();
    let freed = 0;
    let answered = false;

    for (const path of ["/build/prune", unusedImagesPrunePath()]) {
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

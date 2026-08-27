/**
 * The machine's own disk, read from inside the container Polaris runs in.
 *
 * `/` in a container is an overlay whose upper layer lives on the machine's
 * filesystem, and `statfs` there reports that filesystem - the same figures `df`
 * gives on the box. It is the only reading of the disk available in every
 * edition: it needs no privileged daemon, no shell on the host and no new
 * transport, which is what a deployment that is only ever updated from a button
 * can be counted on to have.
 *
 * Here rather than beside its first caller because two things now need it - the
 * metrics the graphs are drawn from, and the housekeeping that decides whether
 * the disk is tight enough to hand room back - and two readings of the same
 * number that could disagree is one too many.
 *
 * Used, not free-as-used: what is counted is what `df` calls used, so the number
 * beside the total is the number an operator would see on the machine.
 *
 * Server-only.
 */

export interface LocalDisk {
    readonly used: number;
    readonly total: number;
}

/** Null where this cannot be asked - a dev run on Windows, or a filesystem that
 *  will not answer. Null is "cannot say", never "there is plenty". */
export async function localDisk(): Promise<LocalDisk | null> {
    try {
        const { statfs } = await import("node:fs/promises");
        const info = await statfs("/");
        const size = Number(info.bsize);
        const total = Number(info.blocks) * size;
        const free = Number(info.bfree) * size;
        if (!Number.isFinite(total) || total <= 0) return null;
        return { total, used: Math.max(0, total - free) };
    } catch {
        return null;
    }
}

/** How full it is, 0 to 1. */
export function diskFullness(disk: LocalDisk): number {
    return disk.total > 0 ? disk.used / disk.total : 0;
}

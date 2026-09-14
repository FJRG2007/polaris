/**
 * Whether a newer extension has been published, and what that means for the
 * person running this one.
 *
 * An extension loaded by hand never updates itself. That is the whole point of
 * the warning: somebody who unpacked a .zip into `chrome://extensions` in March
 * is still running March's build, with nothing anywhere that would ever say so -
 * and unlike the dashboard, this cannot update itself even in principle.
 *
 * What to tell them depends entirely on how it got here, so that is read rather
 * than assumed. A build installed from a store is updated by the store once the
 * new version is reviewed, and the only honest thing to say is that it is coming;
 * telling that person to go and re-load a folder would be sending them to undo a
 * working install. A build loaded from disk has to be loaded again, by hand, by
 * them.
 *
 * Everything here is pure. The comparison in particular: a version is not a
 * number and is not a string either, and comparing two of them as text puts 0.10
 * before 0.2 - which reads on screen as "you are up to date" for every version
 * after the ninth.
 */

/** How this build got here, in the two answers that change what to say. */
export type InstallKind = "store" | "manual";

/** A newer build, and what the reader can do about it. */
export interface UpdateNotice {
    /** The version that is out, as its tag spells it. */
    readonly version: string;
    /** Where to read what changed, and where the files are. */
    readonly url: string;
    readonly kind: InstallKind;
}

/** What the server answers. Every field `unknown` until it is checked: this
 *  arrives over the network, from a server the reader named. */
export interface VersionAnswer {
    readonly version?: unknown;
    readonly url?: unknown;
}

function segments(version: string): number[] {
    return version
        .trim()
        .replace(/^v/i, "")
        // A prerelease suffix is not part of the ordering this needs: the server
        // never offers one (`pickRelease` drops prereleases), so anything after a
        // dash is noise rather than a decision.
        .split("-")[0]!
        .split(".")
        .map((part) => {
            const number = Number.parseInt(part, 10);
            return Number.isFinite(number) ? number : 0;
        });
}

/**
 * -1, 0 or 1, comparing versions the way versions compare.
 *
 * Segment by segment as numbers, with a missing segment counting as zero, so
 * `0.2` and `0.2.0` are the same version and `0.10.0` is newer than `0.2.0`.
 */
export function compareVersions(left: string, right: string): number {
    const a = segments(left);
    const b = segments(right);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const difference = (a[i] ?? 0) - (b[i] ?? 0);
        if (difference !== 0) return difference > 0 ? 1 : -1;
    }
    return 0;
}

/** Whether what is published is newer than what is running. */
export function isNewer(available: string, running: string): boolean {
    return compareVersions(available, running) > 0;
}

/**
 * What `management.getSelf()` reported, reduced to the only distinction that
 * changes the advice.
 *
 * Only `normal` - installed from an install package - is a build something else
 * keeps up to date. `development` is the unpacked or temporary load this warning
 * mostly exists for; `sideload` and `admin` were put there by other software or
 * by policy, and Polaris cannot promise either of those will ever be updated. So
 * everything that is not plainly a store install is told how to do it by hand,
 * which is the direction that leaves nobody stranded on an old build.
 */
export function installKind(installType: string | undefined | null): InstallKind {
    return installType === "normal" ? "store" : "manual";
}

/**
 * The notice to show, or null when there is nothing to say.
 *
 * Null covers every ordinary case at once: no release published, the server not
 * reachable, an answer that is not the shape it should be, and - the common one -
 * a published version that is the one already running.
 */
export function noticeFor(
    answer: VersionAnswer | null,
    running: string,
    installType: string | undefined | null
): UpdateNotice | null {
    if (!answer) return null;
    const { version, url } = answer;
    if (typeof version !== "string" || version === "") return null;
    if (typeof url !== "string" || url === "") return null;
    if (!isNewer(version, running)) return null;
    return { version, url, kind: installKind(installType) };
}

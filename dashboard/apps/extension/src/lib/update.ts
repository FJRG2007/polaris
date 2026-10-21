/**
 * Whether a newer extension has been published, and what that means for the
 * person running this one.
 *
 * An extension loaded by hand never updates itself unless something replaces its
 * files. The one-line install from the downloads page leaves exactly that behind -
 * a job of the user's own that swaps in each new release - but a copy loaded by
 * following the steps, a zip unpacked by hand, and Firefox's temporary add-on have
 * nothing of the kind: somebody who unpacked a .zip in March is still running
 * March's build, with nothing anywhere that would ever say so.
 *
 * What to tell them depends entirely on how it got here, so that is read rather
 * than assumed. A build installed from a store is updated by the store once the
 * new version is reviewed, and the only honest thing to say is that it is coming;
 * telling that person to go and re-load a folder would be sending them to undo a
 * working install. A build loaded from disk has to be loaded again, by hand, by
 * them - and the popup points at the steps on their own Polaris, never at a
 * command to type.
 *
 * Everything here is pure. The comparison in particular: a version is not a
 * number and is not a string either, and comparing two of them as text puts 0.10
 * before 0.2 - which reads on screen as "you are up to date" for every version
 * after the ninth.
 */

/**
 * How this build got here, in the answers that change what to say: from a store,
 * loaded from a folder the install script's job keeps current (`auto` - see
 * `lib/self-update.ts`), loaded by hand with nothing keeping it current, or kept
 * current by the Polaris desktop app (`desktop` - see `managedByDesktop`).
 */
export type InstallKind = "store" | "auto" | "manual" | "desktop";

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
    return (
        version
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
            })
    );
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
export function installKind(
    installType: string | undefined | null,
    covered = false,
    desktop = false
): InstallKind {
    if (installType === "normal") return "store";
    // Ahead of the updater's marker: once the desktop app looks after this copy,
    // it is the one that says when a new version is going in.
    if (desktop) return "desktop";
    // Only an unpacked load can be kept current by replacing its files, and only
    // one whose folder the updater marked as its own.
    if (installType === "development" && covered) return "auto";
    return "manual";
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
    installType: string | undefined | null,
    covered = false,
    desktop = false
): UpdateNotice | null {
    const version = publishedVersion(answer);
    const url = answer?.url;
    if (version === null || typeof url !== "string" || url === "") return null;
    if (!isNewer(version, running)) return null;
    return { version, url, kind: installKind(installType, covered, desktop) };
}

/**
 * The version the server says is out, or null when it named none - which is
 * what lets the popup say "up to date" only after somebody actually answered.
 */
export function publishedVersion(answer: VersionAnswer | null): string | null {
    const version = answer?.version;
    return typeof version === "string" && version !== "" ? version : null;
}

/**
 * Whether the Polaris desktop app keeps this copy current.
 *
 * Always false: there is no desktop app yet. It is the one place to change when
 * there is, and a `desktop` notice is never shown - the app that installs the
 * new version is the one that says so.
 */
export function managedByDesktop(): boolean {
    return false;
}

/** The toolbar badge's two colours: the count of logins, and an update. */
export const COUNT_COLOR = "#2f6feb";
export const UPDATE_COLOR = "#d97706";

/** What the toolbar icon shows. */
export interface BadgeState {
    readonly text: string;
    readonly color: string;
    /** The version to name in the icon's tooltip, or null to leave it as it is. */
    readonly announce: string | null;
}

/**
 * The badge, from the login count for the tab in front and the update notice.
 *
 * One badge, two things to say, and the count wins: it is about the page
 * somebody is on right now and is what the badge means every day, while an
 * update can wait for the next tab with nothing saved. The update still reaches
 * the icon either way, through its tooltip, and the popup says it in full.
 *
 * The mark itself is only for a copy somebody has to update by hand. A store
 * install, a folder the updater keeps current and the desktop app all deliver
 * the new version without anybody doing anything, and an icon asking for
 * attention it cannot use is one people learn to ignore.
 */
export function badgeFor(count: string, notice: UpdateNotice | null): BadgeState {
    const announce = notice && notice.kind !== "desktop" ? notice.version : null;
    if (count !== "") return { text: count, color: COUNT_COLOR, announce };
    if (notice?.kind === "manual") return { text: "!", color: UPDATE_COLOR, announce };
    return { text: "", color: COUNT_COLOR, announce };
}

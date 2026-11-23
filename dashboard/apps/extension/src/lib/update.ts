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
 * Whether the browser itself fetches new versions of this copy.
 *
 * `normal` is an install from a store. Past that, the address the browser
 * reports it updates from is what decides, not how the copy arrived: the
 * desktop app adds the extension by pointing the browser at the store's update
 * address, and the browser reports that as `sideload` while updating it from the
 * store like any other. An unpacked load is never updated by the browser,
 * whatever its manifest names.
 */
export function updatedByBrowser(installType: string | undefined | null, updateUrl?: string | null): boolean {
    if (installType === "normal") return true;
    if (installType === "development" || typeof updateUrl !== "string") return false;
    try {
        return new URL(updateUrl).protocol === "https:";
    } catch {
        return false;
    }
}

/**
 * What `management.getSelf()` reported, reduced to the only distinction that
 * changes the advice.
 *
 * Only a build the browser updates (`updatedByBrowser`) is one something else
 * keeps up to date. `development` is the unpacked or temporary load this warning
 * mostly exists for; `sideload` and `admin` with no update address were put
 * there by other software or by policy, and Polaris cannot promise either of
 * those will ever be updated. So everything that is not plainly updated by the
 * browser is told how to do it by hand, which is the direction that leaves
 * nobody stranded on an old build.
 */
export function installKind(
    installType: string | undefined | null,
    covered = false,
    desktop = false,
    updateUrl: string | null = null
): InstallKind {
    if (updatedByBrowser(installType, updateUrl)) return "store";
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
    desktop = false,
    updateUrl: string | null = null
): UpdateNotice | null {
    const version = publishedVersion(answer);
    const url = answer?.url;
    if (version === null || typeof url !== "string" || url === "") return null;
    if (!isNewer(version, running)) return null;
    return { version, url, kind: installKind(installType, covered, desktop, updateUrl) };
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
 * The mark is there until the popup's notice for that version has been seen and
 * dismissed (`shouldAnnounce`) - for every install, since somebody with the
 * popup closed has no other way to hear of it. A copy somebody has to update by
 * hand keeps it after that, until the new version runs: there is still
 * something for them to do. The desktop app says it itself.
 */
export function badgeFor(
    count: string,
    notice: UpdateNotice | null,
    dismissed: string | null = null
): BadgeState {
    const announce = notice && notice.kind !== "desktop" ? notice.version : null;
    if (count !== "") return { text: count, color: COUNT_COLOR, announce };
    if (notice?.kind === "manual" || shouldAnnounce(notice, dismissed))
        return { text: "!", color: UPDATE_COLOR, announce };
    return { text: "", color: COUNT_COLOR, announce };
}

/**
 * Whether the popup's one-time notice for this version is still to be shown.
 *
 * Once per version: dismissing it for 0.2.0 keeps it away until 0.2.1 is out,
 * and never says the same thing on every open. The desktop app says it itself.
 */
export function shouldAnnounce(notice: UpdateNotice | null, dismissed: string | null): boolean {
    return notice !== null && notice.kind !== "desktop" && notice.version !== dismissed;
}

/** How often the worker asks on its own: every few hours, and at browser start. */
export const UPDATE_CHECK_EVERY_MINUTES = 6 * 60;

/**
 * The least time between two checks nobody asked for.
 *
 * A manifest v3 worker is started many times an hour, and the check that runs
 * when it starts would otherwise be a request every time. A press of "Check for
 * updates" and the browser's own start are not held back by it.
 */
export const UPDATE_MIN_GAP_MS = 60 * 60 * 1000;

/** Whether an unasked check is due, given when the last one ran (ms, or null). */
export function checkDue(lastCheckedAt: number | null, now: number): boolean {
    if (lastCheckedAt === null || !Number.isFinite(lastCheckedAt)) return true;
    // A clock moved backwards is not a reason to stay quiet for a day.
    if (lastCheckedAt > now) return true;
    return now - lastCheckedAt >= UPDATE_MIN_GAP_MS;
}

/**
 * How long a folder the updater marked as its own may go without the new
 * version arriving before the popup stops promising it will.
 *
 * The updater runs every six hours; two missed runs is an updater that is not
 * running - removed, blocked, or a folder copied away from where it looks - and
 * from then on this copy is told how to update by hand, like any other.
 */
export const AUTO_GRACE_MS = 12 * 60 * 60 * 1000;

/** When this running version first heard that a newer one is out. */
export interface BehindSince {
    readonly running: string;
    readonly at: number;
}

/**
 * The record of when this copy fell behind: kept while the same version runs,
 * started again once another does, cleared when nothing newer is out.
 */
export function behindSince(
    held: BehindSince | null,
    running: string,
    behind: boolean,
    now: number
): BehindSince | null {
    if (!behind) return null;
    if (held && held.running === running && Number.isFinite(held.at) && held.at <= now) return held;
    return { running, at: now };
}

/**
 * The install kind as it stands after the updater has had its chance: `auto`
 * that has waited past `AUTO_GRACE_MS` is `manual`, because the promise on
 * screen ("installs itself within hours") has stopped being true.
 */
export function effectiveKind(kind: InstallKind, since: BehindSince | null, now: number): InstallKind {
    if (kind !== "auto" || since === null) return kind;
    return now - since.at > AUTO_GRACE_MS ? "manual" : kind;
}

/** The build a browser needs: WXT names the packages after it. */
export type PackageBrowser = "chrome" | "firefox";

/**
 * The package to download for an update by hand.
 *
 * The server answers with the release page (`/releases/tag/<tag>` on GitHub),
 * and the packages sit beside it under fixed names (`wxt.config.ts`, `zip`), so
 * the file is derived rather than asked for - a server from before this knows
 * nothing more to send. Anything that is not a GitHub release page is returned
 * as it is: the page, where the files are listed.
 */
export function downloadUrl(releaseUrl: string, browser: PackageBrowser): string {
    let parsed: URL;
    try {
        parsed = new URL(releaseUrl);
    } catch {
        return releaseUrl;
    }
    const match = /^\/([^/]+)\/([^/]+)\/releases\/tag\/([^/]+)\/?$/.exec(parsed.pathname);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !match) return releaseUrl;
    const [, owner, repo, tag] = match;
    return `https://github.com/${owner}/${repo}/releases/download/${tag}/polaris-extension-${browser}.zip`;
}

/**
 * Whether the version line says "Up to date": a version Polaris named, no newer
 * one waiting, and the one named not ahead of this copy. The update check beside
 * it then keeps quiet about finding nothing, so the words are never shown twice.
 */
export function upToDate(latest: string | null, running: string, newer: string | null): boolean {
    return !newer && !!latest && !isNewer(latest, running);
}

/** The alarm the periodic check runs on. */
export const UPDATE_CHECK_ALARM = "update-check";

/**
 * Whether the periodic check's alarm has to be created: when it is missing, or
 * on a period other than this build's. Creating one that exists starts its
 * period again, so a worker that started every few minutes and created it each
 * time would never let a period of hours come round.
 */
export function alarmNeedsCreating(held: { periodInMinutes?: number } | undefined | null): boolean {
    return held?.periodInMinutes !== UPDATE_CHECK_EVERY_MINUTES;
}

/**
 * The browser's extensions page, focused on this extension, for the Reload
 * after an update by hand - or null where an extension may not open it. Every
 * Chromium browser (Chrome, Edge, Brave, Opera) answers `chrome://extensions`;
 * Firefox refuses to open `about:debugging` from an extension.
 */
export function extensionsPage(browser: string, id: string): string | null {
    if (browser === "firefox") return null;
    return `chrome://extensions/?id=${encodeURIComponent(id)}`;
}

/** The package for the browser this build is for. */
export function packageBrowser(browser: string): PackageBrowser {
    return browser === "firefox" ? "firefox" : "chrome";
}

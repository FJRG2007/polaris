/**
 * Keeping this app up to date.
 *
 * Asked of GitHub as the app starts, every half hour after, and again when the
 * computer wakes, is unlocked or the app is brought forward after a while away,
 * without credentials. When the answer comes straight away, the app updates before it
 * opens (`index.ts`), so opening it is all an update asks of anybody. What happens with a newer release depends on what the
 * system lets an app do to itself:
 *
 * - **Windows**, installed by the Squirrel installer: the update is downloaded
 *   in the background from the release itself (its `RELEASES` file and
 *   package) and installed then; the next start opens the new version.
 * - **macOS**, when the app is signed with a Developer ID: the same through
 *   Squirrel.Mac, from the feed the release carries for this architecture
 *   (`build/mac-feed.cjs`), which names the release's zip.
 * - **Linux**, run from an AppImage: the release's AppImage is downloaded
 *   beside it, checked against the release's checksums and put in its place
 *   (`appimage.ts`).
 *
 * In each, one notice, the Help menu and a button in the page's header
 * (`update-ready.ts`) offer to restart into it now.
 * Everywhere else - a .deb, an unsigned Mac app, a Windows copy not installed
 * by Squirrel - a notice once per version, and the Help menu, open the
 * release's page, where the installers are.
 *
 * A failed check says nothing and is tried again at the next interval; a
 * failed download or install, or a release with nothing newer in it, falls
 * back to the page.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { downloadSetup, retryDelay } from "./setup-install";
import { markRelaunch } from "./relaunch";
import { replaceAppImage } from "./appimage";
import { repository } from "../../package.json";
import { app, autoUpdater, net, powerMonitor } from "electron";
import { developerSigned } from "./mac-signature";
import type { UpdateCheck } from "@/shared/update-check";
import { describeNetError, netErrorCode } from "./reachability";
import { dirname, isAbsolute, resolve } from "node:path";
import { appImageAsset, CHECKSUMS, macFeedName, newerRelease, parseChecksums, releaseSource, type Release } from "./releases";

/** Often enough that a release reaches an app left open all day the same
 *  afternoon, and well inside GitHub's sixty unauthenticated asks an hour. */
export const EVERY_MS = 30 * 60_000;
/** A computer asleep runs no timers, so waking it, unlocking it or coming back
 *  to the app asks again - once this long has passed since the last ask. */
export const AWAY_MS = 10 * 60_000;
/** Squirrel.Windows holds a lock on the first launch after an install, and asks
 *  made during it fail. */
const AFTER_FIRST_RUN_MS = 30_000;
/** A checksums file is a line per installer; anything this large is not one. */
const CHECKSUMS_MAX_BYTES = 64 * 1024;

/** Why neither Squirrel nor the release's installer could update this copy. */
export interface UpdateFailure {
    readonly reason: string;
}

export interface Update {
    readonly version: string;
    /** The release's page on GitHub. */
    readonly page: string;
    /** Set once the update is installed and waits for a restart. */
    readonly restart?: () => void;
}

/** How this copy can be replaced: by Squirrel (Windows or macOS), by writing
 *  the AppImage it runs from, or not at all. */
type Installer = { readonly kind: "squirrel"; } | { readonly kind: "appimage"; readonly path: string; } | { readonly kind: "page"; };

async function installer(): Promise<Installer> {
    if (!app.isPackaged) return { kind: "page" };
    if (process.platform === "win32") {
        // Installed by Squirrel when its Update.exe sits above the app's folder.
        return existsSync(resolve(dirname(process.execPath), "..", "Update.exe")) ? { kind: "squirrel" } : { kind: "page" };
    }
    if (process.platform === "darwin") {
        // Polaris.app/Contents/MacOS/Polaris
        return (await developerSigned(resolve(process.execPath, "..", "..", ".."))) ? { kind: "squirrel" } : { kind: "page" };
    }
    const appImage = process.env.APPIMAGE;
    if (process.platform === "linux" && appImage && isAbsolute(appImage) && existsSync(appImage)) return { kind: "appimage", path: appImage };
    return { kind: "page" };
}

async function fetchText(url: string, limit: number): Promise<string> {
    const response = await net.fetch(url, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const text = await response.text();
    if (text.length > limit) throw new Error(`${url} is larger than expected`);
    return text;
}

/** What the first check of a start came to. */
export interface FirstCheck {
    /** Settled once this copy knows how it updates and the question goes out. */
    readonly asked: Promise<void>;
    /** The newer version it began installing, null when it will not. */
    readonly installing: Promise<string | null>;
    /** Whether that install finished, so the app can restart into it. */
    readonly installed: Promise<boolean>;
    /** Ask now, from a press, and say what was found. Never throws. */
    readonly checkNow: () => Promise<UpdateCheck>;
    /** After a check said "downloading": settles once that download is
     *  installed or has failed, with what it came to. Never throws. */
    readonly downloaded: () => Promise<UpdateCheck>;
}

/**
 * When Squirrel cannot check for, download or apply an update on Windows, the
 * release's installer is downloaded, checked against its checksums and made
 * the update's restart: it runs silently over this install at the same moment
 * an installed update would restart, so nobody is asked to download anything.
 * `failed` hears only when that did not work either - an antivirus holding the
 * files is the usual cause - with the reason, in place of `found`'s
 * announcement. Squirrel is tried again later (`retryDelay`), so no copy is
 * left on a version by one bad try
 * (docs/bugs/BUG-0042-desktop-windows-update-not-applied.md).
 */
export function watchForUpdates(found: (update: Update) => void, failed?: (update: Update, failure: UpdateFailure) => void): FirstCheck {
    let ready: () => void = () => undefined;
    let began: (version: string | null) => void = () => undefined;
    let ended: (installed: boolean) => void = () => undefined;
    let checkNow: () => Promise<UpdateCheck> = async () => ({ kind: "unsupported" });
    let downloaded: () => Promise<UpdateCheck> = async () => ({ kind: "unsupported" });
    const first: FirstCheck = {
        asked: new Promise((resolve) => (ready = resolve)),
        installing: new Promise((resolve) => (began = resolve)),
        installed: new Promise((resolve) => (ended = resolve)),
        checkNow: () => checkNow(),
        downloaded: () => downloaded()
    };
    const source = releaseSource(repository);
    if (!source) {
        ready();
        began(null);
        ended(false);
        return first;
    }
    let announced: string | null = null;
    /** The version being downloaded or already installed, so it is fetched once. */
    let installing: string | null = null;
    let how: Promise<Installer> | null = null;
    /** The version installed and waiting for a restart. */
    let waiting: string | null = null;
    /** The release Squirrel was handed, for the installer to fall back on. */
    let handed: Release | null = null;
    /** Squirrel's failures in a row, and when it is tried again after them. */
    let failures = 0;
    let retryAt = 0;
    /** What the download in flight comes to, for a press waiting on it. */
    let outcome: { readonly done: Promise<UpdateCheck>; readonly settle: (check: UpdateCheck) => void; } | null = null;
    const settleDownload = (check: UpdateCheck) => {
        outcome?.settle(check);
        outcome = null;
    };

    // The page is the way left: say it once for the version that failed.
    // `broke` is Squirrel's own error, as opposed to finding nothing to install.
    const fallBack = (broke = false, reason = "") => {
        const version = installing;
        const release = handed;
        installing = null;
        handed = null;
        ended(false);
        if (version) settleDownload({ kind: "available", version });
        if (!version || version === announced) return;
        announced = version;
        const update = { version, page: source.page(`desktop-v${version}`) };
        if (broke && release && process.platform === "win32") {
            failures += 1;
            retryAt = Date.now() + retryDelay(failures);
            console.error(`Polaris ${version} did not install through Squirrel (try ${failures}): ${reason || "no reason given"}`);
            void viaSetup(release).then(
                (setup) => installed(version, setup),
                (caught: unknown) => {
                    const why = `${reason || "Squirrel stopped without saying why."} The installer did not either: ${caught instanceof Error ? caught.message : String(caught)}`;
                    console.error(`Polaris ${version}: ${why}`);
                    if (failed) failed(update, { reason: why });
                    else found(update);
                }
            );
            return;
        }
        found(update);
    };

    /**
     * The release's installer, downloaded and checked; resolves with what runs
     * it. `--silent` is Squirrel.Windows' Setup.exe flag for an install with no
     * window; it then starts the new version itself.
     */
    const viaSetup = async (release: Release): Promise<() => void> => {
        const path = await downloadSetup({
            folder: source.download(release.tag),
            assets: release.assets,
            temp: app.getPath("temp"),
            fetchText: (url) => fetchText(url, CHECKSUMS_MAX_BYTES),
            fetch: (url, init) => net.fetch(url, { ...init, credentials: "omit", cache: "no-store" })
        });
        return () => {
            try {
                spawn(path, ["--silent"], { detached: true, stdio: "ignore" }).unref();
            } catch (caught) {
                console.error(`Polaris ${release.version}: the installer did not start: ${String(caught)}`);
                return;
            }
            app.quit();
        };
    };
    const installed = (version: string, install: () => void) => {
        announced = version;
        waiting = version;
        // Whatever presses it - the page, the menu, the notice, the update at
        // start - the next run is told it began as this restart, so a call that
        // was on is walked back into rather than lost (`@/shared/relaunch`).
        const restart = () => {
            markRelaunch("update");
            install();
        };
        found({ version, page: source.page(`desktop-v${version}`), restart });
        ended(true);
        settleDownload({ kind: "ready", version });
    };

    const listenToSquirrel = () => {
        autoUpdater.on("error", (error) => fallBack(true, error instanceof Error ? error.message : String(error ?? "")));
        // Asked only once the release list named a newer version, so on Windows
        // "nothing to install" is Squirrel failing to see it, not the truth.
        autoUpdater.on("update-not-available", () =>
            fallBack(process.platform === "win32", "Squirrel found nothing to install although a newer release is published.")
        );
        autoUpdater.on("update-downloaded", () => {
            const version = installing;
            if (!version) return;
            failures = 0;
            handed = null;
            installed(version, () => autoUpdater.quitAndInstall());
        });
    };

    const viaSquirrel = (release: Release) => {
        const folder = source.download(release.tag);
        if (process.platform === "darwin") autoUpdater.setFeedURL({ url: `${folder}/${macFeedName(process.arch)}`, serverType: "json" });
        else autoUpdater.setFeedURL({ url: folder });
        autoUpdater.checkForUpdates();
    };

    const viaAppImage = async (release: Release, path: string) => {
        const asset = appImageAsset(release.assets, process.arch);
        if (!asset) throw new Error("The release has no AppImage for this architecture");
        const folder = source.download(release.tag);
        const sha256 = parseChecksums(await fetchText(`${folder}/${CHECKSUMS}`, CHECKSUMS_MAX_BYTES)).get(asset.name);
        if (!sha256) throw new Error(`${CHECKSUMS} does not list ${asset.name}`);
        await replaceAppImage(path, `${folder}/${encodeURIComponent(asset.name)}`, { size: asset.size, sha256 }, (url, init) =>
            net.fetch(url, { ...init, credentials: "omit", cache: "no-store" })
        );
        installed(release.version, () => {
            app.relaunch({ execPath: path, args: process.argv.slice(1) });
            app.quit();
        });
    };

    let lastAsked = 0;
    const check = async (): Promise<UpdateCheck> => {
        lastAsked = Date.now();
        try {
            if (!how) {
                how = installer().catch((): Installer => ({ kind: "page" }));
                if ((await how).kind === "squirrel") listenToSquirrel();
            }
            const mode = await how;
            ready();
            const response = await net.fetch(source.api, {
                headers: { accept: "application/vnd.github+json" },
                credentials: "omit",
                cache: "no-store",
                signal: AbortSignal.timeout(15_000)
            });
            if (!response.ok) return { kind: "failed", reason: `The list of releases answered with HTTP ${response.status}. Try again later.` };
            const release = newerRelease(await response.json(), app.getVersion());
            if (!release) return waiting ? { kind: "ready", version: waiting } : { kind: "current", version: app.getVersion() };
            if (release.version === waiting) return { kind: "ready", version: waiting };
            if (release.version === installing) return { kind: "downloading", version: installing };
            // Announced and neither installing nor installed: its page is the way,
            // unless Squirrel failed on it and its wait to be tried again is over.
            if (release.version === announced) {
                if (!(mode.kind === "squirrel" && failures > 0 && Date.now() >= retryAt)) return { kind: "available", version: release.version };
                announced = null;
            }
            if (mode.kind === "page") {
                announced = release.version;
                found({ version: release.version, page: source.page(release.tag) });
                return { kind: "available", version: release.version };
            }
            installing = release.version;
            let settle: (check: UpdateCheck) => void = () => undefined;
            outcome = { done: new Promise((resolve) => (settle = resolve)), settle: (check) => settle(check) };
            began(release.version);
            if (mode.kind === "appimage") {
                void viaAppImage(release, mode.path).catch(() => fallBack());
                return { kind: "downloading", version: release.version };
            }
            handed = release;
            try {
                viaSquirrel(release);
            } catch (caught) {
                fallBack(true, caught instanceof Error ? caught.message : String(caught));
                return { kind: "available", version: release.version };
            }
            return { kind: "downloading", version: release.version };
        } catch (caught) {
            const code = netErrorCode(String(caught));
            return { kind: "failed", reason: code ? describeNetError(code, "github.com") : "The list of releases did not answer. Try again later." };
        }
    };
    /** One question at a time: a second press waits for the answer in flight. */
    let asking: Promise<UpdateCheck> | null = null;
    checkNow = () => (asking ??= check().finally(() => (asking = null)));
    // Nothing in flight any more: it ended before the page asked, and a check
    // says what it ended as - installed and waiting, or its page.
    downloaded = () => outcome?.done ?? checkNow();

    // Nothing began: settled here, and later rounds are nobody's start.
    const settle = () => {
        ready();
        began(null);
    };
    if (process.platform === "win32" && process.argv.includes("--squirrel-firstrun")) {
        settle();
        setTimeout(() => void check(), AFTER_FIRST_RUN_MS);
    } else {
        void check().finally(settle);
    }
    setInterval(() => void check(), EVERY_MS);
    const back = () => {
        if (dueAgain(lastAsked, Date.now())) void checkNow();
    };
    powerMonitor.on("resume", back);
    powerMonitor.on("unlock-screen", back);
    app.on("browser-window-focus", back);
    return first;
}

/** Whether coming back to the app is reason enough to ask again. */
export function dueAgain(lastAsked: number, now: number): boolean {
    return now - lastAsked >= AWAY_MS;
}

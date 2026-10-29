/**
 * Keeping this app up to date.
 *
 * Asked of GitHub shortly after the app starts and every few hours after,
 * without credentials. What happens with a newer release depends on what the
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
 * In each, one notice and the Help menu offer to restart into it now.
 * Everywhere else - a .deb, an unsigned Mac app, a Windows copy not installed
 * by Squirrel - a notice once per version, and the Help menu, open the
 * release's page, where the installers are.
 *
 * A failed check says nothing and is tried again at the next interval; a
 * failed download or install, or a release with nothing newer in it, falls
 * back to the page.
 */

import { existsSync } from "node:fs";
import { replaceAppImage } from "./appimage";
import { repository } from "../../package.json";
import { app, autoUpdater, net } from "electron";
import { developerSigned } from "./mac-signature";
import { dirname, isAbsolute, resolve } from "node:path";
import { appImageAsset, CHECKSUMS, macFeedName, newerRelease, parseChecksums, releaseSource, type Release } from "./releases";

const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 6 * 60 * 60_000;
/** A checksums file is a line per installer; anything this large is not one. */
const CHECKSUMS_MAX_BYTES = 64 * 1024;

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

export function watchForUpdates(found: (update: Update) => void): void {
    const source = releaseSource(repository);
    if (!source) return;
    let announced: string | null = null;
    /** The version being downloaded or already installed, so it is fetched once. */
    let installing: string | null = null;
    let how: Promise<Installer> | null = null;

    // The page is the way left: say it once for the version that failed.
    const fallBack = () => {
        const failed = installing;
        installing = null;
        if (failed && failed !== announced) {
            announced = failed;
            found({ version: failed, page: source.page(`desktop-v${failed}`) });
        }
    };
    const installed = (version: string, restart: () => void) => {
        announced = version;
        found({ version, page: source.page(`desktop-v${version}`), restart });
    };

    const listenToSquirrel = () => {
        autoUpdater.on("error", fallBack);
        autoUpdater.on("update-not-available", fallBack);
        autoUpdater.on("update-downloaded", () => {
            const version = installing;
            if (version) installed(version, () => autoUpdater.quitAndInstall());
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

    const check = async () => {
        try {
            if (!how) {
                how = installer().catch((): Installer => ({ kind: "page" }));
                if ((await how).kind === "squirrel") listenToSquirrel();
            }
            const mode = await how;
            const response = await net.fetch(source.api, {
                headers: { accept: "application/vnd.github+json" },
                credentials: "omit",
                cache: "no-store",
                signal: AbortSignal.timeout(15_000)
            });
            if (!response.ok) return;
            const release = newerRelease(await response.json(), app.getVersion());
            if (!release || release.version === announced || release.version === installing) return;
            if (mode.kind === "page") {
                announced = release.version;
                found({ version: release.version, page: source.page(release.tag) });
                return;
            }
            installing = release.version;
            if (mode.kind === "appimage") {
                void viaAppImage(release, mode.path).catch(fallBack);
                return;
            }
            try {
                viaSquirrel(release);
            } catch {
                fallBack();
            }
        } catch {
            return;
        }
    };

    setTimeout(() => void check(), FIRST_CHECK_MS);
    setInterval(() => void check(), EVERY_MS);
}

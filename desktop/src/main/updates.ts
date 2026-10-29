/**
 * Keeping this app up to date.
 *
 * Asked of GitHub shortly after the app starts and every few hours after,
 * without credentials. What happens with a newer release depends on what the
 * system lets an app do to itself:
 *
 * - **Windows**, installed by the Squirrel installer: the update is downloaded
 *   in the background from the release itself (its `RELEASES` file and
 *   package) and installed then; the next start opens the new version. One
 *   notice and the Help menu offer to restart into it now.
 * - **macOS and Linux**, and a Windows copy not installed that way: a notice
 *   once per version, and the Help menu, open the release's page, where the
 *   installers are. macOS replaces an app only when it is signed, and a .deb
 *   or an AppImage is the package manager's or the user's to replace.
 *
 * A failed check says nothing and is tried again at the next interval; a
 * failed download, or a release Squirrel finds nothing newer in, falls back to
 * the page.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { repository } from "../../package.json";
import { app, autoUpdater, net } from "electron";
import { newerRelease, releaseSource } from "./releases";

const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 6 * 60 * 60_000;

export interface Update {
    readonly version: string;
    /** The release's page on GitHub. */
    readonly page: string;
    /** Set once the update is installed and waits for a restart. */
    readonly restart?: () => void;
}

/** Whether this copy was installed by Squirrel, which is what can replace it. */
function squirrelInstalled(): boolean {
    if (process.platform !== "win32" || !app.isPackaged) return false;
    return existsSync(resolve(dirname(process.execPath), "..", "Update.exe"));
}

export function watchForUpdates(found: (update: Update) => void): void {
    const source = releaseSource(repository);
    if (!source) return;
    let announced: string | null = null;
    /** The version being downloaded or already installed, so it is fetched once. */
    let installing: string | null = null;
    const quiet = squirrelInstalled();

    if (quiet) {
        // The page is the way left: say it once for the version that failed.
        const fallBack = () => {
            const failed = installing;
            installing = null;
            if (failed && failed !== announced) {
                announced = failed;
                found({ version: failed, page: source.page(`desktop-v${failed}`) });
            }
        };
        autoUpdater.on("error", fallBack);
        autoUpdater.on("update-not-available", fallBack);
        autoUpdater.on("update-downloaded", () => {
            const version = installing;
            if (!version) return;
            announced = version;
            found({ version, page: source.page(`desktop-v${version}`), restart: () => autoUpdater.quitAndInstall() });
        });
    }

    const check = async () => {
        try {
            const response = await net.fetch(source.api, {
                headers: { accept: "application/vnd.github+json" },
                credentials: "omit",
                cache: "no-store",
                signal: AbortSignal.timeout(15_000)
            });
            if (!response.ok) return;
            const release = newerRelease(await response.json(), app.getVersion());
            if (!release || release.version === announced || release.version === installing) return;
            if (quiet) {
                installing = release.version;
                autoUpdater.setFeedURL({ url: source.download(release.tag) });
                autoUpdater.checkForUpdates();
                return;
            }
            announced = release.version;
            found({ version: release.version, page: source.page(release.tag) });
        } catch {
            return;
        }
    };

    setTimeout(() => void check(), FIRST_CHECK_MS);
    setInterval(() => void check(), EVERY_MS);
}

/**
 * Telling somebody a newer version of this app is out.
 *
 * Asked of GitHub shortly after the app starts and every few hours after,
 * without credentials. A newer release is announced once per version with a
 * notice, and offered in the Help menu until the app is updated; both open the
 * release's page in the browser, where the installers are. A failed check says
 * nothing and is tried again at the next interval.
 */

import { app, net } from "electron";
import { repository } from "../../package.json";
import { newerRelease, releaseSource } from "./releases";

const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 6 * 60 * 60_000;

export interface Update {
    readonly version: string;
    /** The release's page on GitHub. */
    readonly page: string;
}

export function watchForUpdates(found: (update: Update) => void): void {
    const source = releaseSource(repository);
    if (!source) return;
    let announced: string | null = null;

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
            if (!release || release.version === announced) return;
            announced = release.version;
            found({ version: release.version, page: source.page(release.tag) });
        } catch {
            return;
        }
    };

    setTimeout(() => void check(), FIRST_CHECK_MS);
    setInterval(() => void check(), EVERY_MS);
}

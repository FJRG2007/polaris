/**
 * The way left on Windows when Squirrel's own update fails: the release's
 * installer, run over this install.
 *
 * `Polaris-Setup.exe` is a whole Squirrel install. Run over an existing one it
 * replaces the app's folder under %LOCALAPPDATA% and opens the new version;
 * settings, saved servers and keys live in the user data folder under
 * %APPDATA%, which it does not touch. It is downloaded into a folder of its
 * own and checked against the size the release lists and the SHA-256 its
 * `SHA256SUMS` publishes before anything runs it (`appimage.ts` does the
 * download and the check).
 *
 * Free of Electron so the tests can run it against files of their own.
 */

import { join } from "node:path";
import { replaceAppImage } from "./appimage";
import { mkdtemp, rm } from "node:fs/promises";
import { CHECKSUMS, parseChecksums, type Asset } from "./releases";

/** The installer the release job attaches, named by `forge.config.js`. */
export const SETUP_EXE = "Polaris-Setup.exe";

/** The release's installer, or null when it has none worth downloading. */
export function setupAsset(assets: readonly Asset[]): Asset | null {
    return assets.find((asset) => asset.name === SETUP_EXE && asset.size > 0) ?? null;
}

/**
 * How long to wait before Squirrel is tried again after it failed `failures`
 * times in a row: half an hour, doubling, never more than a day. A machine that
 * fails once (a lock, a network cut) is not left waiting for its next start.
 */
export function retryDelay(failures: number): number {
    const steps = Math.max(0, Math.min(failures - 1, 6));
    return Math.min(30 * 60_000 * 2 ** steps, 24 * 60 * 60_000);
}

export interface SetupDownload {
    /** The release's download folder (`releaseSource().download`). */
    readonly folder: string;
    readonly assets: readonly Asset[];
    /** Where the folder holding the installer is made. */
    readonly temp: string;
    readonly fetchText: (url: string) => Promise<string>;
    readonly fetch: (url: string, init: { signal: AbortSignal; }) => Promise<Response>;
}

/** Downloads and checks the release's installer; resolves with its path.
 *  Throws, leaving nothing behind, when it is missing or does not match. */
export async function downloadSetup(download: SetupDownload): Promise<string> {
    const asset = setupAsset(download.assets);
    if (!asset) throw new Error(`The release has no ${SETUP_EXE}`);
    const sha256 = parseChecksums(await download.fetchText(`${download.folder}/${CHECKSUMS}`)).get(asset.name);
    if (!sha256) throw new Error(`${CHECKSUMS} does not list ${asset.name}`);
    const folder = await mkdtemp(join(download.temp, "polaris-setup-"));
    const target = join(folder, SETUP_EXE);
    try {
        await replaceAppImage(target, `${download.folder}/${encodeURIComponent(asset.name)}`, { size: asset.size, sha256 }, download.fetch);
    } catch (error) {
        await rm(folder, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
    return target;
}

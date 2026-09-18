/**
 * When an app's bundle arrives and leaves: at boot for every app this server
 * has installed, when one is installed, and when one is uninstalled.
 *
 * Boot is where an update lands. An install whose apps were built into the old
 * image finds no bundle for the new one on its volume, fetches it, and removes
 * the old build's - so after an update every installed app is on the same build
 * as the dashboard, with nobody having pressed anything but Update. What counts
 * as installed is `isAppInstalled`, which also counts an install that predates
 * the app being installable (a game server, a per-game manager).
 *
 * Server-only.
 */

import { removeBundle } from "./store";
import { bundlesPreferred, knownApps } from "./code";
import { loadBundle, loadedBundle, unloadBundle } from "./loader";
import { isAppInstalled } from "@/lib/apps/install-presence";

/** How long boot waits for the bundles before it serves without them. */
const BOOT_WAIT_MS = 60_000;

/** How often a bundle that could not be had is tried again. */
const RETRY_MS = 5 * 60_000;

const retrying = new Set<string>();

function retryLater(id: string): void {
    if (retrying.has(id)) return;
    retrying.add(id);
    const attempt = async () => {
        if (!(await isAppInstalled(id).catch(() => true))) return retrying.delete(id);
        try {
            const bundle = await loadBundle(id);
            retrying.delete(id);
            // Boot started every other app; this one missed it.
            bundle.server.extension.onBoot?.();
        } catch (error) {
            console.error(`polaris: ${id} is still unavailable:`, error);
            setTimeout(() => void attempt(), RETRY_MS).unref();
        }
    };
    setTimeout(() => void attempt(), RETRY_MS).unref();
}

/** Load every installed app's bundle, fetching what this build does not have yet. */
export async function prepareAppBundles(): Promise<void> {
    if (!bundlesPreferred()) return;
    const loads = knownApps().map(async (id) => {
        if (!(await isAppInstalled(id))) return;
        try {
            await loadBundle(id);
        } catch (error) {
            console.error(`polaris: ${id} could not be loaded; serving it from this image:`, error);
            retryLater(id);
        }
    });
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BOOT_WAIT_MS);
    });
    await Promise.race([Promise.all(loads), waited]);
    clearTimeout(timer);
}

/** An app was installed: bring its code. */
export async function appInstalled(id: string): Promise<void> {
    if (!knownApps().includes(id) || !bundlesPreferred() || loadedBundle(id)) return;
    try {
        const bundle = await loadBundle(id);
        bundle.server.extension.onBoot?.();
    } catch (error) {
        console.error(`polaris: ${id} could not be loaded; serving it from this image:`, error);
        retryLater(id);
    }
}

/** An app was uninstalled: take its code away. Its data stays. */
export async function appUninstalled(id: string): Promise<void> {
    if (!knownApps().includes(id)) return;
    unloadBundle(id);
    await removeBundle(id).catch((error: unknown) =>
        console.error(`polaris: ${id}'s code could not be removed:`, error)
    );
}

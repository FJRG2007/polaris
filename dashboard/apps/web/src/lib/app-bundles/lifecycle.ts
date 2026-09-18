/**
 * When an app's code arrives and leaves: at boot for every app this server has
 * installed, when one is installed, and when one is uninstalled.
 *
 * Boot is where an update lands. The new dashboard finds no bundle for its own
 * build on the volume, fetches it from the registry it was just pulled from,
 * and removes the previous build's - so after an update every installed app is
 * on the same build as the dashboard, with nobody having pressed anything but
 * Update, and the same in the limited edition, which has no updater to ask.
 * What counts as installed is `isAppInstalled`, which also counts an install
 * that predates the app being installable (a game server, a per-game manager):
 * those get their bundle on the first update without anybody installing anything.
 *
 * Server-only.
 */

import { knownApps } from "./code";
import { findApp } from "@/lib/apps/catalog";
import { BundleUnavailable, removeBundle } from "./store";
import { loadBundle, loadedBundle, unloadBundle } from "./loader";
import { isAppInstalled } from "@/lib/apps/install-presence";

/** How long boot waits for the bundles before it serves without them. */
const BOOT_WAIT_MS = 60_000;

/** How often a bundle that could not be had is tried again. */
const RETRY_MS = 5 * 60_000;

type State = { failures: Map<string, string>; retrying: Set<string> };

const state: State = ((globalThis as Record<symbol, unknown>)[Symbol.for("polaris.app-bundles.lifecycle")] ??= {
    failures: new Map(),
    retrying: new Set()
}) as State;

/** Why an installed app's code is not here, in words for its screen. */
export function appUnavailableReason(id: string): string | null {
    return loadedBundle(id) ? null : (state.failures.get(id) ?? null);
}

function reasonOf(error: unknown): string {
    return error instanceof BundleUnavailable ? error.message : "Its code could not be started.";
}

/** Load an app's bundle, and start what it runs from boot. */
async function bring(id: string): Promise<void> {
    const already = loadedBundle(id);
    const bundle = await loadBundle(id);
    state.failures.delete(id);
    if (!already) bundle.server.extension.onBoot?.();
}

function retryLater(id: string): void {
    if (state.retrying.has(id)) return;
    state.retrying.add(id);
    const attempt = async () => {
        if (!(await isAppInstalled(id).catch(() => true))) return state.retrying.delete(id);
        try {
            await bring(id);
            state.retrying.delete(id);
        } catch (error) {
            state.failures.set(id, reasonOf(error));
            console.error(`polaris: ${id} is still unavailable:`, error);
            setTimeout(() => void attempt(), RETRY_MS).unref();
        }
    };
    setTimeout(() => void attempt(), RETRY_MS).unref();
}

/**
 * Load every installed app's bundle, fetching what this build does not have
 * yet. Waits a bounded time: a registry that does not answer delays the server
 * starting by a minute at most, and the app is tried again in the background.
 */
export async function prepareAppBundles(): Promise<void> {
    const loads = knownApps().map(async (id) => {
        if (!(await isAppInstalled(id))) return;
        try {
            await loadBundle(id);
            state.failures.delete(id);
        } catch (error) {
            state.failures.set(id, reasonOf(error));
            console.error(`polaris: ${id} could not be loaded:`, error);
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

/**
 * An app was installed: bring its code. Throws, with a sentence for the screen,
 * when it cannot be had - an install that leaves the app without its code is
 * not an install.
 */
export async function appInstalled(id: string): Promise<void> {
    if (!knownApps().includes(id)) return;
    try {
        await bring(id);
    } catch (error) {
        console.error(`polaris: ${id} could not be installed:`, error);
        const name = findApp(id)?.name ?? "The app";
        throw new Error(`${name} could not be installed. ${reasonOf(error)}`);
    }
}

/** Try again to bring an installed app whose code is not here. */
export async function retryApp(id: string): Promise<{ error?: string }> {
    if (!knownApps().includes(id)) return { error: "This version of Polaris does not have that app." };
    try {
        await bring(id);
        return {};
    } catch (error) {
        state.failures.set(id, reasonOf(error));
        console.error(`polaris: ${id} could not be loaded:`, error);
        return { error: reasonOf(error) };
    }
}

/** An app was uninstalled: take its code away. Its data stays. */
export async function appUninstalled(id: string): Promise<void> {
    if (!knownApps().includes(id)) return;
    unloadBundle(id);
    state.failures.delete(id);
    await removeBundle(id).catch((error: unknown) =>
        console.error(`polaris: ${id}'s code could not be removed:`, error)
    );
}

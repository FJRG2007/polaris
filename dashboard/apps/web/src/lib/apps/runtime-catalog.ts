/**
 * The published app catalogue, as this dashboard holds it.
 *
 * Signed the way the device plugin catalog is - Ed25519 over the exact bytes,
 * the public keys in `@polaris/core/device-plugins`, `catalogSigned` checking
 * them - and published by CI beside it on the repository's releases. Nothing
 * about this server is sent to read it, and it needs neither the host daemon
 * nor the updater, so the limited edition reads it the same way.
 *
 * Read stale-while-revalidate. The last good copy is kept on the data volume,
 * bytes and signature, and checked again when it is read back, so a server that
 * restarts offline still lists and runs the apps it had. A catalogue issued
 * earlier than the one held is never taken, so replaying an old signed copy
 * cannot bring back a withdrawn app or an older build.
 *
 * Server-only.
 */

import { join } from "node:path";
import { PERMISSIONS } from "@polaris/core";
import { bundleRoot } from "@/lib/app-bundles/store";
import { registerRuntimeApps } from "./runtime-apps";
import { follow, readCapped } from "@/lib/safe-fetch";
import { catalogSigned } from "@/lib/device-plugins-catalog";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
    APP_CATALOG_MAX_BYTES,
    APP_CATALOG_URL,
    appEntryFit,
    readAppCatalog,
    runtimeViews,
    type RuntimeAppCatalog,
    type RuntimeAppEntry,
    type RuntimeAppView
} from "./runtime-catalog-schema";

/** How long a held catalogue is used before a refresh is started. */
const FRESH_MS = 15 * 60_000;
/** How long a failed fetch waits before the next is tried. */
const RETRY_MS = 60_000;

/** The permissions this dashboard knows: an entry that uses any other needs a newer one. */
export const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(PERMISSIONS);

type Held = { catalog: RuntimeAppCatalog; at: number };
type State = { held: Held | null; failedAt: number; refreshing: Promise<void> | null; restored: boolean };

const state: State = ((globalThis as Record<symbol, unknown>)[Symbol.for("polaris.app-catalog")] ??= {
    held: null,
    failedAt: 0,
    refreshing: null,
    restored: false
}) as State;

function cacheDir(): string {
    return join(bundleRoot(), ".catalog");
}

/** The catalogue in `bytes`, or null unless `signature` is a trusted key's over exactly them. */
export function openAppCatalog(bytes: Uint8Array, signature: string, keys?: Parameters<typeof catalogSigned>[2]): RuntimeAppCatalog | null {
    if (bytes.byteLength > APP_CATALOG_MAX_BYTES || !catalogSigned(bytes, signature, keys)) return null;
    try {
        return readAppCatalog(JSON.parse(Buffer.from(bytes).toString("utf8")));
    } catch {
        return null;
    }
}

/** Whether `next` may replace `held`: never one issued earlier. */
export function newerOrSame(next: RuntimeAppCatalog, held: RuntimeAppCatalog | null): boolean {
    return !held || Date.parse(next.issued) >= Date.parse(held.issued);
}

function hold(catalog: RuntimeAppCatalog): void {
    state.held = { catalog, at: Date.now() };
    registerRuntimeApps(runtimeViews(catalog, KNOWN_PERMISSIONS, "en-US"));
}

async function restore(): Promise<void> {
    if (state.restored) return;
    state.restored = true;
    try {
        const [bytes, signature] = await Promise.all([
            readFile(join(cacheDir(), "catalog.json")),
            readFile(join(cacheDir(), "catalog.json.sig"), "utf8")
        ]);
        const catalog = openAppCatalog(bytes, signature);
        if (catalog && newerOrSame(catalog, state.held?.catalog ?? null)) {
            hold(catalog);
            // Read from disk, so it is as old as whatever wrote it: refresh at the first chance.
            if (state.held) state.held.at = 0;
        }
    } catch {
        // Nothing kept yet, or a copy that does not check out: the network decides.
    }
}

async function keep(bytes: Uint8Array, signature: Uint8Array): Promise<void> {
    const dir = cacheDir();
    await mkdir(dir, { recursive: true });
    // Signature first, then the bytes, each by rename: a copy cut short never checks out, and is ignored.
    for (const [name, data] of [["catalog.json.sig", signature], ["catalog.json", bytes]] as const) {
        const temp = join(dir, `${name}.${process.pid}.${Date.now()}.tmp`);
        await writeFile(temp, data);
        await rename(temp, join(dir, name));
    }
}

async function download(url: string, max: number): Promise<Uint8Array | null> {
    const response = await follow(new URL(url), "application/json,application/octet-stream,*/*", undefined, 20_000);
    if (!response || !response.ok) return null;
    return readCapped(response, max);
}

function refresh(): Promise<void> {
    state.refreshing ??= (async () => {
        try {
            const [bytes, signature] = await Promise.all([
                download(APP_CATALOG_URL, APP_CATALOG_MAX_BYTES),
                download(`${APP_CATALOG_URL}.sig`, 1_024)
            ]);
            const catalog = bytes && signature ? openAppCatalog(bytes, Buffer.from(signature).toString("utf8")) : null;
            if (!catalog || !bytes || !signature) state.failedAt = Date.now();
            else if (newerOrSame(catalog, state.held?.catalog ?? null)) {
                hold(catalog);
                await keep(bytes, signature).catch((error: unknown) => console.error("polaris: app catalogue not kept:", error));
            } else if (state.held) state.held.at = Date.now();
        } catch {
            state.failedAt = Date.now();
        } finally {
            state.refreshing = null;
        }
    })();
    return state.refreshing;
}

/**
 * The catalogue held, or null when none was ever read. Answers with what is
 * held and refreshes behind it; only a server that has never had one waits for
 * the network, and then for one fetch at most.
 */
export async function appCatalog(): Promise<RuntimeAppCatalog | null> {
    await restore();
    const now = Date.now();
    const due = (!state.held || now - state.held.at > FRESH_MS) && now - state.failedAt > RETRY_MS;
    if (state.held) {
        if (due) void refresh();
        return state.held.catalog;
    }
    if (due) await refresh();
    return state.held ? (state.held as Held).catalog : null;
}

/** Read the kept copy and start a refresh behind it, without waiting on the network. */
export async function primeAppCatalog(): Promise<void> {
    await restore();
    void appCatalog().catch(() => undefined);
}

/**
 * What the browser registers, in the viewer's locale, from what is held now.
 * Never waits: a server that has no catalogue yet lists none and asks for one.
 */
export function heldRuntimeAppViews(locale: string): RuntimeAppView[] {
    void appCatalog().catch(() => undefined);
    return runtimeViews(state.held?.catalog ?? null, KNOWN_PERMISSIONS, locale);
}

/** The entry for an app, from what is held now, when this dashboard can run it. */
export function runnableEntry(id: string): RuntimeAppEntry | null {
    const entry = state.held?.catalog.apps.find((app) => app.id === id);
    return entry && appEntryFit(entry, KNOWN_PERMISSIONS).ok ? entry : null;
}

/** Every app id held that this dashboard can run. */
export function runnableIds(): string[] {
    return (state.held?.catalog.apps ?? []).filter((app) => appEntryFit(app, KNOWN_PERMISSIONS).ok).map((app) => app.id);
}

/** What the browser registers, in the viewer's locale. Never waits on the network once anything is held. */
export async function runtimeAppViews(locale: string): Promise<RuntimeAppView[]> {
    return runtimeViews(await appCatalog(), KNOWN_PERMISSIONS, locale);
}

/** Forget what is held. For tests. */
export function resetAppCatalog(): void {
    state.held = null;
    state.failedAt = 0;
    state.refreshing = null;
    state.restored = false;
}

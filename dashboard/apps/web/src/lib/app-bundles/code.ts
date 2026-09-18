/**
 * An installed app's code, as this server has it: its bundle, loaded.
 *
 * The apps this dashboard can serve are the ones its image names a bundle for
 * (`app-bundles/index.json`). An app whose bundle is not loaded - not installed
 * here, or installed and its bundle not fetched yet - has no routes, no
 * extension and nothing in any core screen.
 *
 * Server-only.
 */

import { bundleIndex } from "./store";
import { matchRoute, type RouteParams } from "./route-match";
import { loadedBundle, loadedBundles, type LoadedBundle } from "./loader";
import type { AppExtension, AppSlot } from "@/lib/app-extensions/types";

type RouteModule = Record<string, unknown>;

/** The apps this build carries a bundle for. */
export function knownApps(): string[] {
    return Object.keys(bundleIndex()?.apps ?? {});
}

/** Each loaded app's extension. */
export function appExtensions(): AppExtension[] {
    return loadedBundles().map((bundle) => bundle.server.extension);
}

/** Where a file of a loaded bundle is served. */
export function bundleFileUrl(bundle: LoadedBundle, file: string): string {
    return `/api/app-bundles/${bundle.id}/${bundle.version}/${file}`;
}

/** A slot, with where the component that draws it is. */
export function withBundleSlot(slot: AppSlot): AppSlot {
    const bundle = loadedBundle(slot.app);
    const drawn = bundle?.manifest.slot;
    const entry = drawn ? bundle.manifest.client[drawn.module] : undefined;
    if (!bundle || !drawn || !entry) return slot;
    return { ...slot, bundle: { src: bundleFileUrl(bundle, entry.file), name: drawn.name } };
}

export interface AppRouteHit {
    readonly app: string;
    readonly pattern: string;
    readonly params: RouteParams;
    readonly load: () => Promise<RouteModule>;
}

/** The loaded app route that answers a path. */
export function findAppRoute(kind: "page" | "route", path: string): AppRouteHit | null {
    for (const bundle of loadedBundles()) {
        const patterns = bundle.manifest.routes
            .filter((route) => route.startsWith(`${kind} `))
            .map((route) => route.slice(kind.length + 1));
        const hit = matchRoute(patterns, path);
        const load = hit ? bundle.server.routes[`${kind} ${hit.pattern}`] : undefined;
        if (hit && load) return { app: bundle.id, pattern: hit.pattern, params: hit.params, load };
    }
    return null;
}

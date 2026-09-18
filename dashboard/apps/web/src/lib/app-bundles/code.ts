/**
 * Where an installed app's code is taken from: its bundle, or this image.
 *
 * During the release that introduces bundles an app travels both ways. The
 * copy compiled into the image answers unless this server has been switched
 * to bundles, and even then it answers for any app whose bundle is not loaded,
 * so a bundle that cannot be fetched or loaded leaves the app as it was rather
 * than gone. The switch is a file on the data volume, `apps/use-bundles`,
 * written on the machine that proves the bundle path; nothing else writes it.
 *
 * Server-only.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { bundleRoot } from "./store";
import { IN_IMAGE } from "./in-image";
import { loadedBundle } from "./loader";
import { matchRoute, type RouteParams } from "./route-match";
import type { AppExtension, AppSlot } from "@/lib/app-extensions/types";

type RouteModule = Record<string, unknown>;

let preferred: boolean | undefined;

/** Whether this server serves apps from their bundles. Read once per process. */
export function bundlesPreferred(): boolean {
    if (preferred === undefined) {
        try {
            preferred = existsSync(join(bundleRoot(), "use-bundles"));
        } catch {
            preferred = false;
        }
    }
    return preferred;
}

/** The apps this dashboard knows how to serve. */
export function knownApps(): string[] {
    return Object.keys(IN_IMAGE);
}

/** The bundle an app is served from now, if it is. */
function servingBundle(id: string) {
    return bundlesPreferred() ? loadedBundle(id) : undefined;
}

/** Each app's extension, from wherever that app is served. */
export function appExtensions(): AppExtension[] {
    return knownApps().map(
        (id) =>
            servingBundle(id)?.server.extension ??
            (IN_IMAGE[id] as { extension: AppExtension }).extension
    );
}

/** A slot, with where its component is when the app is served from a bundle. */
export function withBundleSlot(slot: AppSlot): AppSlot {
    const bundle = servingBundle(slot.app);
    const drawn = bundle?.manifest.slot;
    const entry = drawn ? bundle.manifest.client[drawn.module] : undefined;
    if (!bundle || !drawn || !entry) return slot;
    return {
        ...slot,
        bundle: {
            src: `/api/app-bundles/${bundle.id}/${bundle.version}/${entry.file}`,
            name: drawn.name
        }
    };
}

export interface AppRouteHit {
    readonly app: string;
    readonly pattern: string;
    readonly params: RouteParams;
    /** Set when the route is answered from a bundle. */
    readonly bundle: boolean;
    readonly load: () => Promise<RouteModule>;
}

/**
 * The app route that answers a path. Pages are matched against the image's
 * pages (`imagePages`), which only the page catch-alls import.
 */
export function findAppRoute(
    kind: "page" | "route",
    path: string,
    imagePages: Readonly<Record<string, Readonly<Record<string, RouteModule>>>> = {}
): AppRouteHit | null {
    for (const app of knownApps()) {
        const bundle = servingBundle(app);
        if (bundle) {
            const patterns = bundle.manifest.routes
                .filter((route) => route.startsWith(`${kind} `))
                .map((route) => route.slice(kind.length + 1));
            const hit = matchRoute(patterns, path);
            if (hit) {
                const load = bundle.server.routes[`${kind} ${hit.pattern}`];
                if (load)
                    return { app, pattern: hit.pattern, params: hit.params, bundle: true, load };
            }
            continue;
        }
        const table =
            kind === "page"
                ? Object.fromEntries(
                      Object.entries(imagePages[app] ?? {}).map(([pattern, module]) => [
                          pattern,
                          () => Promise.resolve(module)
                      ])
                  )
                : (IN_IMAGE[app]?.routes ?? {});
        const hit = matchRoute(Object.keys(table), path);
        const load = hit ? table[hit.pattern] : undefined;
        if (hit && load)
            return { app, pattern: hit.pattern, params: hit.params, bundle: false, load };
    }
    return null;
}

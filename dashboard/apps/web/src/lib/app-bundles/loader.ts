/**
 * An installed app's server half, loaded into this process.
 *
 * The bundle's server file is CommonJS evaluated here with Node's own compiler,
 * in this process's global scope - one Node process, one copy of every library.
 * The libraries it shares with the dashboard it asks for through the table
 * `shared-server.ts` keeps; the one thing `require` answers is Node's own
 * modules. Loaded once per process whichever of Next's bundle layers asked
 * first, and kept on the process so the others find the same one.
 *
 * Server-only.
 */

import { dirname, join } from "node:path";
import { compileFunction } from "node:vm";
import { readFile } from "node:fs/promises";
import { sharedPiece, sharedServerModules } from "./shared-server";
import { isBuiltin } from "node:module";
import type { AppExtension } from "@/lib/app-extensions/types";
import { ensureBundle, readManifest, type BundleManifest } from "./store";

/** What a bundle's server entry exports (see the bundler's generated entry). */
interface BundleServer {
    readonly extension: AppExtension;
    readonly routes: Readonly<Record<string, () => Promise<Record<string, unknown>>>>;
    readonly actions: Readonly<Record<string, () => Promise<Record<string, unknown>>>>;
}

export interface LoadedBundle {
    readonly id: string;
    readonly dir: string;
    /** The folder's name, the bundle's digest: what its browser files are served under. */
    readonly version: string;
    readonly manifest: BundleManifest;
    readonly server: BundleServer;
}

type Registry = { loaded: Map<string, LoadedBundle>; loading: Map<string, Promise<LoadedBundle>> };

const registry: Registry = ((globalThis as Record<symbol, unknown>)[
    Symbol.for("polaris.app-bundles.loaded")
] ??= {
    loaded: new Map(),
    loading: new Map()
}) as Registry;

/** An app's bundle as it is loaded now, if it is. */
export function loadedBundle(id: string): LoadedBundle | undefined {
    return registry.loaded.get(id);
}

/** Every bundle loaded now. */
export function loadedBundles(): LoadedBundle[] {
    return [...registry.loaded.values()];
}

async function evaluate(id: string, dir: string): Promise<LoadedBundle> {
    const manifest = await readManifest(dir);
    const provided = sharedServerModules();
    const missing = manifest.shared.server.filter((spec) => !provided.has(spec));
    if (missing.length > 0) {
        throw new Error(`${id} needs what this Polaris does not provide: ${missing.join(", ")}`);
    }
    const filename = join(dir, manifest.server);
    const code = await readFile(filename, "utf8");
    const require = (spec: string): unknown => {
        // `process/` is how a library written for browsers too asks for Node's own.
        const builtin = spec.replace(/\/$/, "");
        if (isBuiltin(builtin)) return process.getBuiltinModule(builtin);
        throw new Error(
            `${id} asked for ${spec}, which a bundle has to carry or take from the dashboard`
        );
    };
    const run = compileFunction(code, ["exports", "require", "module", "__filename", "__dirname"], {
        filename
    });
    const module = { exports: {} as Record<string, unknown> };
    run.call(module.exports, module.exports, require, module, filename, dirname(filename));
    const server = module.exports as unknown as BundleServer;
    if (!server.extension || server.extension.id !== id || !server.routes || !server.actions) {
        throw new Error(`${id}'s bundle does not describe ${id}`);
    }
    return { id, dir, version: dir.split(/[/\\]/).pop() as string, manifest, server };
}

/** Load an app's bundle, fetching it first if this server does not have it. */
export function loadBundle(id: string): Promise<LoadedBundle> {
    const current = registry.loaded.get(id);
    if (current) return Promise.resolve(current);
    const running = registry.loading.get(id);
    if (running) return running;
    const work = (async () => {
        const bundle = await evaluate(id, await ensureBundle(id));
        registry.loaded.set(id, bundle);
        return bundle;
    })().finally(() => registry.loading.delete(id));
    registry.loading.set(id, work);
    return work;
}

/** Stop serving an app's bundle. What it already started keeps its own lifetime. */
export function unloadBundle(id: string): void {
    registry.loaded.delete(id);
}

type Jsx = { jsx: (type: unknown, props: Record<string, unknown>) => unknown };
type Mount = { AppBundleMount: unknown };

/**
 * What a bundle's server half has where it imported a client component: a
 * server component that draws `AppBundleMount` with the address of the app's
 * browser module and the props it was given. Read when it is drawn, so the
 * bundle can load before the layer that draws pages has provided the mount.
 */
function clientReference(app: string, module: string, name: string) {
    const Reference = (props: Record<string, unknown>) => {
        const bundle = registry.loaded.get(app);
        const entry = bundle?.manifest.client[module];
        if (!bundle || !entry)
            throw new Error(`${app} is not loaded, so ${module} cannot be drawn`);
        const { jsx } = sharedPiece<Jsx>("react/jsx-runtime");
        const { AppBundleMount } = sharedPiece<Mount>("polaris:mount");
        return jsx(AppBundleMount, {
            src: `/api/app-bundles/${app}/${bundle.version}/${entry.file}`,
            name,
            props
        });
    };
    Reference.displayName = name;
    return Reference;
}

(globalThis as Record<symbol, unknown>)[Symbol.for("polaris.app-client-ref")] = clientReference;

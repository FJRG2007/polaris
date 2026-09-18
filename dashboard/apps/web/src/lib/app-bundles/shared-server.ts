/**
 * The libraries an app's server half takes from the dashboard.
 *
 * A bundle carries none of React, Next, zod or the @polaris packages (see the
 * bundler); it asks for each by name here, and gets this dashboard's own copy,
 * so an installed app is one more set of modules in the same process rather than
 * a second React and a second database client.
 *
 * Next compiles the dashboard once per bundle layer, and a server component and
 * a route handler see different copies of some libraries: in the layer that
 * renders server components, React has no hooks and a client component is a
 * reference to the browser's copy rather than the component itself. An app's
 * page has to be drawn with that layer's copies, so each layer that imports
 * this records its own, and the ones that matter to drawing are looked up
 * there first. The rest are the same code whichever layer is asked.
 *
 * Every name is read when the app reads it, not when the bundle loads: the
 * layer that draws pages may import this after the app's server half is up.
 *
 * Server-only.
 */

import * as zod from "zod";
import * as react from "react";
import * as ui from "@polaris/ui";
import * as db from "@polaris/db";
import * as ssh from "@polaris/ssh";
import * as core from "@polaris/core";
import * as auth from "@polaris/auth";
import * as nextLink from "next/link";
import * as nextCache from "next/cache";
import * as config from "@polaris/config";
import * as deploy from "@polaris/deploy";
import * as nextServer from "next/server";
import * as storage from "@polaris/storage";
import * as nextHeaders from "next/headers";
import * as appHost from "@polaris/app-host";
import * as jsxRuntime from "react/jsx-runtime";
import * as nextNavigation from "next/navigation";
import { markRevalidated } from "./action-context";
import * as linkPassword from "@polaris/core/link-password";
import * as catalogSearch from "@polaris/core/catalog-search";

type Modules = Record<string, object>;
type Table = { rsc?: Modules; any?: Modules };

/** What differs between the layer that draws server components and the rest. */
const DRAWN = new Set(["react", "react/jsx-runtime", "@polaris/ui", "next/link"]);

/**
 * Revalidating from an app's server action is how it asks for the screen to be
 * drawn again. Next does that for its own actions; for an app's, the dashboard
 * answers the call (`/api/apps/action`) and tells the browser to refresh.
 */
const cache = {
    ...nextCache,
    revalidatePath: (...args: Parameters<typeof nextCache.revalidatePath>) => {
        markRevalidated();
        return nextCache.revalidatePath(...args);
    },
    revalidateTag: (...args: Parameters<typeof nextCache.revalidateTag>) => {
        markRevalidated();
        return nextCache.revalidateTag(...args);
    }
};

const MODULES: Modules = {
    "@polaris/app-host": appHost,
    "@polaris/auth": auth,
    "@polaris/config": config,
    "@polaris/core": core,
    "@polaris/core/catalog-search": catalogSearch,
    "@polaris/core/link-password": linkPassword,
    "@polaris/db": db,
    "@polaris/deploy": deploy,
    "@polaris/ssh": ssh,
    "@polaris/storage": storage,
    "@polaris/ui": ui,
    "next/cache": cache,
    "next/headers": nextHeaders,
    "next/link": nextLink,
    "next/navigation": nextNavigation,
    "next/server": nextServer,
    react,
    "react/jsx-runtime": jsxRuntime,
    zod
};

const SLOT = Symbol.for("polaris.app-shared");
const TABLE = Symbol.for("polaris.app-shared.server");

type Global = Record<symbol, unknown>;

const table = ((globalThis as Global)[TABLE] ??= {}) as Table;

/** React without hooks is the build that draws server components. */
const drawing = typeof (react as { useState?: unknown }).useState !== "function";

/** Record this layer's copies, and the one extra piece that layer draws with. */
export function provideShared(extra: Modules = {}): void {
    const modules = { ...MODULES, ...extra };
    if (drawing) table.rsc = { ...table.rsc, ...modules };
    else table.any = { ...table.any, ...modules };
}

function find(spec: string): object {
    const order =
        DRAWN.has(spec) || spec.startsWith("polaris:")
            ? [table.rsc, table.any]
            : [table.any, table.rsc];
    for (const modules of order) {
        const found = modules?.[spec];
        if (found) return found;
    }
    throw new Error(`The dashboard does not provide ${spec} to apps`);
}

/** What `find` would answer, for a piece only the drawing layer has. */
export function sharedPiece<T>(spec: string): T {
    return find(spec) as T;
}

const proxies = new Map<string, object>();

function moduleProxy(spec: string): object {
    let proxy = proxies.get(spec);
    if (proxy) return proxy;
    const read = (key: string | symbol): unknown => {
        if (key === "__esModule") return true;
        const found = find(spec) as Record<string | symbol, unknown>;
        if (key === "default") return found.default ?? found;
        return found[key];
    };
    proxy = new Proxy(Object.create(null) as object, {
        get: (_target, key) => read(key),
        has: (_target, key) => key in find(spec),
        ownKeys: () => [...new Set([...Reflect.ownKeys(find(spec)), "default"])],
        getOwnPropertyDescriptor: (_target, key) => ({
            configurable: true,
            enumerable: true,
            get: () => read(key)
        })
    });
    proxies.set(spec, proxy);
    return proxy;
}

/** The names an app's server half may ask for. */
export function sharedServerModules(): ReadonlySet<string> {
    return new Set(Object.keys(MODULES));
}

(globalThis as Global)[SLOT] = (side: string, spec: string) => {
    if (side !== "server")
        throw new Error(`A browser module of an app was loaded on the server (${spec})`);
    return moduleProxy(spec);
};

provideShared();

/**
 * What an installed app's browser modules take from the dashboard.
 *
 * A bundle's browser half carries none of React, Next, zod or the @polaris
 * packages; it asks for each by name, and gets the copy this page is already
 * running, so an app's component shares the page's React tree, router and
 * design system. Its server actions are forwarded to `/api/app-bundles/action`.
 *
 * Loaded the first time an app component is drawn, so a page with no app on it
 * never downloads any of this.
 */

import * as zod from "zod";
import * as React from "react";
import * as ui from "@polaris/ui";
import * as core from "@polaris/core";
import * as nextLink from "next/link";
import * as nextImage from "next/image";
import * as zoom from "@polaris/ui/zoom";
import * as jsxRuntime from "react/jsx-runtime";
import * as nextNavigation from "next/navigation";
import * as hostClient from "@polaris/app-host/client";
import { fromWire, toWire } from "@/lib/app-bundles/wire";
import * as catalogSearch from "@polaris/core/catalog-search";

type Router = { push: (href: string) => void; refresh: () => void };

const MODULES: Record<string, object> = {
    "@polaris/app-host/client": hostClient,
    "@polaris/core": core,
    "@polaris/core/catalog-search": catalogSearch,
    "@polaris/ui": ui,
    "@polaris/ui/zoom": zoom,
    "next/image": nextImage,
    "next/link": nextLink,
    "next/navigation": nextNavigation,
    react: React,
    "react/jsx-runtime": jsxRuntime,
    zod
};

/** The names an app's browser half may ask for. */
export const SHARED_CLIENT_MODULES: readonly string[] = Object.keys(MODULES);

let router: Router | null = null;

type Global = Record<symbol, unknown>;

function moduleFor(side: string, spec: string): object {
    if (side !== "client")
        throw new Error(`A server module of an app was loaded in the browser (${spec})`);
    const found = MODULES[spec];
    if (!found) throw new Error(`The dashboard does not provide ${spec} to apps`);
    return asCommonJs(found);
}

/**
 * A module of the page's, in the shape a bundle reads it: CommonJS, marked as
 * compiled from ES modules, with the real default export on `default`.
 *
 * The bundle asks for these through `require` (see the bundler's shared
 * plugin), and esbuild takes `default` from what it is handed only when that is
 * marked `__esModule`; otherwise the whole object becomes the default. An ES
 * namespace carries no such mark, so `import Image from "next/image"` got the
 * namespace - `{ default, getImageProps }` - and React refused it as a
 * component: "Appearance could not be shown", error 130, on every game server.
 *
 * A module with no default gets itself as one. And a CommonJS module that was
 * itself read as a namespace (Node does this) has its real default one level
 * down, which is taken rather than handed on as an object.
 *
 * The mark is not always read. An app's source is an ES module package, and
 * esbuild imports CommonJS into one the way Node does - `__toESM(mod, 1)` -
 * which makes the whole object the default whatever it says. So where the
 * default is a component, what is handed over is itself a component that draws
 * it, carrying the named exports: both readings of `import Link from
 * "next/link"` are then something React can draw. Without it the Game servers
 * list, which links every row, stopped with error 130.
 */
export function asCommonJs(found: object): object {
    if (!("default" in found)) return { ...found, default: found, __esModule: true };
    let value = (found as { default: unknown }).default;
    if (
        value !== null &&
        typeof value === "object" &&
        (value as { __esModule?: unknown }).__esModule === true &&
        "default" in value
    )
        value = (value as { default: unknown }).default;
    if (!isComponent(value)) return { ...found, default: value, __esModule: true };
    const component = value;
    function SharedDefault(props: Record<string, unknown>) {
        return React.createElement(component, props);
    }
    // Defined one by one: a function already owns `name` and `length`, read-only,
    // and a module exporting either must not make handing it over throw.
    const members: Record<string, unknown> = { ...found, default: component, __esModule: true };
    for (const [key, member] of Object.entries(members)) {
        if (Object.getOwnPropertyDescriptor(SharedDefault, key)?.configurable === false) continue;
        Object.defineProperty(SharedDefault, key, {
            value: member,
            enumerable: true,
            configurable: true,
            writable: true
        });
    }
    return SharedDefault;
}

/** Whether a value is something React draws: a function, or one of React's own
 *  wrappers (`forwardRef`, `memo`, `lazy`), which are objects carrying `$$typeof`. */
function isComponent(value: unknown): value is React.ElementType {
    if (typeof value === "function") return true;
    return value !== null && typeof value === "object" && "$$typeof" in value;
}

interface ActionAnswer {
    value?: unknown;
    revalidated?: boolean;
    redirect?: string;
    error?: string;
}

async function callAction(
    app: string,
    module: string,
    name: string,
    args: unknown[]
): Promise<unknown> {
    const response = await fetch("/api/app-bundles/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app, module, name, args: toWire(args) })
    });
    const answer = (await response.json().catch(() => null)) as ActionAnswer | null;
    if (!response.ok || !answer)
        throw new Error(answer?.error ?? "The server could not do that. Try again.");
    if (answer.redirect) {
        router?.push(answer.redirect);
        // A redirect ends the action; nothing waiting on it should carry on.
        return new Promise(() => undefined);
    }
    if (answer.revalidated) router?.refresh();
    return fromWire(answer.value);
}

function install(): void {
    const global = globalThis as Global;
    global[Symbol.for("polaris.app-shared")] = moduleFor;
    global[Symbol.for("polaris.app-action")] = callAction;
}

const modules = new Map<string, Promise<Record<string, unknown>>>();

/** An app's browser module, imported once per page. */
export function loadAppModule(src: string, current: Router): Promise<Record<string, unknown>> {
    router = current;
    install();
    let module = modules.get(src);
    if (!module) {
        module = import(/* webpackIgnore: true */ src) as Promise<Record<string, unknown>>;
        module.catch(() => modules.delete(src));
        modules.set(src, module);
    }
    return module;
}

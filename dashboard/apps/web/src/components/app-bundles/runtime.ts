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
import * as zoom from "@polaris/ui/zoom";
import * as nextLink from "next/link";
import * as nextImage from "next/image";
import * as jsxRuntime from "react/jsx-runtime";
import * as nextNavigation from "next/navigation";
import * as hostClient from "@polaris/app-host/client";
import * as catalogSearch from "@polaris/core/catalog-search";
import { fromWire, toWire } from "@/lib/app-bundles/wire";

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
    // Read as a CommonJS module: `default` is the module when it has none.
    return "default" in found ? found : { ...found, default: found, __esModule: true };
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

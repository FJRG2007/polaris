/**
 * The dashboard's client pieces, as an installable app's components see them:
 * shared components, hooks and helpers that belong to the dashboard's shell.
 *
 * Provided by a client component the dashboard's layout renders. An app module
 * can be evaluated before that one, so a name looked up early is handed back as
 * a stand-in that finds the real thing when it is used - a component renders
 * it, a hook or a function calls it. By then the layout has provided them.
 */

import { createElement, type ComponentType } from "react";
import { hostProxy, lookup, provide, provided } from "./registry";

/** Every client piece an app may use, by area. Filled in by the dashboard. */
export interface AppHostUi {}

/** Hand the apps the dashboard's client pieces. Called by the dashboard. */
export function provideAppHostUi(pieces: AppHostUi): void {
    provide("client", pieces);
}

function resolve(area: string, name: string): unknown {
    const pieces = provided("client");
    if (!pieces) {
        throw new Error(
            `An app used "${area}.${name}" before the dashboard provided its client pieces`
        );
    }
    return lookup(pieces, "client", area, name);
}

/** Components are capitalised; everything else is called. */
function standIn(area: string, name: string): unknown {
    if (/^[A-Z]/.test(name)) {
        const StandIn = (props: object) =>
            createElement(resolve(area, name) as ComponentType<object>, props);
        StandIn.displayName = name;
        return StandIn;
    }
    return (...args: unknown[]) => (resolve(area, name) as (...a: unknown[]) => unknown)(...args);
}

/** The dashboard's client pieces. */
export const hostUi: AppHostUi = hostProxy<AppHostUi>("client", standIn);

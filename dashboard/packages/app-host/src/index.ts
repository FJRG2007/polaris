/**
 * The dashboard, as an installable app sees it.
 *
 * An app's code is meant to be present only on a server that installed it (see
 * docs/installable-apps-plan.md), so it cannot import the dashboard's modules:
 * those are the dashboard's, not the app's, and a bundle built from the app must
 * load into whatever dashboard it is installed on. What an app needs from the
 * dashboard - the session, deploys, settings, notifications - it takes from
 * here instead, and the dashboard provides it when it starts.
 *
 * The contract is the dashboard's `lib/app-host/server.ts`: `AppHost` and
 * `AppHostTypes` are filled in there by module augmentation, so an app is
 * type-checked against exactly what the running dashboard offers, and a service
 * taken away is a compile error in the app rather than a failure at runtime.
 *
 * Server side. An app's client components use `@polaris/app-host/client`.
 */

import { hostProxy, provide } from "./registry";

/** Every server service an app may call, by area. Filled in by the dashboard. */
export interface AppHost {}

/** The types those services take and return, by name. Filled in by the dashboard. */
export interface AppHostTypes {}

/** Hand the apps the dashboard's server services. Called by the dashboard. */
export function provideAppHost(services: AppHost): void {
    provide("server", services);
}

/**
 * The dashboard's server services.
 *
 * Nothing on the server may run an app's code before the dashboard has provided
 * these, so asking for one earlier is a fault in how the app was loaded and is
 * reported as one, rather than handed back as something that fails later.
 */
export const host: AppHost = hostProxy<AppHost>("server", (area, name) => {
    throw new Error(
        `An app asked for "${area}.${name}" before the dashboard provided its services`
    );
});

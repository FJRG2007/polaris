/**
 * An installed app's page, drawn by the catch-all route of the surface it lives
 * under (`/places/...`, `/apps/games/...`).
 *
 * The page is a server component from the app's bundle, drawn here with the
 * copies of React and the design system this layer draws with (see
 * `shared-server.ts`). Its client components cannot be references Next compiled,
 * so each is drawn by `AppBundleMount`, which loads the app's browser module and
 * hands it the same props.
 *
 * Server-only.
 */

import { findApp } from "@/lib/apps/catalog";
import { notFound, redirect } from "next/navigation";
import { loadedBundle } from "./loader";
import { provideShared } from "./shared-server";
import { findAppRoute, knownApps } from "./code";
import { appUnavailableReason } from "./lifecycle";
import * as mount from "@/components/app-bundles/mount";
import { isAppInstalled } from "@/lib/apps/install-presence";
import { AppUnavailable } from "@/components/app-bundles/unavailable";
import type { ComponentType } from "react";

provideShared({ "polaris:mount": mount });

export interface AppPageProps {
    readonly params: Promise<{ path?: string[] }>;
    readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

type PageComponent = ComponentType<{
    params: Promise<Record<string, string | string[]>>;
    searchParams: AppPageProps["searchParams"];
}>;

/** Draw the page of `app` that answers `<surface>/<path...>`. */
export async function renderAppPage(surface: string, app: string, { params, searchParams }: AppPageProps) {
    const { path = [] } = await params;
    const url = [surface, ...path.map((part) => encodeURIComponent(part))].join("/");
    const hit = findAppRoute("page", url);
    if (hit) {
        const Page = (await hit.load()).default as PageComponent | undefined;
        if (!Page) notFound();
        return <Page params={Promise.resolve(hit.params)} searchParams={searchParams} />;
    }
    if (!knownApps().includes(app)) notFound();
    // Not installed here: where it is installed from.
    if (!(await isAppInstalled(app))) redirect(`/apps/marketplace?app=${encodeURIComponent(app)}`);
    if (loadedBundle(app)) notFound();
    // Installed, and its code not here yet.
    return (
        <AppUnavailable
            app={app}
            name={findApp(app)?.name ?? "This app"}
            reason={appUnavailableReason(app) ?? "Polaris is still downloading it. Try again in a moment."}
        />
    );
}

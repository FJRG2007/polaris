/**
 * An installed app's page, drawn by the catch-all route of the surface it lives
 * under (`/places/...`, `/game-servers/...`).
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
import { notFound } from "next/navigation";
import { loadedBundle } from "./loader";
import { provideShared } from "./shared-server";
import { findAppRoute, knownApps } from "./code";
import { appFailure } from "./lifecycle";
import { appUpdating } from "./releases";
import * as mount from "@/components/app-bundles/mount";
import { isAppInstalled } from "@/lib/apps/install-presence";
import { requireUser } from "@/lib/session";
import { requireInstalledApp } from "@/lib/apps/require-installed";
import { AppUnavailable } from "@/components/app-bundles/unavailable";
import { getTranslations } from "@/lib/i18n/request";
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

/**
 * Draw the page of `app` that answers `<surface>/<path...>`.
 *
 * A `public` surface is read by people who are not signed in, so an app that is
 * not installed, or not here yet, is simply not found there: sending a visitor
 * to the marketplace or naming the app's state would be a page about this
 * Polaris that nobody outside it should be shown.
 */
export async function renderAppPage(
    surface: string,
    app: string,
    { params, searchParams }: AppPageProps,
    options: { readonly public?: boolean } = {}
) {
    const { path = [] } = await params;
    const url = [surface, ...path.map((part) => encodeURIComponent(part))].join("/");
    // An app's administrator settings have one address,
    // `/admin/apps/<app>/settings`, which draws them (`renderAppSettings`).
    if (findApp(app)?.settingsAt === url) notFound();
    const hit = findAppRoute("page", url);
    if (hit) {
        const Page = (await hit.load()).default as PageComponent | undefined;
        if (!Page) notFound();
        return <Page params={Promise.resolve(hit.params)} searchParams={searchParams} />;
    }
    if (!knownApps().includes(app) || options.public) notFound();
    // Not installed here: where it is installed from.
    if (!(await isAppInstalled(app))) await requireInstalledApp(app, await requireUser());
    if (loadedBundle(app)) notFound();
    // Installed, and its code not here yet - or here and unable to run on this
    // version of Polaris, which only an update fixes.
    const [t, user] = await Promise.all([getTranslations("components"), requireUser()]);
    const failure = appFailure(app);
    const progress = appUpdating(app);
    return (
        <AppUnavailable
            app={app}
            name={findApp(app)?.name ?? t("appBundles.thisApp")}
            reason={failure?.reason ?? t("appBundles.stillDownloading")}
            update={failure?.update}
            updating={Boolean(progress)}
            canUpdate={user.isAdmin}
        />
    );
}

/**
 * The administrator settings an installed app draws among its own routes
 * (`settingsAt` in its catalog entry), for `/admin/apps/<app>/settings` to
 * draw inside its own frame. Null when the app's code is not here.
 */
export async function renderAppSettings(app: string, searchParams: AppPageProps["searchParams"]) {
    const at = findApp(app)?.settingsAt;
    const hit = at ? findAppRoute("page", at) : null;
    if (!hit) return null;
    const Page = (await hit.load()).default as PageComponent | undefined;
    if (!Page) return null;
    return <Page params={Promise.resolve(hit.params)} searchParams={searchParams} />;
}

/**
 * An installed app's page, drawn by the catch-all route of the surface it lives
 * under (`/places/...`, `/apps/games/...`).
 *
 * A page from a bundle is a server component like any other, drawn here with the
 * copies of React and the design system this layer draws with (see
 * `shared-server.ts`). Its client components cannot be references Next compiled,
 * so each is drawn by `AppBundleMount`, which loads the app's browser module and
 * hands it the same props.
 *
 * Server-only.
 */

import { notFound } from "next/navigation";
import { findAppRoute } from "./code";
import { provideShared } from "./shared-server";
import { IN_IMAGE_PAGES } from "./in-image-pages";
import * as mount from "@/components/app-bundles/mount";
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

/** Draw the app page that answers `<surface>/<path...>`, or a 404. */
export async function renderAppPage(surface: string, { params, searchParams }: AppPageProps) {
    const { path = [] } = await params;
    const url = [surface, ...path.map((part) => encodeURIComponent(part))].join("/");
    const hit = findAppRoute("page", url, IN_IMAGE_PAGES);
    if (!hit) notFound();
    const Page = (await hit.load()).default as PageComponent | undefined;
    if (!Page) notFound();
    return <Page params={Promise.resolve(hit.params)} searchParams={searchParams} />;
}

// The screens of an app published after this image was built: one route serves
// every such app, so a new app needs no new route (see lib/apps/runtime-catalog).
import "@/lib/app-host/server";
import { notFound } from "next/navigation";
import { findApp } from "@/lib/apps/catalog";
import { RUNTIME_APP_BASE } from "@/lib/apps/runtime-catalog-schema";
import { renderAppPage } from "@/lib/app-bundles/serve-page";

export const dynamic = "force-dynamic";

interface Props {
    readonly params: Promise<{ appId: string; path?: string[] }>;
    readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function Page({ params, searchParams }: Props) {
    const { appId, path } = await params;
    // Only an app the published catalogue registered; an image's own apps keep their own addresses.
    if (!findApp(appId)?.runtime) notFound();
    return renderAppPage(`${RUNTIME_APP_BASE}/${appId}`, appId, {
        params: Promise.resolve(path ? { path } : {}),
        searchParams
    });
}

/**
 * A status page, as anybody with its address sees it. No session: only what
 * `publicStatusPage` lets out, and nothing at all for an unpublished page.
 */

import type { Metadata } from "next";
import { host } from "@polaris/app-host";
import { notFound } from "next/navigation";
import { statusT } from "../../../lib/i18n";
import { SLUG_PATTERN } from "../../../model/schemas";
import { publicStatusPage } from "../../../lib/public";
import { StatusView } from "../../../screens/status-view";

export const dynamic = "force-dynamic";

async function read(params: Promise<Record<string, string | string[]>>) {
    const { slug } = await params;
    if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) return null;
    return publicStatusPage(slug);
}

export async function generateMetadata({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}): Promise<Metadata> {
    const view = await read(params);
    return view ? { title: view.title, robots: { index: true } } : {};
}

export default async function PublicStatusPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    const view = await read(params);
    if (!view) notFound();
    const [t, locale] = await Promise.all([statusT(), host.i18nRequest.getLocale()]);
    return (
        <main className="min-h-dvh bg-background text-foreground">
            <StatusView view={view} t={t} locale={locale} />
        </main>
    );
}

// Calendar's public pages - a published calendar, its embed, a booking page, an
// invitation's answer, a proposal's vote. Outside the app shell and outside
// authentication: each page checks its own token (see lib/app-bundles/serve-page).
import "@/lib/app-host/server";
import { renderAppPage, type AppPageProps } from "@/lib/app-bundles/serve-page";
import type { Metadata } from "next";
import { linkPreviewMetadata } from "@/lib/link-preview/metadata";

export const dynamic = "force-dynamic";

/** A public calendar page previews as its kind only. */
export async function generateMetadata(): Promise<Metadata> {
    return linkPreviewMetadata("calendar", "");
}

export default function Page(props: AppPageProps) {
    return renderAppPage("/cal", "calendar", props, { public: true });
}

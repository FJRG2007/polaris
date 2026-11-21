// Public status pages. Outside the app shell and outside authentication: the
// page shows only what its operator published (see lib/app-bundles/serve-page).
import "@/lib/app-host/server";
import { renderAppPage, type AppPageProps } from "@/lib/app-bundles/serve-page";
import type { Metadata } from "next";
import { linkPreviewMetadata } from "@/lib/link-preview/metadata";

export const dynamic = "force-dynamic";

/** A public status page previews as its kind only. */
export async function generateMetadata(): Promise<Metadata> {
    return linkPreviewMetadata("status", "");
}

export default function Page(props: AppPageProps) {
    return renderAppPage("/status", "status-pages", props, { public: true });
}

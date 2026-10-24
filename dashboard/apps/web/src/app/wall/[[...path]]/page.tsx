/**
 * A wall panel full screen, for somebody signed in: outside the app's own
 * layout on purpose, so a tablet on the wall shows the cards and nothing else -
 * no sidebar, no header. Who may open it is the page's own check (Places,
 * `routes/wall`); the panel handed out as a link is `/k/<token>` instead.
 */

import "@/lib/app-host/server";
import type { Metadata } from "next";
import { renderAppPage, type AppPageProps } from "@/lib/app-bundles/serve-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function WallPage(props: AppPageProps) {
    return renderAppPage("/wall", "home", props);
}

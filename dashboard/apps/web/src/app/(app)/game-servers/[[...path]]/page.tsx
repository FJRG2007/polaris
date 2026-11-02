// Game servers's screens. They are the app's own (see lib/app-bundles/serve-page).
import "@/lib/app-host/server";
import { renderAppPage, type AppPageProps } from "@/lib/app-bundles/serve-page";

export const dynamic = "force-dynamic";

// The bundle still names this page `/apps/games`: apps update apart from the
// dashboard, so that name is the contract between the two, not an address.
export default function Page(props: AppPageProps) {
    return renderAppPage("/apps/games", "game-servers", props);
}

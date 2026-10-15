// Public status pages. Outside the app shell and outside authentication: the
// page shows only what its operator published (see lib/app-bundles/serve-page).
import "@/lib/app-host/server";
import { renderAppPage, type AppPageProps } from "@/lib/app-bundles/serve-page";

export const dynamic = "force-dynamic";

export default function Page(props: AppPageProps) {
    return renderAppPage("/status", "status-pages", props, { public: true });
}

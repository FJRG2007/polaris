// Cloud servers, a section of Servers. The screens are the app's own (see lib/app-bundles/serve-page).
import "@/lib/app-host/server";
import { renderAppPage, type AppPageProps } from "@/lib/app-bundles/serve-page";

export const dynamic = "force-dynamic";

export default function Page(props: AppPageProps) {
    return renderAppPage("/apps/servers/cloud", "cloud-servers", props);
}

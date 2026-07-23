/**
 * An installed app's adapted dashboard. The shell (status, lifecycle controls,
 * runtime logs) is shared; app-specific panels mount inside it keyed by the
 * catalog id (e.g. the Messaging bridge's channel panel). Apps without an adapted
 * panel fall back to the shared log view.
 */

import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { getInstalledApp } from "@/lib/apps/install-service";
import { InstalledAppDashboard } from "./installed-app-dashboard";

export const dynamic = "force-dynamic";

export default async function InstalledAppPage({ params }: { params: Promise<{ id: string }> }) {
    const user = await requirePermission("deploy.read");
    const { id } = await params;
    const app = await getInstalledApp(user.id, id);
    if (!app) notFound();
    return <InstalledAppDashboard app={app} />;
}

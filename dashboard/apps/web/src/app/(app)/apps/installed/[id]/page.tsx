/**
 * An installed app's adapted dashboard. For now every compose-template app gets
 * the generic dashboard (status, lifecycle controls, runtime logs) reused from
 * Deploy; app-specific panels (e.g. a Minecraft console) mount here later, keyed
 * by the manifest's dashboard kind.
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

/**
 * One device plugin (/account/plugins/<id>): its details, and once installed,
 * its device status, its settings, and turning it off or uninstalling it.
 */

import { requireUser } from "@/lib/session";
import { PluginPage } from "../plugins-view";

export default async function PluginDetailPage({ params }: { params: Promise<{ pluginId: string }> }) {
    await requireUser();
    const { pluginId } = await params;
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
            <PluginPage id={decodeURIComponent(pluginId)} />
        </div>
    );
}

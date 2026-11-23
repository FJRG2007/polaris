/**
 * One device add-on (/account/addons/<id>): its details, and once installed,
 * its device status, its settings, and turning it off or uninstalling it.
 */

import { requireUser } from "@/lib/session";
import { AddonPage } from "../addons-view";

export default async function AddonDetailPage({ params }: { params: Promise<{ addonId: string }> }) {
    await requireUser();
    const { addonId } = await params;
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
            <AddonPage id={decodeURIComponent(addonId)} />
        </div>
    );
}

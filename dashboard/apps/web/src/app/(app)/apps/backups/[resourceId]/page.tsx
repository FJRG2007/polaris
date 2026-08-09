/**
 * One protected thing (/apps/backups/[resourceId]).
 *
 * Awaits nothing but the session: the copies and the activity are fetched by the
 * view after the first paint, because reading a copy beside a game server means
 * asking that server, and a page that waited for it would be blank until it
 * answered.
 */

import { requireAdmin } from "@/lib/session";
import { ResourceDetailView } from "./resource-detail";

export default async function BackupResourcePage({
    params
}: {
    params: Promise<{ resourceId: string }>;
}) {
    await requireAdmin();
    const { resourceId } = await params;

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 py-2">
            <ResourceDetailView resourceId={resourceId} />
        </div>
    );
}

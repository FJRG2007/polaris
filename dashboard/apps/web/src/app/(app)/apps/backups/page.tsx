/**
 * Backups app (/apps/backups). A first-class Polaris app for managing backups:
 * the Polaris database today, with NAS and other-app targets to follow. Admin-
 * only. Server component that loads the current backups and hands them to the
 * client view.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { listBackups } from "@/lib/backup-service";
import { BackupsView } from "./backups-view";

export const dynamic = "force-dynamic";

export default async function BackupsPage() {
    await requireAdmin();
    const backups = await listBackups();

    return (
        <>
            <PageHeader
                title="Backups"
                description="Back up and restore Polaris and, soon, your NAS and other apps."
            />
            <BackupsView initialBackups={backups} />
        </>
    );
}

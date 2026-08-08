/**
 * Backups app (/apps/backups). A first-class Polaris app for managing backups:
 * the Polaris database and every Minecraft world today, with NAS and other-app
 * targets to follow. Admin-only. Server component that loads the current backups
 * and the game servers there are worlds to back up on, and hands them to the
 * client view - the worlds themselves are measured inside each container, so that
 * part is loaded per server after the page has painted rather than before it.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { BackupsView } from "./backups-view";
import { listBackups } from "@/lib/backup-service";
import { listGameServerFacts } from "@/lib/apps/games-service";

export const dynamic = "force-dynamic";

export default async function BackupsPage() {
    const user = await requireAdmin();
    const [backups, servers] = await Promise.all([listBackups(), listGameServerFacts(user.id).catch(() => [])]);

    return (
        // Narrow page: centre the column in the content area, header included.
        <div className="mx-auto flex w-full max-w-3xl flex-col">
            <PageHeader
                title="Backups"
                description="Back up and restore Polaris and your game worlds, with NAS and other apps to follow."
            />
            <BackupsView
                initialBackups={backups}
                servers={servers.map((server) => ({ id: server.id, name: server.name }))}
            />
        </div>
    );
}

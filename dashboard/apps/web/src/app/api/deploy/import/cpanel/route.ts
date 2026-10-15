/**
 * POST /api/deploy/import/cpanel - a cPanel full-account backup (`.tar.gz`), as a
 * new Deploy project with its sites, MySQL data and domains.
 *
 * The body is the archive itself, streamed to disk rather than read into memory,
 * at most `MAX_BACKUP_UPLOAD`. The project lands on the shelf that is open, which
 * takes being allowed to run that organization's services, exactly as creating a
 * project from the Deploy screen does. A backup refused for what it holds answers
 * 400 with the reason; anything else is logged here and answered generically.
 */

import { rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { apiPermission } from "@/lib/api-session";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { readerWords } from "@/lib/i18n/reader-words";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { requireOrgPermission } from "@/lib/orgs/org-service";
import { BackupRefusal } from "@/lib/deploy/panel-import/cpanel";
import { importCpanelBackup } from "@/lib/deploy/panel-import/import";
import { stageBody, stagedPath, TooLarge } from "@/lib/deploy/staging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The largest backup taken. */
const MAX_BACKUP_UPLOAD = 5 * 1024 ** 3;

export async function POST(request: Request): Promise<Response> {
    const user = await apiPermission("deploy.manage");
    if (user instanceof Response) return user;
    const words = await readerWords("deploySafety");
    const tooLarge = () => NextResponse.json({ error: words("importSite.tooLarge") }, { status: 413 });

    let orgId: string | null;
    try {
        orgId = await scopeOrgIdFor(user.id);
        if (orgId) await requireOrgPermission({ id: user.id, isAdmin: user.isAdmin }, orgId, "deploy.manage");
    } catch {
        return NextResponse.json({ error: words("importSite.notAllowed") }, { status: 403 });
    }
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BACKUP_UPLOAD) return tooLarge();

    const file = await stagedPath(".tar.gz");
    try {
        await stageBody(request.body, file, MAX_BACKUP_UPLOAD);
        const result = await importCpanelBackup({ archive: file, ownerId: user.id, orgId, actorId: user.id });
        await recordDeployAudit({
            actorId: user.id,
            orgId: orgId ?? undefined,
            action: "deploy.project.import",
            targetType: "project",
            targetId: result.projectId,
            metadata: { services: result.services, databases: result.databases, domains: result.domains.length }
        });
        return NextResponse.json(result);
    } catch (caught) {
        if (caught instanceof TooLarge) return tooLarge();
        // Worded for the sender; anything else names internals, so it stays in the log.
        if (caught instanceof BackupRefusal) return NextResponse.json({ error: caught.message }, { status: 400 });
        console.error("polaris: could not import a cPanel backup:", caught);
        return NextResponse.json({ error: words("importSite.failed") }, { status: 500 });
    } finally {
        await rm(file, { force: true });
    }
}

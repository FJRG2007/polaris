/**
 * POST /api/deploy/import/cpanel - a cPanel full-account backup (`.tar.gz`), as a
 * new Deploy project with its sites, MySQL data and domains.
 * GET - this person's imports of the last day, or one by `?id=`.
 *
 * The body is the archive itself, streamed to disk rather than read into memory,
 * at most `MAX_BACKUP_UPLOAD`. Once it is staged the import starts in the
 * background and the answer is its id (202); the import's own row carries its
 * progress and result (see `panel-import/jobs`). The project lands on the shelf
 * that is open, which takes being allowed to run that organization's services,
 * exactly as creating a project from the Deploy screen does.
 */

import { z } from "zod";
import { rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { apiPermission } from "@/lib/api-session";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { readerWords } from "@/lib/i18n/reader-words";
import { requireOrgPermission } from "@/lib/orgs/org-service";
import { stageBody, stagedPath, TooLarge } from "@/lib/deploy/staging";
import { getImport, ImportBusy, recentImports, startCpanelImport } from "@/lib/deploy/panel-import/jobs";

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
    let started = false;
    try {
        await stageBody(request.body, file, MAX_BACKUP_UPLOAD);
        const id = await startCpanelImport({ archive: file, ownerId: user.id, orgId, actorId: user.id });
        started = true;
        return NextResponse.json({ id }, { status: 202 });
    } catch (caught) {
        if (caught instanceof TooLarge) return tooLarge();
        if (caught instanceof ImportBusy) return NextResponse.json({ error: words("importSite.busy") }, { status: 409 });
        console.error("polaris: could not start a cPanel import:", caught);
        return NextResponse.json({ error: words("importSite.failed") }, { status: 500 });
    } finally {
        // Once started, the archive is the import's to remove.
        if (!started) await rm(file, { force: true });
    }
}

const querySchema = z.object({ id: z.string().uuid().optional() });

export async function GET(request: Request): Promise<Response> {
    const user = await apiPermission("deploy.manage");
    if (user instanceof Response) return user;
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return NextResponse.json({ error: "Invalid query" }, { status: 400 });
    if (!query.data.id) return NextResponse.json({ imports: await recentImports(user.id) });
    const found = await getImport(query.data.id, user.id);
    return found ? NextResponse.json(found) : NextResponse.json({ error: "Not found" }, { status: 404 });
}

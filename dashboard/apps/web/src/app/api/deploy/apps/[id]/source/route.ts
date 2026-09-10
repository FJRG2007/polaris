/**
 * POST /api/deploy/apps/:id/source - a folder, zipped, as the service's source.
 *
 * The body is the zip itself, streamed to disk rather than read into memory, at
 * most `MAX_SOURCE_ZIP`. `X-Polaris-Name` carries the folder's name, URI-encoded;
 * `?deploy=1` deploys what was uploaded straight away. Changing what a service is
 * built from is configuring it, so it asks for `service.configure`, and deploying
 * afterwards for `deploy.run` as well.
 */

import { rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { apiPermission } from "@/lib/api-session";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { deployApplication } from "@/lib/deploy-service";
import { requireApplicationAccess } from "@/lib/deploy-project-access";
import { stageBody, stagedPath, TooLarge } from "@/lib/deploy/staging";
import {
    MAX_SOURCE_ZIP,
    SourceRefusal,
    storeUploadedSource,
    type UploadedSource
} from "@/lib/deploy/source-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOO_LARGE = "The zip is larger than 200 MB.";

/** The folder's name as sent, decoded and bounded; a name that does not decode is
 *  no name. */
function folderName(header: string | null): string {
    if (!header) return "upload";
    try {
        return decodeURIComponent(header).replace(/[/\\]/g, "").trim().slice(0, 200) || "upload";
    } catch {
        return "upload";
    }
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiPermission("deploy.manage");
    if (user instanceof Response) return user;
    const { id } = await params;
    const deploy = new URL(request.url).searchParams.get("deploy") === "1";
    let ownerId: string;
    try {
        ownerId = (await requireApplicationAccess(id, user.id, "service.configure")).ownerId;
        if (deploy) await requireApplicationAccess(id, user.id, "deploy.run");
    } catch {
        return NextResponse.json({ error: "Service not found" }, { status: 404 });
    }
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_SOURCE_ZIP) {
        return NextResponse.json({ error: TOO_LARGE }, { status: 413 });
    }

    const file = await stagedPath(".zip");
    let upload: UploadedSource;
    try {
        await stageBody(request.body, file, MAX_SOURCE_ZIP);
        upload = await storeUploadedSource(
            id,
            ownerId,
            file,
            folderName(request.headers.get("x-polaris-name"))
        );
    } catch (caught) {
        if (caught instanceof TooLarge)
            return NextResponse.json({ error: TOO_LARGE }, { status: 413 });
        // Worded for the sender; anything else names internals, so it stays in the log.
        if (caught instanceof SourceRefusal)
            return NextResponse.json({ error: caught.message }, { status: 400 });
        console.error("polaris: could not take an uploaded source:", caught);
        return NextResponse.json(
            { error: "Could not take the upload. Try again." },
            { status: 500 }
        );
    } finally {
        await rm(file, { force: true });
    }
    await recordDeployAudit({
        actorId: user.id,
        action: "deploy.app.source.upload",
        targetType: "application",
        targetId: id,
        metadata: { files: upload.files, bytes: upload.bytes }
    });
    if (!deploy) return NextResponse.json({ upload });

    // The upload is kept either way; a deploy that will not start says why, the
    // way it does from the Deploy button.
    try {
        const deploymentId = await deployApplication(id, ownerId, user.id, { trigger: "upload" });
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.app.deploy",
            targetType: "application",
            targetId: id,
            metadata: { deploymentId }
        });
        return NextResponse.json({ upload, deploymentId });
    } catch (caught) {
        return NextResponse.json({
            upload,
            deployError: caught instanceof Error ? caught.message : "Could not deploy"
        });
    }
}

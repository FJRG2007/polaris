/**
 * File-request upload. Receives one file at a time into a drop point's
 * destination folder. The token in the URL is the credential; no session is
 * required unless the request demands login. Every limit is enforced here, in
 * order: the request exists and is usable (unexpired, unrevoked); the client IP
 * is allowed; login is satisfied when required; the total-file cap is not yet
 * met; the file's extension is permitted; and the byte size is capped mid-stream
 * so an oversized upload is aborted, never buffered. Node runtime for Prisma and
 * the drivers.
 */

import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { getSession } from "@/lib/session";
import { dymoIpAllowed } from "@/lib/dymo-service";
import { geoAllowedForIp } from "@/lib/geo-service";
import { scanDropPointUpload } from "@/lib/scan-service";
import * as fileRequests from "@/lib/file-request-service";
import { recordItemCreator } from "@/lib/drive-meta-service";
import { clientIp, hashForLog } from "@/lib/request-context";
import { getDriverForConnection } from "@/lib/storage-service";
import { extensionOf } from "@/app/(app)/drive/file-categories";
import { invalidateFolderSizes } from "@/lib/drive-folder-size";
import { claimUploadPath, replaceWithStaged } from "@/lib/upload-naming";
import { baseName, checkUploadCandidate, normalizeRelPath } from "@polaris/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Wrap a body stream so it errors once more than `max` bytes have been read. */
function limitSize(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
    let seen = 0;
    const reader = body.getReader();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
                controller.close();
                return;
            }
            seen += value.byteLength;
            if (seen > max) {
                await reader.cancel();
                controller.error(new Error("too_large"));
                return;
            }
            controller.enqueue(value);
        },
        async cancel(reason) {
            await reader.cancel(reason);
        }
    });
}

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const { token } = await params;
    const fileRequest = await fileRequests.resolveFileRequestByToken(token);
    if (!fileRequest) return new Response("Not found", { status: 404 });

    const usable = fileRequests.fileRequestUsability(fileRequest);
    // A not-yet-started drop point is a 403 (temporary); revoked/expired is a 410.
    if (!usable.ok) {
        return new Response(usable.reason, { status: usable.reason === "scheduled" ? 403 : 410 });
    }

    const ip = await clientIp();
    if (!fileRequests.fileRequestIpAllowed(fileRequest.allowedCidrs, ip)) {
        return new Response("ip_not_allowed", { status: 403 });
    }
    if (
        !(await geoAllowedForIp(
            ip,
            fileRequests.parseStringArray(fileRequest.allowedCountries),
            fileRequests.parseStringArray(fileRequest.allowedContinents)
        ))
    ) {
        return new Response("country_not_allowed", { status: 403 });
    }

    // Dymo IP-fraud gate (no-op unless the integration is enabled). Fails open.
    if (!(await dymoIpAllowed(ip)).allowed) return new Response("ip_flagged", { status: 403 });

    if (fileRequest.passwordHash) {
        const cookieValue = (await cookies()).get(fileRequests.fileRequestUnlockCookie(fileRequest.id))?.value;
        if (!fileRequests.verifyFileRequestUnlock(fileRequest.id, cookieValue, loadEnv().POLARIS_AUTH_SECRET)) {
            return new Response("pin_required", { status: 401 });
        }
    }

    const session = await getSession();
    const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
    if (fileRequest.requireLogin && !userId) return new Response("login_required", { status: 401 });
    // Per-user allowlist: a non-empty list requires sign-in and a matching account.
    if (!(await fileRequests.fileRequestUserAllowed(fileRequest.allowedUsers, userId))) {
        return new Response(userId ? "user_not_allowed" : "login_required", {
            status: userId ? 403 : 401
        });
    }

    if (
        fileRequest.maxFiles !== null &&
        (await fileRequests.countSubmissions(fileRequest.id)) >= fileRequest.maxFiles
    ) {
        return new Response("full", { status: 409 });
    }

    const rawName = new URL(request.url).searchParams.get("name");
    if (!rawName) return new Response("Missing name", { status: 400 });
    if (!request.body) return new Response("Empty body", { status: 400 });
    const safeName = baseName(normalizeRelPath(rawName));
    if (!safeName) return new Response("Invalid name", { status: 400 });

    const maxSizeBytes = Number(fileRequest.maxSizeBytes);
    const declaredSize = Number(request.headers.get("content-length") ?? "0");
    const candidate = {
        extension: extensionOf(safeName),
        mimeType: request.headers.get("content-type") ?? "application/octet-stream",
        size: declaredSize
    };
    // The minimum is enforced authoritatively on the stored size below, not here,
    // because content-length can be absent or wrong; this pass covers type and max.
    const check = checkUploadCandidate(candidate, {
        allowedExtensions: fileRequests.parseStringArray(fileRequest.allowedExtensions),
        deniedExtensions: fileRequests.parseStringArray(fileRequest.deniedExtensions),
        allowedMimeTypes: fileRequests.parseStringArray(fileRequest.allowedMimeTypes),
        maxSizeBytes
    });
    if (!check.ok) return new Response(check.reason ?? "rejected", { status: 422 });
    const minSizeBytes = fileRequest.minSizeBytes !== null ? Number(fileRequest.minSizeBytes) : 0;

    // The sender's filename is kept as it is: whoever collects these files has to
    // recognize what they were sent, and a document that arrives renamed is a
    // document somebody has to open to identify.
    const requested = normalizeRelPath(
        fileRequest.destinationPath ? `${fileRequest.destinationPath}/${safeName}` : safeName
    );

    const driver = await getDriverForConnection(fileRequest.destinationConnectionId);
    // The bytes always land on a name of this request's own, never straight onto an
    // existing file, because both gates below reject by deleting what they were
    // given - writing over the target first would let a rejected upload destroy the
    // document it was replacing. Where it finally belongs is settled after they pass.
    const staged = await claimUploadPath(driver, requested);
    const destination = fileRequest.allowOverwrite ? requested : staged;
    const storedName = baseName(destination);
    try {
        let stat;
        try {
            stat = await driver.writeStream(staged, limitSize(request.body, maxSizeBytes), {});
        } catch (error) {
            // An aborted oversize write leaves a truncated file behind, under a name
            // that reads as a complete document. Take the claim back with it.
            await driver.delete(staged).catch(() => undefined);
            throw error;
        }
        // Authoritative minimum-size gate on the bytes actually stored. A file below
        // the floor is removed so nothing is kept or recorded.
        if (minSizeBytes > 0 && Number(stat.size) < minSizeBytes) {
            await driver.delete(staged).catch(() => undefined);
            return new Response("too_small", { status: 422 });
        }

        // Recorded against the staged path, because the scan below is what decides
        // whether the file stays at all: blocking deletes it and quarantining moves
        // it, and both write that outcome onto this row.
        const submission = await fileRequests.recordSubmission({
            requestId: fileRequest.id,
            submittedByUserId: userId,
            ipHash: hashForLog(ip),
            fileName: storedName,
            size: stat.size,
            storedPath: staged
        });

        // Security scan (VirusTotal, when enabled). Runs on the staged file, before
        // it is in place, so the configured action - block by default - can be
        // enforced without the flagged bytes ever standing in for the real file.
        const scan = await scanDropPointUpload({
            driver,
            connectionId: fileRequest.destinationConnectionId,
            storedPath: staged,
            fileName: storedName,
            ownerId: fileRequest.ownerId,
            dropPointTitle: fileRequest.title,
            submissionId: submission.id,
            size: Number(stat.size)
        });
        if (scan.blocked) return new Response("file_rejected", { status: 422 });

        // Only a file the scan left where it put it can be moved into place; a
        // quarantined one has already been taken somewhere else on purpose.
        if (scan.action !== "quarantined") {
            await replaceWithStaged(driver, staged, destination);
            if (destination !== staged) {
                await fileRequests.setSubmissionPath(submission.id, destination);
            }
            // Owner of record: the signed-in uploader, or the drop point's owner who
            // collected it when the upload was anonymous.
            await recordItemCreator(
                fileRequest.destinationConnectionId,
                destination,
                userId ?? fileRequest.ownerId
            );
            await invalidateFolderSizes(fileRequest.destinationConnectionId, destination);
        }

        // Fold this upload into the browser's visitor session (the "uploaded?"
        // column), and hand back a per-file delete token so the uploader can
        // remove their own file later when the drop point allows it.
        const visitorKey = (await cookies()).get(fileRequests.fileRequestVisitCookie(fileRequest.id))?.value;
        if (visitorKey) await fileRequests.bumpVisitUpload(fileRequest.id, visitorKey);
        const deleteToken = fileRequests.signSubmissionDelete(submission.id, loadEnv().POLARIS_AUTH_SECRET);

        return Response.json({
            ok: true,
            id: submission.id,
            // The name the SENDER used, even when the file was stored under a
            // numbered one. Nobody uploading here can see the folder, so telling them
            // their name was taken tells them somebody else's file is in it.
            name: safeName,
            size: stat.size.toString(),
            deleteToken,
            ...(scan.scanned ? { scan: scan.verdict } : {})
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "upload_failed";
        // A mid-stream size abort surfaces as a 413 so the client can explain it.
        if (message === "too_large") return new Response("too_large", { status: 413 });
        // Anything else is the storage backend talking, and the person on the other
        // end of a drop point is a stranger: its message names hosts, paths and
        // providers they have no business seeing. It goes to the log instead.
        console.error("drop point: upload failed", error);
        return new Response("upload_failed", { status: 500 });
    } finally {
        await driver.dispose();
    }
}

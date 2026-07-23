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

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { baseName, checkUploadCandidate, normalizeRelPath } from "@polaris/core";
import { extensionOf } from "@/app/(app)/drive/file-categories";
import { getSession } from "@/lib/session";
import { getDriverForConnection } from "@/lib/storage-service";
import { recordItemCreator } from "@/lib/drive-meta-service";
import {
    bumpVisitUpload,
    countSubmissions,
    fileRequestIpAllowed,
    fileRequestUnlockCookie,
    fileRequestUsability,
    fileRequestUserAllowed,
    fileRequestVisitCookie,
    parseStringArray,
    recordSubmission,
    resolveFileRequestByToken,
    signSubmissionDelete,
    verifyFileRequestUnlock
} from "@/lib/file-request-service";
import { clientIp, hashForLog } from "@/lib/request-context";
import { geoAllowedForIp } from "@/lib/geo-service";
import { dymoIpAllowed } from "@/lib/dymo-service";
import { scanDropPointUpload } from "@/lib/scan-service";

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
    const fileRequest = await resolveFileRequestByToken(token);
    if (!fileRequest) return new Response("Not found", { status: 404 });

    const usable = fileRequestUsability(fileRequest);
    // A not-yet-started drop point is a 403 (temporary); revoked/expired is a 410.
    if (!usable.ok) {
        return new Response(usable.reason, { status: usable.reason === "scheduled" ? 403 : 410 });
    }

    const ip = await clientIp();
    if (!fileRequestIpAllowed(fileRequest.allowedCidrs, ip)) {
        return new Response("ip_not_allowed", { status: 403 });
    }
    if (
        !(await geoAllowedForIp(
            ip,
            parseStringArray(fileRequest.allowedCountries),
            parseStringArray(fileRequest.allowedContinents)
        ))
    ) {
        return new Response("country_not_allowed", { status: 403 });
    }

    // Dymo IP-fraud gate (no-op unless the integration is enabled). Fails open.
    if (!(await dymoIpAllowed(ip)).allowed) return new Response("ip_flagged", { status: 403 });

    if (fileRequest.passwordHash) {
        const cookieValue = (await cookies()).get(fileRequestUnlockCookie(fileRequest.id))?.value;
        if (!verifyFileRequestUnlock(fileRequest.id, cookieValue, loadEnv().POLARIS_AUTH_SECRET)) {
            return new Response("pin_required", { status: 401 });
        }
    }

    const session = await getSession();
    const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
    if (fileRequest.requireLogin && !userId) return new Response("login_required", { status: 401 });
    // Per-user allowlist: a non-empty list requires sign-in and a matching account.
    if (!(await fileRequestUserAllowed(fileRequest.allowedUsers, userId))) {
        return new Response(userId ? "user_not_allowed" : "login_required", {
            status: userId ? 403 : 401
        });
    }

    if (
        fileRequest.maxFiles !== null &&
        (await countSubmissions(fileRequest.id)) >= fileRequest.maxFiles
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
        allowedExtensions: parseStringArray(fileRequest.allowedExtensions),
        deniedExtensions: parseStringArray(fileRequest.deniedExtensions),
        allowedMimeTypes: parseStringArray(fileRequest.allowedMimeTypes),
        maxSizeBytes
    });
    if (!check.ok) return new Response(check.reason ?? "rejected", { status: 422 });
    const minSizeBytes = fileRequest.minSizeBytes !== null ? Number(fileRequest.minSizeBytes) : 0;

    // Store under a random prefix so uploaders cannot overwrite each other's files
    // or guess a path; the original name is kept in the submission record for the
    // owner to see.
    const storedName = `${randomBytes(6).toString("hex")}-${safeName}`;
    const destination = normalizeRelPath(
        fileRequest.destinationPath ? `${fileRequest.destinationPath}/${storedName}` : storedName
    );

    const driver = await getDriverForConnection(fileRequest.destinationConnectionId);
    try {
        const stat = await driver.writeStream(
            destination,
            limitSize(request.body, maxSizeBytes),
            {}
        );
        // Authoritative minimum-size gate on the bytes actually stored. A file below
        // the floor is removed so nothing is kept or recorded.
        if (minSizeBytes > 0 && Number(stat.size) < minSizeBytes) {
            await driver.delete(destination).catch(() => undefined);
            return new Response("too_small", { status: 422 });
        }
        const submission = await recordSubmission({
            requestId: fileRequest.id,
            submittedByUserId: userId,
            ipHash: hashForLog(ip),
            fileName: safeName,
            size: stat.size,
            storedPath: destination
        });
        // Owner of record: the signed-in uploader, or the drop point's owner who
        // collected it when the upload was anonymous.
        await recordItemCreator(
            fileRequest.destinationConnectionId,
            destination,
            userId ?? fileRequest.ownerId
        );

        // Security scan (VirusTotal, when enabled). Runs before acknowledging the
        // upload so the configured action - block by default - can be enforced on a
        // flagged file. The drop point's owner is alerted with the verdict.
        const scan = await scanDropPointUpload({
            driver,
            connectionId: fileRequest.destinationConnectionId,
            storedPath: destination,
            fileName: safeName,
            ownerId: fileRequest.ownerId,
            dropPointTitle: fileRequest.title,
            submissionId: submission.id,
            size: Number(stat.size)
        });
        if (scan.blocked) return new Response("file_rejected", { status: 422 });

        // Fold this upload into the browser's visitor session (the "uploaded?"
        // column), and hand back a per-file delete token so the uploader can
        // remove their own file later when the drop point allows it.
        const visitorKey = (await cookies()).get(fileRequestVisitCookie(fileRequest.id))?.value;
        if (visitorKey) await bumpVisitUpload(fileRequest.id, visitorKey);
        const deleteToken = signSubmissionDelete(submission.id, loadEnv().POLARIS_AUTH_SECRET);

        return Response.json({
            ok: true,
            id: submission.id,
            name: safeName,
            size: stat.size.toString(),
            deleteToken,
            ...(scan.scanned ? { scan: scan.verdict } : {})
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "upload_failed";
        // A mid-stream size abort surfaces as a 413 so the client can explain it.
        return new Response(message, { status: message === "too_large" ? 413 : 500 });
    } finally {
        await driver.dispose();
    }
}

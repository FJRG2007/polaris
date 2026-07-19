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
import { baseName, checkUploadCandidate, normalizeRelPath } from "@polaris/core";
import { extensionOf } from "@/app/(app)/drive/file-categories";
import { getSession } from "@/lib/session";
import { getDriverForConnection } from "@/lib/storage-service";
import {
    countSubmissions,
    fileRequestIpAllowed,
    fileRequestUsability,
    parseStringArray,
    recordSubmission,
    resolveFileRequestByToken
} from "@/lib/file-request-service";
import { clientIp, hashForLog } from "@/lib/request-context";

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
    if (!usable.ok) return new Response(usable.reason, { status: 410 });

    const ip = await clientIp();
    if (!fileRequestIpAllowed(fileRequest.allowedCidrs, ip)) {
        return new Response("ip_not_allowed", { status: 403 });
    }

    const session = await getSession();
    const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
    if (fileRequest.requireLogin && !userId) return new Response("login_required", { status: 401 });

    if (fileRequest.maxFiles !== null && (await countSubmissions(fileRequest.id)) >= fileRequest.maxFiles) {
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
    const check = checkUploadCandidate(candidate, {
        allowedExtensions: parseStringArray(fileRequest.allowedExtensions),
        allowedMimeTypes: parseStringArray(fileRequest.allowedMimeTypes),
        maxSizeBytes
    });
    if (!check.ok) return new Response(check.reason ?? "rejected", { status: 422 });

    // Store under a random prefix so uploaders cannot overwrite each other's files
    // or guess a path; the original name is kept in the submission record for the
    // owner to see.
    const storedName = `${randomBytes(6).toString("hex")}-${safeName}`;
    const destination = normalizeRelPath(
        fileRequest.destinationPath ? `${fileRequest.destinationPath}/${storedName}` : storedName
    );

    const driver = await getDriverForConnection(fileRequest.destinationConnectionId);
    try {
        const stat = await driver.writeStream(destination, limitSize(request.body, maxSizeBytes), {});
        await recordSubmission({
            requestId: fileRequest.id,
            submittedByUserId: userId,
            ipHash: hashForLog(ip),
            fileName: safeName,
            size: stat.size,
            storedPath: destination
        });
        return Response.json({ ok: true, name: safeName, size: stat.size.toString() });
    } catch (error) {
        const message = error instanceof Error ? error.message : "upload_failed";
        // A mid-stream size abort surfaces as a 413 so the client can explain it.
        return new Response(message, { status: message === "too_large" ? 413 : 500 });
    } finally {
        await driver.dispose();
    }
}

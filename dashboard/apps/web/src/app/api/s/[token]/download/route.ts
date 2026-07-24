/**
 * Public share download. Serves bytes for a share link with no session: the
 * token is the credential. Enforced on every hit, in order: the share exists and
 * is usable (unexpired, unrevoked, under its cap); the password gate is satisfied
 * (unlock cookie); the requested path stays inside the shared subtree; and the
 * download is counted atomically so a cap can never be exceeded under concurrency.
 * Node runtime because Prisma and the drivers need it.
 */

import { headers } from "next/headers";
import { baseName } from "@polaris/core";
import { getDriverForConnection } from "@/lib/storage-service";
import { mimeForName } from "@/lib/mime";
import {
    logShareAccess,
    registerDownload,
    resolveWithinShare
} from "@/lib/share-service";
import { gateShareRequest } from "@/lib/share-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGE = /^bytes=(\d+)-(\d*)$/;

export async function GET(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const { token } = await params;
    const gate = await gateShareRequest(token, "download");
    if (!gate.ok) return new Response(gate.reason, { status: gate.status });

    const { share, ip, ipHash, userAgentHash } = gate;
    const deny = (status: number, reason: string) => {
        void logShareAccess({ shareId: share.id, action: "download", reason, ip, ipHash, userAgentHash });
        return new Response(reason, { status });
    };

    // An inline request is a browser preview; an attachment request is a download.
    // Each is gated by its own permission so a share can allow one without the other.
    const inline = new URL(request.url).searchParams.get("disposition") === "inline";
    if (inline && !share.allowPreview) return deny(403, "preview_disabled");
    if (!inline && !share.allowDownload) return deny(403, "downloads_disabled");

    const requested = new URL(request.url).searchParams.get("p");
    const target = resolveWithinShare(share.path, requested);
    if (target === null) return deny(400, "path_outside_share");

    const driver = await getDriverForConnection(share.connectionId);
    let disposed = false;
    try {
        const stat = await driver.stat(target);
        if (stat.kind !== "file") return deny(400, "not_a_file");

        // Count the download atomically before streaming; if the cap was hit by a
        // concurrent request this returns false and we serve nothing.
        if (!(await registerDownload(share.id))) return deny(410, "exhausted");

        await logShareAccess({ shareId: share.id, action: "download", ip, ipHash, userAgentHash });

        const headerStore = await headers();
        const responseHeaders = new Headers({
            "content-type": stat.mime ?? mimeForName(baseName(target)) ?? "application/octet-stream",
            "accept-ranges": "bytes",
            "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(baseName(target))}`
        });

        const rangeHeader = headerStore.get("range");
        const match = rangeHeader ? RANGE.exec(rangeHeader) : null;
        if (match && driver.capabilities.randomRead) {
            const start = Number(match[1]);
            const end = match[2] ? Number(match[2]) : Number(stat.size) - 1;
            const stream = await driver.readStream(target, { start, end });
            responseHeaders.set("content-range", `bytes ${start}-${end}/${stat.size}`);
            responseHeaders.set("content-length", String(end - start + 1));
            // The stream owns the driver's lifetime now; dispose when it ends.
            disposed = true;
            return new Response(pipeThenDispose(stream, driver), { status: 206, headers: responseHeaders });
        }

        const stream = await driver.readStream(target);
        responseHeaders.set("content-length", stat.size.toString());
        disposed = true;
        return new Response(pipeThenDispose(stream, driver), { status: 200, headers: responseHeaders });
    } catch {
        return deny(500, "read_failed");
    } finally {
        if (!disposed) await driver.dispose();
    }
}

/** Wrap a body stream so the driver is disposed once the response finishes. */
function pipeThenDispose(
    stream: ReadableStream<Uint8Array>,
    driver: { dispose(): Promise<void> }
): ReadableStream<Uint8Array> {
    const reader = stream.getReader();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
                controller.close();
                await driver.dispose();
                return;
            }
            controller.enqueue(value);
        },
        async cancel(reason) {
            await reader.cancel(reason);
            await driver.dispose();
        }
    });
}

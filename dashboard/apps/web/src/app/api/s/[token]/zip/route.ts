/**
 * Public share ZIP. Bundles several items (files and/or whole folders) from a
 * folder share into one streaming archive, with one `p` per selected path. The
 * token is the credential, gated exactly like the download route, and the share
 * must allow downloads. Every requested path is resolved within the shared subtree
 * so a request can never escape it, and Polaris's reserved folders are skipped.
 * The bundle counts as a single download against any cap. Node runtime for the
 * driver.
 */

import { baseName } from "@polaris/core";
import { getDriverForConnection } from "@/lib/storage-service";
import { logShareAccess, registerDownload, resolveWithinShare } from "@/lib/share-service";
import { gateShareRequest } from "@/lib/share-access";
import { createZipStream, type ZipSource } from "@/lib/zip-stream";
import { zipSourcesFor } from "@/lib/drive-archive";
import type { StorageDriver } from "@polaris/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Turn a filename into a safe ASCII fallback for the Content-Disposition header. */
function asciiFallback(name: string): string {
    return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const { token } = await params;
    const gate = await gateShareRequest(token, "download");
    if (!gate.ok) return new Response(gate.reason, { status: gate.status });

    const { share, ip, ipHash, userAgentHash } = gate;
    if (!share.allowDownload) return new Response("downloads_disabled", { status: 403 });

    // Resolve every requested path inside the shared subtree; reject any escape.
    const requested = new URL(request.url).searchParams.getAll("p");
    const paths: string[] = [];
    for (const raw of requested.length > 0 ? requested : [null]) {
        const resolved = resolveWithinShare(share.path, raw);
        if (resolved === null) return new Response("path_outside_share", { status: 400 });
        if (resolved.length > 0) paths.push(resolved);
    }
    if (paths.length === 0) return new Response("nothing_to_download", { status: 400 });

    // Count the archive as one download before streaming; a concurrent request
    // that just hit the cap returns false and we serve nothing.
    if (!(await registerDownload(share.id))) return new Response("exhausted", { status: 410 });
    void logShareAccess({ shareId: share.id, action: "download", ip, ipHash, userAgentHash });

    let driver: StorageDriver;
    try {
        driver = await getDriverForConnection(share.connectionId);
    } catch {
        return new Response("connect_failed", { status: 502 });
    }

    // The share itself is the authorization for its whole subtree (the single-file
    // download route serves any file within it), so no per-path lock is enforced;
    // reserved folders are still skipped by the walker.
    async function* sources(): AsyncGenerator<ZipSource> {
        try {
            yield* zipSourcesFor(driver, paths, new Set());
        } finally {
            await driver.dispose();
        }
    }

    const archiveName =
        paths.length === 1 && paths[0]
            ? `${baseName(paths[0])}.zip`
            : `${share.connection.name || "polaris"}-files.zip`;
    return new Response(createZipStream(sources()), {
        status: 200,
        headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${asciiFallback(archiveName)}"; filename*=UTF-8''${encodeURIComponent(archiveName)}`,
            "cache-control": "no-store"
        }
    });
}

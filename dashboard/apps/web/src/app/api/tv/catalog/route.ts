/**
 * GET /api/tv/catalog[?name=<file>] - the Themes & add-ons catalog of the newest
 * TV release, and each file it lists, served from this instance so a TV with no
 * route to GitHub can still browse and install them.
 *
 * Without `name` it is `catalog.json`; with one it is that file
 * (`theme-<id>.zip|jpg`, `addon-<id>.apk|jpg`). Every file is downloaded once,
 * checked against the release's SHA256SUMS and its size cap, and kept on the
 * instance. 404 for a name that is not a catalog file or one the release does
 * not carry (including a release from before the catalog), 204 when no TV build
 * is released, 502 when it could not be fetched or did not match its checksum.
 */

import { tvCaller } from "@/lib/tv/auth";
import { servedFile } from "@/lib/tv/served-file";
import { readerWords } from "@/lib/i18n/reader-words";
import { withKeyUsage } from "@/lib/api-usage/recorder";
import {
    catalogFileName,
    preparedTvCatalogFile,
    tvReleaseInfo,
    TV_CATALOG_NAME,
    TvReleaseError
} from "@/lib/tv/release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function contentType(name: string): string {
    if (name.endsWith(".json")) return "application/json";
    if (name.endsWith(".apk")) return "application/vnd.android.package-archive";
    if (name.endsWith(".zip")) return "application/zip";
    return "image/jpeg";
}

export const GET = withKeyUsage(async (request: Request): Promise<Response> => {
    const caller = await tvCaller(request);
    if (caller instanceof Response) return caller;
    const name = new URL(request.url).searchParams.get("name") ?? TV_CATALOG_NAME;
    const t = await readerWords("api");
    const missing = Response.json(
        { error: t("errors.tvCatalogMissing") },
        { status: 404, headers: NO_STORE }
    );
    if (!catalogFileName(name)) return missing;
    try {
        const file = await preparedTvCatalogFile(name);
        if (!file) {
            const released = await tvReleaseInfo();
            if (!released) return new Response(null, { status: 204, headers: NO_STORE });
            return missing;
        }
        const response = servedFile(request, {
            path: file.path,
            size: file.size,
            sha256: file.sha256,
            contentType: contentType(name),
            fileName: name
        });
        response.headers.set("x-polaris-tv-release", file.versionName);
        return response;
    } catch (caught) {
        const reason = caught instanceof TvReleaseError ? caught.reason : "unreachable";
        return Response.json(
            {
                error: t(
                    reason === "mismatch" ? "errors.tvUpdateMismatch" : "errors.tvUpdateUnavailable"
                ),
                reason
            },
            { status: 502, headers: NO_STORE }
        );
    }
});

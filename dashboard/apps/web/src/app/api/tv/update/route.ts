/**
 * GET /api/tv/update?edition=<home-key> - the newest Polaris TV build this
 * instance can hand a TV, of the edition the TV runs (the ordinary one when it
 * names none). The answer names the edition, so a TV can refuse another one.
 *
 * 200 with what to install and where to fetch it from this instance, 204 when no
 * TV build is released, 502 when one is but could not be fetched or did not match
 * its published checksum. The APK is downloaded and verified here before this
 * answers, so the `url` it names is ready.
 */

import { tvCaller } from "@/lib/tv/auth";
import { readerWords } from "@/lib/i18n/reader-words";
import { withKeyUsage } from "@/lib/api-usage/recorder";
import { editionOf, preparedTvApk, TvReleaseError } from "@/lib/tv/release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withKeyUsage(async (request: Request): Promise<Response> => {
    const caller = await tvCaller(request);
    if (caller instanceof Response) return caller;
    const edition = editionOf(request);
    // A TV naming an edition this instance does not publish has nothing it may install.
    if (!edition) return new Response(null, { status: 204 });
    try {
        const apk = await preparedTvApk(edition);
        if (!apk) return new Response(null, { status: 204 });
        const query = new URLSearchParams({ version: apk.versionName });
        if (edition !== "standard") query.set("edition", edition);
        return Response.json(
            {
                versionName: apk.versionName,
                // The release does not publish Android's build number.
                versionCode: null,
                size: apk.size,
                sha256: apk.sha256,
                edition,
                url: `/api/tv/update/apk?${query}`
            },
            { headers: { "cache-control": "no-store" } }
        );
    } catch (caught) {
        const t = await readerWords("api");
        const reason = caught instanceof TvReleaseError ? caught.reason : "unreachable";
        return Response.json(
            {
                error: t(
                    reason === "mismatch" ? "errors.tvUpdateMismatch" : "errors.tvUpdateUnavailable"
                ),
                reason
            },
            { status: 502, headers: { "cache-control": "no-store" } }
        );
    }
});

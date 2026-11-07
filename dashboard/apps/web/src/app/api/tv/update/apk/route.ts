/**
 * GET /api/tv/update/apk?version=<versionName> - the verified APK, streamed from
 * this instance. Honours a single `Range: bytes=` so an interrupted download on a
 * TV resumes. 409 when the version asked for is no longer the newest (ask
 * /api/tv/update again).
 */

import { tvCaller } from "@/lib/tv/auth";
import { servedFile } from "@/lib/tv/served-file";
import { preparedTvApk } from "@/lib/tv/release";
import { readerWords } from "@/lib/i18n/reader-words";
import { withKeyUsage } from "@/lib/api-usage/recorder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withKeyUsage(async (request: Request): Promise<Response> => {
    const caller = await tvCaller(request);
    if (caller instanceof Response) return caller;
    const t = await readerWords("api");
    const apk = await preparedTvApk().catch(() => null);
    if (!apk) {
        return Response.json({ error: t("errors.tvUpdateUnavailable") }, { status: 503 });
    }
    const asked = new URL(request.url).searchParams.get("version");
    if (asked !== null && asked !== apk.versionName) {
        return Response.json({ error: t("errors.tvUpdateMoved") }, { status: 409 });
    }
    return servedFile(request, {
        path: apk.path,
        size: apk.size,
        sha256: apk.sha256,
        contentType: "application/vnd.android.package-archive",
        fileName: "polaris-tv.apk"
    });
});

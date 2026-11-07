/**
 * POST /api/tv/update/report - a TV saying how an update it was asked for is
 * going. 204 when recorded; 404 when the id is not the TV's current request or it
 * already finished (the TV drops it); 400 for a body that is not a report.
 */

import { tvCaller } from "@/lib/tv/auth";
import { readerWords } from "@/lib/i18n/reader-words";
import { withKeyUsage } from "@/lib/api-usage/recorder";
import { reportTvUpdate, tvUpdateReportSchema } from "@/lib/tv/update-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withKeyUsage(async (request: Request): Promise<Response> => {
    const caller = await tvCaller(request);
    if (caller instanceof Response) return caller;
    const t = await readerWords("api");
    const report = tvUpdateReportSchema.safeParse(await request.json().catch(() => null));
    if (!report.success) {
        return Response.json({ error: t("errors.tvUpdateReport") }, { status: 400 });
    }
    const recorded = await reportTvUpdate(caller.keyId, report.data);
    if (!recorded) return Response.json({ error: t("errors.tvUpdateStale") }, { status: 404 });
    return new Response(null, { status: 204 });
});

import { apiPermission } from "@/lib/api-session";
import { hostSubject } from "@/lib/metrics-shared";
import { readerWords } from "@/lib/i18n/reader-words";
import { hostsBelongToOwner } from "@/lib/metrics-history-service";
import { readServerInsights } from "@/lib/server-insights/insights";
import { INSIGHTS_MAX, serverIdsSchema } from "@/lib/server-insights/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What was unusual on each named server lately, and when its disk fills
 *  (?ids=local,<host id>,...). Only servers the reader owns are answered for:
 *  one that is not theirs is a 404 for the whole request, not a silent gap. */
export async function GET(request: Request): Promise<Response> {
    const user = await apiPermission("system.manage");
    if (user instanceof Response) return user;
    const t = await readerWords("api");
    const ids = serverIdsSchema(INSIGHTS_MAX).safeParse(
        new URL(request.url).searchParams.get("ids") ?? ""
    );
    if (!ids.success) return Response.json({ error: t("errors.invalidRequest") }, { status: 400 });
    const subjects = ids.data.map(hostSubject);
    if (!(await hostsBelongToOwner(subjects, user.id)))
        return Response.json({ error: t("errors.notFound") }, { status: 404 });
    const insights = await readServerInsights(subjects);
    return Response.json({
        servers: insights.map((insight, index) => ({ ...insight, id: ids.data[index]! }))
    });
}

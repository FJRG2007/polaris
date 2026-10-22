/**
 * The access log of one thing that can be lent: every use of its grants, done
 * or refused, newest first. Read by whoever may share it - the same standing
 * the share dialog asks - and nobody else.
 *
 *   GET ?subject&subjectId[&grant][&outcome][&from][&to][&format=csv]
 *     -> { uses } | text/csv
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { apiUser } from "@/lib/api-session";
import { downloadTicketHeaders } from "@/lib/download-ticket";
import { requireMayShare } from "@/lib/access/sharing-service";
import { usesCsv } from "@/lib/access/grant-use-csv";
import { GRANT_USE_OUTCOMES, listGrantUses } from "@/lib/access/grants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rows on screen, and in one export. */
const SCREEN_ROWS = 200;
const EXPORT_ROWS = 10_000;

const querySchema = z.object({
    subject: z.enum(core.GRANT_SUBJECTS),
    subjectId: z.string().uuid(),
    grant: z.string().uuid().optional(),
    outcome: z.enum(GRANT_USE_OUTCOMES).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    format: z.enum(["json", "csv"]).default("json")
});

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return Response.json({ error: "badQuery" }, { status: 400 });
    const { subject, subjectId, grant, outcome, from, to, format } = query.data;
    try {
        await requireMayShare(user, subject, subjectId);
    } catch {
        return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const uses = await listGrantUses({
        subjectType: subject,
        subjectId,
        grantId: grant,
        outcome,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        take: format === "csv" ? EXPORT_ROWS : SCREEN_ROWS
    });
    if (format === "csv") {
        return new Response(usesCsv(uses), {
            headers: {
                "content-type": "text/csv; charset=utf-8",
                "content-disposition": `attachment; filename="access-log-${subjectId}.csv"`,
                "cache-control": "no-store",
                ...downloadTicketHeaders(request)
            }
        });
    }
    return Response.json({ uses }, { headers: { "cache-control": "no-store" } });
}

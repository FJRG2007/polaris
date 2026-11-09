/**
 * A site's recorded events over a range, as CSV: every page and event with the
 * visit it belongs to, narrowed by the same filters as the screen.
 *
 * Streamed in pages keyed on the event id (time-ordered), so a month of a busy
 * site never sits in memory at once, and capped so one press cannot run for an
 * hour. Reading it takes the same `view` access as reading the screen.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { userHasManage } from "@/lib/session";
import { csvCell } from "@/lib/access/grant-use-csv";
import { sessionWhere } from "@/lib/analytics-reports";
import { downloadTicketHeaders } from "@/lib/download-ticket";
import { siteAccess } from "@/app/(app)/apps/analytics/site-access";
import { requireAnalyticsReader } from "@/app/(app)/apps/analytics/reader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = 2000;
const CAP = 500_000;

const querySchema = z.object({
    scopeType: z.enum(["application", "polaris"]),
    scopeId: z.string().max(64),
    range: core.visitRangeSchema,
    filters: z.string().max(4000).optional()
});

const HEADER = [
    "at",
    "visit",
    "kind",
    "event",
    "path",
    "url",
    "properties",
    "visitor",
    "browser",
    "os",
    "device",
    "country",
    "language",
    "screen",
    "channel",
    "referrer",
    "campaign",
    "medium"
];

export async function GET(request: Request): Promise<Response> {
    const { user } = await requireAnalyticsReader();
    const { dl: _ticket, ...fields } = Object.fromEntries(new URL(request.url).searchParams);
    const query = querySchema.safeParse(fields);
    // i18n-ignore: status bodies no screen shows
    if (!query.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
    const isOperator = await userHasManage(user, "system.manage");
    const access = await siteAccess(user.id, isOperator, query.data.scopeType, query.data.scopeId);
    // i18n-ignore: status bodies no screen shows
    if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const filters = core.parseVisitFilters(query.data.filters);
    const to = Date.now();
    const from = to - core.VISIT_RANGE_SPEC[query.data.range].ms;
    const where = {
        siteId: access.site.id,
        at: { gte: new Date(from), lt: new Date(to) },
        ...(filters.length ? { session: { is: sessionWhere(filters) } } : {})
    };

    async function* rows(): AsyncGenerator<string> {
        yield `${HEADER.join(",")}\n`;
        let cursor: string | null = null;
        let sent = 0;
        while (sent < CAP) {
            const page: Awaited<ReturnType<typeof readPage>> = await readPage(cursor);
            if (page.length === 0) return;
            let chunk = "";
            for (const event of page) {
                const session = event.session;
                chunk += `${[
                    event.at.toISOString(),
                    event.sessionId,
                    event.kind,
                    event.name ?? "",
                    event.path,
                    event.rawPath ?? event.path,
                    event.props ?? "",
                    session.distinctId ?? "",
                    session.browser,
                    session.os,
                    session.device,
                    session.country ?? "",
                    session.language ?? "",
                    session.screen ?? "",
                    session.referrerKind,
                    session.referrerSource ?? "",
                    session.campaign ?? "",
                    session.medium ?? ""
                ]
                    .map(csvCell)
                    .join(",")}\n`;
            }
            yield chunk;
            sent += page.length;
            cursor = page[page.length - 1]!.id;
            if (page.length < PAGE) return;
        }
    }

    function readPage(after: string | null) {
        return prisma.analyticsEvent.findMany({
            where: after ? { ...where, id: { gt: after } } : where,
            orderBy: { id: "asc" },
            take: PAGE,
            select: {
                id: true,
                at: true,
                sessionId: true,
                kind: true,
                name: true,
                path: true,
                rawPath: true,
                props: true,
                session: {
                    select: {
                        distinctId: true,
                        browser: true,
                        os: true,
                        device: true,
                        country: true,
                        language: true,
                        screen: true,
                        referrerKind: true,
                        referrerSource: true,
                        campaign: true,
                        medium: true
                    }
                }
            }
        });
    }

    const body = Readable.toWeb(Readable.from(rows(), { objectMode: false })) as ReadableStream<Uint8Array>;
    const stem = access.site.name.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 60) || "site";
    return new Response(body, {
        headers: {
            ...downloadTicketHeaders(request),
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${stem}-${query.data.range}.csv"`,
            "cache-control": "no-store"
        }
    });
}

/**
 * A site's recorded events over a range, as CSV, JSON or a spreadsheet: every
 * page and event with the visit it belongs to, narrowed by the same filters as
 * the screen. The report-style PDF is a page of its own (`/analytics/report`),
 * since a summary is what goes on paper, not half a million rows.
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
import * as exporting from "@/lib/analytics-export";
import { sessionWhere } from "@/lib/analytics-reports";
import { downloadTicketHeaders } from "@/lib/download-ticket";
import { siteAccess } from "@/app/(app)/analytics/site-access";
import { requireAnalyticsReader } from "@/app/(app)/analytics/reader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = 2000;
const CAP = 500_000;
/** A workbook is built whole in memory, so it stops well short of the others. */
const XLSX_CAP = 100_000;

const querySchema = z.object({
    scopeType: z.enum(["application", "polaris", "external"]),
    scopeId: z.string().max(64),
    range: core.visitRangeSchema,
    filters: z.string().max(4000).optional(),
    format: z.enum(exporting.EXPORT_FORMATS).default("csv")
});

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

    const format = query.data.format;
    const cap = format === "xlsx" ? XLSX_CAP : CAP;

    async function* events(): AsyncGenerator<exporting.ExportEvent[]> {
        let cursor: string | null = null;
        let sent = 0;
        while (sent < cap) {
            const page: Awaited<ReturnType<typeof readPage>> = await readPage(cursor, Math.min(PAGE, cap - sent));
            if (page.length === 0) return;
            yield page;
            sent += page.length;
            cursor = page[page.length - 1]!.id;
            if (page.length < PAGE) return;
        }
    }

    async function* csv(): AsyncGenerator<string> {
        yield exporting.csvLine(exporting.EXPORT_COLUMNS);
        for await (const page of events()) yield page.map((event) => exporting.csvLine(exporting.exportCells(event))).join("");
    }

    async function* json(): AsyncGenerator<string> {
        yield "[";
        let first = true;
        for await (const page of events()) {
            let chunk = "";
            for (const event of page) {
                chunk += `${first ? "\n" : ",\n"}${JSON.stringify(exporting.exportRecord(event))}`;
                first = false;
            }
            yield chunk;
        }
        yield first ? "]\n" : "\n]\n";
    }

    function readPage(after: string | null, take: number) {
        return prisma.analyticsEvent.findMany({
            where: after ? { ...where, id: { gt: after } } : where,
            orderBy: { id: "asc" },
            take,
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

    const stem = access.site.name.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 60) || "site";
    const headers = {
        ...downloadTicketHeaders(request),
        "content-type": exporting.EXPORT_CONTENT_TYPE[format],
        "content-disposition": `attachment; filename="${stem}-${query.data.range}.${format}"`,
        "cache-control": "no-store"
    };

    if (format === "xlsx") {
        const XLSX = await import("xlsx");
        const rows: string[][] = [[...exporting.EXPORT_COLUMNS]];
        for await (const page of events()) for (const event of page) rows.push(exporting.xlsxCells(event));
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Events");
        const file = XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
        return new Response(new Uint8Array(file), { headers });
    }

    const body = Readable.toWeb(
        Readable.from(format === "json" ? json() : csv(), { objectMode: false })
    ) as ReadableStream<Uint8Array>;
    return new Response(body, { headers });
}

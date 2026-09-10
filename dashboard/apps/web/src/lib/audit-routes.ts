/**
 * The HTTP half of reading the audit trail, shared by the three routes that do.
 *
 * Each route authorizes its caller and decides the scope - everything, one
 * organization, one person - and hands both to these two functions, which parse
 * the narrowing, answer a page or stream an export, and write down that an export
 * happened. Kept here so the three cannot drift into parsing a date three ways or
 * forgetting, on one of them, to record who took a copy of the trail.
 *
 * Server-only.
 */

import * as core from "@polaris/core";
import { NextResponse } from "next/server";
import * as audit from "@/lib/audit-query";
import { recordAudit } from "@/lib/audit-service";

/** The query string as an object, for the schema. */
function params(request: Request): Record<string, string> {
    return Object.fromEntries(new URL(request.url).searchParams);
}

function refused(error: { issues: { message: string }[] }): Response {
    return NextResponse.json({ error: error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
}

/**
 * One page of the trail, newest first.
 *
 * The first page carries the facets as well - who, which areas, which kinds of
 * thing appear in this scope - so the filters can offer only what is there; the
 * pages after it do not repeat them.
 */
export async function auditPageResponse(request: Request, scope: audit.AuditScope): Promise<Response> {
    const parsed = core.auditFilterSchema.safeParse(params(request));
    if (!parsed.success) return refused(parsed.error);
    const [page, facets] = await Promise.all([
        audit.queryAudit(scope, parsed.data),
        parsed.data.cursor ? Promise.resolve(undefined) : audit.auditFacets(scope)
    ]);
    return NextResponse.json({ ...page, ...(facets ? { facets } : {}) });
}

/**
 * The whole narrowing as a file.
 *
 * Taking a copy of the audit trail is itself something the trail records: who
 * took it, of what, and narrowed how. For an organization's history the entry
 * names the organization, so its own Activity screen shows the export too.
 */
export async function auditExportResponse(
    request: Request,
    scope: audit.AuditScope,
    options: { label: string; actorId: string; orgId?: string }
): Promise<Response> {
    const parsed = core.auditExportSchema.safeParse(params(request));
    if (!parsed.success) return refused(parsed.error);
    const { format, ...filter } = parsed.data;
    const total = await audit.auditExportCount(scope, filter);
    const truncated = total > audit.AUDIT_EXPORT_MAX;

    await recordAudit({
        actorId: options.actorId,
        orgId: options.orgId,
        action: "audit.export",
        metadata: {
            scope: scope.kind,
            format,
            entries: Math.min(total, audit.AUDIT_EXPORT_MAX),
            ...(filter.actor ? { actor: filter.actor } : {}),
            ...(filter.area ? { area: filter.area } : {}),
            ...(filter.resource ? { resource: filter.resource } : {}),
            ...(filter.from ? { from: filter.from.toISOString() } : {}),
            ...(filter.to ? { to: filter.to.toISOString() } : {})
        }
    });

    const name = audit.auditExportFilename(options.label, format);
    const body = audit.streamAuditExport(scope, filter, format, {
        scope: scope.kind,
        total,
        truncated
    });
    return new Response(body, {
        headers: {
            "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="${name}"`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            // Said before the first byte, so a client can tell somebody the file
            // they are about to receive stops short of what they asked for.
            "x-audit-total": String(total),
            "x-audit-truncated": truncated ? "1" : "0"
        }
    });
}

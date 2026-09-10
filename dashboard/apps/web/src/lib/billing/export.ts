/**
 * A month's statement as a file, and the HTTP half of reading one.
 *
 * The same shape the audit trail's export has: the route authorizes and decides
 * the scope, this parses what was asked for, records that a copy was taken, and
 * answers with a file named for what it holds. CSV for a spreadsheet, one row per
 * project with its usage and its cost; JSON for anything that reads it back, the
 * whole statement - prices, owners and totals included.
 *
 * Cells go through the same formula guard the audit export uses: a project name
 * is typed by people, and one starting with `=` is a formula to a spreadsheet.
 *
 * Server-only.
 */

import * as core from "@polaris/core";
import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit-service";
import { BillingRequestError, readStatement, resolveMonth, type BillingScope, type StatementView } from "./statement";

const CSV_COLUMNS = [
    "month",
    "owner_kind",
    "owner_id",
    "owner",
    "project_id",
    "project",
    "cpu_vcpu_hours",
    "memory_gb_hours",
    "storage_gb_months",
    "network_out_gb",
    "currency",
    "cpu_cost",
    "memory_cost",
    "storage_cost",
    "network_out_cost",
    "total_cost"
] as const;

/** A quantity, to four places: enough for a price of a fraction of a cent to be
 *  worked out again from the file. */
function quantity(value: number): string {
    return value.toFixed(4);
}

/** An amount, to the currency's own places, or empty when it has no price. */
function money(value: number | null | undefined, currency: core.CurrencyCode | null): string {
    if (value === null || value === undefined || currency === null) return "";
    return value.toFixed(core.currencyDigits(currency));
}

/** The statement as CSV, a row per project. */
export function statementCsv(view: StatementView): string {
    const { statement } = view;
    const currency = statement.rates?.currency ?? null;
    const hours = core.hoursInMonth(statement.month) || 1;
    const rows = statement.lines.map((line) =>
        [
            statement.month,
            line.owner.kind,
            line.owner.id,
            line.owner.name,
            line.projectId,
            line.projectName,
            quantity(line.usage.cpuHours),
            quantity(line.usage.memoryGbHours),
            quantity(line.usage.storageGbHours / hours),
            quantity(line.usage.egressGb),
            currency ?? "",
            money(line.cost?.cpu, currency),
            money(line.cost?.memory, currency),
            money(line.cost?.storage, currency),
            money(line.cost?.egress, currency),
            money(line.cost?.total, currency)
        ]
            .map(core.csvField)
            .join(",")
    );
    return [CSV_COLUMNS.join(","), ...rows].map((row) => `${row}\r\n`).join("");
}

/** The name a statement is saved under: whose, and which month. */
export function statementFilename(label: string, month: string, format: core.AuditExportFormat): string {
    const safe = label.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "polaris";
    return `${safe}-statement-${month}.${format}`;
}

function refused(message: string, status = 400): Response {
    return NextResponse.json({ error: message }, { status });
}

/** The query string as an object, for the schema. */
function params(request: Request): Record<string, string> {
    return Object.fromEntries(new URL(request.url).searchParams);
}

/** A statement for the screen. */
export async function statementResponse(
    request: Request,
    scope: BillingScope,
    extra?: (view: StatementView) => Promise<Record<string, unknown>>
): Promise<Response> {
    const parsed = core.billingStatementQuerySchema.safeParse(params(request));
    if (!parsed.success) return refused(parsed.error.issues[0]?.message ?? "Pick a month");
    try {
        const view = await readStatement(scope, resolveMonth(parsed.data.month));
        return NextResponse.json({ ...view, ...(extra ? await extra(view) : {}) });
    } catch (caught) {
        if (caught instanceof BillingRequestError) return refused(caught.message);
        console.error("polaris: a billing statement could not be read:", caught);
        return refused("The statement could not be worked out just now. Try again in a moment.", 500);
    }
}

/**
 * A statement as a file.
 *
 * Taking a copy is recorded, as a copy of the audit trail is: who took it, of
 * which month, as what. For an organization's statement the entry names the
 * organization, so its own Activity screen shows it too.
 */
export async function statementExportResponse(
    request: Request,
    scope: BillingScope,
    options: { label: string; actorId: string; orgId?: string }
): Promise<Response> {
    const parsed = core.billingExportQuerySchema.safeParse(params(request));
    if (!parsed.success) return refused(parsed.error.issues[0]?.message ?? "Pick a month and a format");
    let view: StatementView;
    try {
        view = await readStatement(scope, resolveMonth(parsed.data.month));
    } catch (caught) {
        if (caught instanceof BillingRequestError) return refused(caught.message);
        console.error("polaris: a billing statement could not be exported:", caught);
        return refused("The statement could not be worked out just now. Try again in a moment.", 500);
    }

    const { format } = parsed.data;
    await recordAudit({
        actorId: options.actorId,
        orgId: options.orgId,
        action: "billing.export",
        metadata: { scope: scope.kind, month: view.statement.month, format, projects: view.statement.lines.length }
    });

    const body = format === "csv" ? statementCsv(view) : JSON.stringify(view);
    return new Response(body, {
        headers: {
            "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="${statementFilename(options.label, view.statement.month, format)}"`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff"
        }
    });
}

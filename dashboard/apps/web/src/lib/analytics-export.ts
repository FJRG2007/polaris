/**
 * The rows an analytics export is made of, and the formats it can be written
 * in. Kept apart from the route so each format can be asserted on its own: the
 * route only reads pages of events and hands them through here.
 */

import { csvCell } from "@/lib/access/grant-use-csv";
import { parseProps } from "@/lib/analytics-reports";

export const EXPORT_FORMATS = ["csv", "json", "xlsx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_COLUMNS = [
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
] as const;

/** One event as the export reads it from the database. */
export interface ExportEvent {
    at: Date;
    sessionId: string;
    kind: string;
    name: string | null;
    path: string;
    rawPath: string | null;
    props: string | null;
    session: {
        distinctId: string | null;
        browser: string;
        os: string;
        device: string;
        country: string | null;
        language: string | null;
        screen: string | null;
        referrerKind: string;
        referrerSource: string | null;
        campaign: string | null;
        medium: string | null;
    };
}

/** The flat cells of one event, in `EXPORT_COLUMNS` order. */
export function exportCells(event: ExportEvent): string[] {
    const session = event.session;
    return [
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
    ];
}

export function csvLine(cells: readonly string[]): string {
    return `${cells.map(csvCell).join(",")}\n`;
}

/** One event as a JSON object: absent values are null rather than empty
 *  strings, and its properties are an object rather than the stored text. */
export function exportRecord(event: ExportEvent): Record<string, unknown> {
    const cells = exportCells(event);
    const record: Record<string, unknown> = {};
    EXPORT_COLUMNS.forEach((column, index) => {
        record[column] = cells[index] === "" ? null : cells[index];
    });
    record.properties = parseProps(event.props) ?? (event.props || null);
    return record;
}

/** A spreadsheet cell holds at most this many characters. */
export const XLSX_CELL_MAX = 32_767;

export function xlsxCells(event: ExportEvent): string[] {
    return exportCells(event).map((cell) => (cell.length > XLSX_CELL_MAX ? cell.slice(0, XLSX_CELL_MAX) : cell));
}

export const EXPORT_CONTENT_TYPE: Record<ExportFormat, string> = {
    csv: "text/csv; charset=utf-8",
    json: "application/json; charset=utf-8",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

/**
 * A zone's records as the table lists them: narrowed by type and a search, in
 * the order Cloudflare's own list uses - by type, then by name - and the row an
 * optimistic write shows before Cloudflare has answered. Pure, so the filtering
 * and the order are asserted without a browser.
 */

import type { DnsRecordView } from "./zone-records";
import {
    PROXIABLE_TYPES,
    TTL_AUTO,
    normalizeDraft,
    relativeName,
    type DnsRecordDraft,
    type DnsRecordFields
} from "./record-schema";

/** The type filter's "every type" value. */
export const ALL_TYPES = "all";

export interface RecordFilters {
    /** A record type, or `ALL_TYPES`. */
    readonly type: string;
    readonly search: string;
}

export const NO_RECORD_FILTERS: RecordFilters = { type: ALL_TYPES, search: "" };

/** Plain code-point order: the same on every machine, whatever its language. */
function compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/** The records that match the filters, by type, then name, then value. */
export function listedRecords(records: readonly DnsRecordView[], filters: RecordFilters): DnsRecordView[] {
    const needle = filters.search.trim().toLowerCase();
    return records
        .filter((record) => filters.type === ALL_TYPES || record.type === filters.type)
        .filter(
            (record) =>
                needle === "" ||
                record.name.toLowerCase().includes(needle) ||
                record.relative.toLowerCase().includes(needle) ||
                record.content.toLowerCase().includes(needle)
        )
        .sort(
            (a, b) =>
                compare(a.type, b.type) || compare(a.relative, b.relative) || compare(a.content, b.content)
        );
}

/** The types a zone actually holds, for a filter with no option that matches nothing. */
export function recordTypesIn(records: readonly DnsRecordView[]): string[] {
    return [...new Set(records.map((record) => record.type))].sort(compare);
}

const TTL_LABELS: Record<number, string> = { 60: "1 min", 300: "5 min", 3600: "1 hour", 86400: "1 day" };

/** A TTL as the table and the form say it. */
export function ttlLabel(ttl: number): string {
    if (ttl === TTL_AUTO) return "Auto";
    return TTL_LABELS[ttl] ?? `${ttl} s`;
}

/** The value column's text for a record in the shape Cloudflare takes. */
function contentOf(fields: DnsRecordFields): string {
    switch (fields.type) {
        case "SRV":
            return `${fields.data.priority} ${fields.data.weight} ${fields.data.port} ${fields.data.target}`;
        case "CAA":
            return `${fields.data.flags} ${fields.data.tag} "${fields.data.value}"`;
        default:
            return fields.content;
    }
}

/**
 * The row a write shows while Cloudflare has not answered yet, built from the
 * checked record. Replaced by the row the server answers with, or taken away if
 * the write is refused.
 */
export function pendingView(id: string, fields: DnsRecordFields, draft: DnsRecordDraft, zone: string): DnsRecordView {
    const proxiable = PROXIABLE_TYPES.includes(fields.type);
    const proxied = "proxied" in fields && fields.proxied;
    return {
        id,
        type: fields.type,
        name: fields.name,
        relative: relativeName(fields.name, zone),
        content: contentOf(fields),
        ttl: fields.ttl,
        proxied,
        proxiable,
        priority: fields.type === "MX" ? fields.priority : null,
        draft: { ...normalizeDraft(draft), name: relativeName(fields.name, zone) }
    };
}

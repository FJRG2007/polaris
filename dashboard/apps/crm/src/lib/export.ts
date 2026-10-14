/**
 * A list as a CSV file: the rows the reader's view shows - its search, filter
 * and sorts - in the columns it shows, read from the database in batches up to
 * a ceiling so a large shelf cannot hold a connection or the server's memory.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { toCsv } from "../model/csv";
import { loadFields } from "./fields";
import { nameLinks } from "./linked";
import type { ViewSort } from "../model/views";
import { requireCan, type CrmActor } from "./access";
import { recordSelect, table, toRecord } from "./columns";
import { listOrder, listWhere, type ListScope } from "./query";
import { requireListShown } from "./records";
import {
    fieldOf,
    primaryField,
    type CrmObject,
    type CrmRecord,
    type FieldDef
} from "../model/objects";

/** The most rows one export writes. */
export const MAX_EXPORT = 10_000;

/** How many rows one read of an export takes. */
const BATCH = 500;

export interface ExportOptions extends ListScope {
    readonly sorts?: readonly ViewSort[];
    /** The view's column keys, in order. The record's name always comes first. */
    readonly columns: readonly string[];
}

export interface CsvExport {
    readonly csv: string;
    readonly rows: number;
    /** More rows matched than one export writes. */
    readonly truncated: boolean;
}

/** The view's rows as a CSV file. */
export async function exportRecords(
    actor: CrmActor,
    object: CrmObject,
    options: ExportOptions
): Promise<CsvExport> {
    await requireCan(actor, object, "read");
    const custom = await loadFields(actor.shelf, object);
    const primary = primaryField(object);
    await requireListShown(actor, object, options);
    // A column the reader's role hides is left out of the file, not refused:
    // the view it comes from may be shared with roles that see it.
    const hidden = actor.rules?.[object].hidden ?? [];
    const keys = new Set([primary.key, ...options.columns.filter((key) => !hidden.includes(key))]);
    const fields = [...keys]
        .map((key) => fieldOf(object, key, custom))
        .filter((field): field is FieldDef => Boolean(field));
    const where = listWhere(object, actor, { ...options, custom });
    const orderBy = listOrder(object, options.sorts ?? []);
    const records: CrmRecord[] = [];
    // Batches by offset over a total order (it ends in the id), so no row is
    // read twice or skipped while nothing changes underneath. One row past the
    // ceiling is read to tell that the file was cut.
    while (records.length <= MAX_EXPORT) {
        const rows = (await table(object).findMany({
            where,
            orderBy,
            skip: records.length,
            take: Math.min(BATCH, MAX_EXPORT + 1 - records.length),
            select: recordSelect(object)
        })) as Record<string, unknown>[];
        records.push(
            ...(await nameLinks(
                actor,
                rows.map((row) => toRecord(object, row)),
                custom
            ))
        );
        if (rows.length === 0 || records.length > MAX_EXPORT || rows.length < BATCH) break;
    }
    const t = await crmT();
    const kept = records.slice(0, MAX_EXPORT);
    return {
        csv: toCsv(
            fields,
            kept,
            (field) => field.label ?? t(`fields.${object}.${field.key}` as Parameters<typeof t>[0])
        ),
        rows: kept.length,
        truncated: records.length > MAX_EXPORT
    };
}

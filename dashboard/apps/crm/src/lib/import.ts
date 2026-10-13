/**
 * One batch of a CSV import: its rows checked again here with the same rules
 * the preview used, references found by name on the reader's shelf, and the
 * rows that pass made in one transaction, each with a timeline entry. A row
 * that fails is reported back and nothing is made for it.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { prisma } from "@polaris/db";
import { CrmRefusal } from "./errors";
import { loadFields } from "./fields";
import { logEvents } from "./timeline";
import { shelfPeople } from "./records";
import { initialValues } from "../model/timeline";
import type { InputValue } from "../model/values";
import { checkRow, splitName, type RowProblem } from "../model/import";
import { requireCan, shelfData, shelfWhere, type CrmActor } from "./access";
import { columnOf, recordSelect, table, toRecord, writable, writeData } from "./columns";
import { primaryField, type CrmObject, type CrmRecord, type FieldDef } from "../model/objects";

export interface ImportBatch {
    /** The field each column goes to, or null for a column left out. */
    readonly mapping: readonly (string | null)[];
    readonly rows: readonly (readonly string[])[];
}

export interface ImportResult {
    readonly created: number;
    /** The rows not made, by their index in the batch. */
    readonly failed: { readonly row: number; readonly problems: RowProblem[] }[];
}

/** Lower case and single spaces: how a name typed in a file is matched. */
const key = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The records of one kind on the shelf named by any of `names`, as name -> ids.
 * Two records with one name are both returned, so the row can say which.
 */
async function findByName(
    actor: CrmActor,
    target: CrmObject,
    names: readonly string[]
): Promise<Map<string, string[]>> {
    const found = new Map<string, string[]>();
    if (names.length === 0) return found;
    const spec = columnOf(target, primaryField(target).key);
    const where =
        spec.type === "name"
            ? {
                  OR: names.map((name) => {
                      const { first, last } = splitName(name);
                      return {
                          [spec.first]: { equals: first, mode: "insensitive" },
                          [spec.last]: { equals: last, mode: "insensitive" }
                      };
                  })
              }
            : {
                  [spec.type === "scalar" ? spec.column : "name"]: {
                      in: [...names],
                      mode: "insensitive"
                  }
              };
    const rows = (await table(target).findMany({
        where: { ...where, ...shelfWhere(actor.shelf), deletedAt: null },
        // Two per name at most tell one record from several.
        take: names.length * 2,
        select: recordSelect(target)
    })) as Record<string, unknown>[];
    for (const row of rows) {
        const record = toRecord(target, row);
        const value = record.values[primaryField(target).key];
        const name =
            value && typeof value === "object" && "first" in value
                ? [value.first, value.last].filter(Boolean).join(" ")
                : String(value ?? "");
        found.set(key(name), [...(found.get(key(name)) ?? []), record.id]);
    }
    return found;
}

/** Rows of text read as values for a kind of record: each checked, each
 *  reference found by name on the shelf. A row with a problem has no values. */
export interface ReadRows {
    readonly values: (Record<string, InputValue> | null)[];
    readonly failed: ImportResult["failed"];
    /** The fields the columns go to. */
    readonly fields: readonly FieldDef[];
}

/**
 * Rows of text, one cell per mapped field, as the values to store - checked
 * with the rules a cell's editor uses and with every company, person and owner
 * named in them found on the actor's shelf.
 */
export async function readRows(
    actor: CrmActor,
    object: CrmObject,
    batch: ImportBatch,
    needsName = true
): Promise<ReadRows> {
    const custom = await loadFields(actor.shelf, object);
    const columns = batch.mapping.map((fieldKey) =>
        fieldKey === null ? null : writable(object, fieldKey, custom)
    );
    const mapped = columns.filter((field): field is FieldDef => field !== null);
    if (mapped.length !== batch.mapping.filter((fieldKey) => fieldKey !== null).length) {
        const t = await crmT();
        throw new CrmRefusal(t("errors.unknownField"));
    }
    if (new Set(mapped.map((field) => field.key)).size !== mapped.length) {
        const t = await crmT();
        throw new CrmRefusal(t("import.duplicateMapping"));
    }
    const primary = primaryField(object);
    const checked = batch.rows.map((cells) => checkRow(columns, cells, primary, needsName));

    // Every name a reference column holds, found in one read per field.
    const relations = mapped.filter((field) => field.kind === "relation");
    const found = new Map<string, Map<string, string[]>>();
    for (const field of relations) {
        await requireCan(actor, field.target!, "read");
        const names = new Set(
            checked.flatMap((row) => (row.refs[field.key] ? [key(row.refs[field.key]!)] : []))
        );
        found.set(field.key, await findByName(actor, field.target!, [...names]));
    }
    if (mapped.some((field) => field.kind === "member")) {
        const people = new Map<string, string[]>();
        for (const person of await shelfPeople(actor)) {
            people.set(key(person.name), [...(people.get(key(person.name)) ?? []), person.id]);
        }
        for (const field of mapped) if (field.kind === "member") found.set(field.key, people);
    }

    const failed: ImportResult["failed"] = [];
    const values = checked.map((row, index) => {
        const problems = [...row.problems];
        const out: Record<string, InputValue> = { ...(row.values as Record<string, InputValue>) };
        for (const [fieldKey, name] of Object.entries(row.refs)) {
            const ids = found.get(fieldKey)?.get(key(name)) ?? [];
            const member = columns.find((field) => field?.key === fieldKey)?.kind === "member";
            if (ids.length === 1) out[fieldKey] = ids[0]!;
            else
                problems.push({
                    key: fieldKey,
                    reason: ids.length > 1 ? "ambiguous" : member ? "notOnShelf" : "missing"
                });
        }
        if (problems.length === 0) return out;
        failed.push({ row: index, problems });
        return null;
    });
    return { values, failed, fields: mapped };
}

/** Import one batch of rows. */
export async function importRecords(
    actor: CrmActor,
    object: CrmObject,
    batch: ImportBatch,
    /** How the new records' timelines name how they were made. */
    logAs: "imported" | "created" = "imported"
): Promise<ImportResult> {
    await requireCan(actor, object, "edit");
    const { values, failed, fields } = await readRows(actor, object, batch);
    const ready: Record<string, unknown>[] = [];
    const readyKeys: string[][] = [];
    for (const row of values) {
        if (!row) continue;
        const data: Record<string, unknown> = {};
        for (const [fieldKey, value] of Object.entries(row)) {
            const field = fields.find((one) => one.key === fieldKey)!;
            Object.assign(data, writeData(object, field, value));
        }
        ready.push(data);
        readyKeys.push(Object.keys(row));
    }
    if (ready.length === 0) return { created: 0, failed };

    // Made above everything already there, in the file's order.
    const records = await prisma.$transaction(
        async (tx) => {
            const first = (await table(object, tx).findFirst({
                where: shelfWhere(actor.shelf),
                orderBy: { position: "asc" },
                select: { position: true }
            })) as { position: number } | null;
            const base = (first?.position ?? 1) - ready.length;
            const made: CrmRecord[] = [];
            for (const [index, data] of ready.entries()) {
                const row = await table(object, tx).create({
                    data: {
                        ...data,
                        ...shelfData(actor.shelf),
                        createdById: actor.user.id,
                        position: base + index
                    },
                    select: recordSelect(object)
                });
                made.push(toRecord(object, row as Record<string, unknown>));
            }
            return made;
        },
        { timeout: 30_000 }
    );
    await logEvents(
        actor,
        object,
        records.map((record, index) => ({
            recordId: record.id,
            kind: logAs,
            changes: initialValues(record, readyKeys[index]!)
        }))
    );
    return { created: records.length, failed };
}

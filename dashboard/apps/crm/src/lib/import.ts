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

/** Import one batch of rows. */
export async function importRecords(
    actor: CrmActor,
    object: CrmObject,
    batch: ImportBatch
): Promise<ImportResult> {
    await requireCan(actor, object, "edit");
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
    const checked = batch.rows.map((cells) => checkRow(columns, cells, primary));

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
    const ready: Record<string, unknown>[] = [];
    const readyKeys: string[][] = [];
    checked.forEach((row, index) => {
        const problems = [...row.problems];
        const values: Record<string, unknown> = { ...row.values };
        for (const [fieldKey, name] of Object.entries(row.refs)) {
            const ids = found.get(fieldKey)?.get(key(name)) ?? [];
            const member = columns.find((field) => field?.key === fieldKey)?.kind === "member";
            if (ids.length === 1) values[fieldKey] = ids[0];
            else
                problems.push({
                    key: fieldKey,
                    reason: ids.length > 1 ? "ambiguous" : member ? "notOnShelf" : "missing"
                });
        }
        if (problems.length > 0) {
            failed.push({ row: index, problems });
            return;
        }
        const data: Record<string, unknown> = {};
        for (const [fieldKey, value] of Object.entries(values)) {
            const field = columns.find((one) => one?.key === fieldKey)!;
            Object.assign(data, writeData(object, field, value as InputValue));
        }
        ready.push(data);
        readyKeys.push(Object.keys(values));
    });
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
            kind: "imported",
            changes: initialValues(record, readyKeys[index]!)
        }))
    );
    return { created: records.length, failed };
}

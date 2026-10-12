/**
 * Fields somebody adds to a kind of record on their shelf.
 *
 * Each one claims a free slot column of the record's table in the family its
 * kind is kept in (`model/objects` SLOT_FAMILIES), so filtering, sorting,
 * grouping and totals run in the database exactly as for a built-in field.
 * Removing a field, or one of a select's choices, empties what the records
 * held there in the same transaction and takes it out of every saved view, so
 * a slot handed to the next field starts empty and unfiltered. Since that
 * loses values for everybody, it takes the right to delete records.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { CrmRefusal } from "./errors";
import { table } from "./columns";
import { readConfig } from "../model/views";
import { isGroup, type FilterRule } from "../model/filters";
import { prisma, type Prisma } from "@polaris/db";
import { requireCan, shelfData, shelfWhere, type CrmActor, type Shelf } from "./access";
import { SLOT_FAMILIES, slotFamily, type CrmObject, type FieldDef } from "../model/objects";
import {
    choiceChanges,
    customDef,
    validStored,
    type ChoiceRename,
    type CustomField,
    type FieldInput
} from "../model/fields";

const FIELD_SELECT = { id: true, slot: true, label: true, kind: true, options: true } as const;

type FieldRow = { id: string; slot: string; label: string; kind: string; options: string };

function readOptions(raw: string): string[] {
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === "string") : [];
    } catch {
        return [];
    }
}

function toField(row: FieldRow): CustomField | null {
    if (!validStored(row.kind, row.slot)) return null;
    return { id: row.id, slot: row.slot, label: row.label, kind: row.kind, options: readOptions(row.options) };
}

/** The fields added to a kind of record on a shelf, in the order they were added. */
export async function listFields(shelf: Shelf, object: CrmObject): Promise<CustomField[]> {
    const rows = await prisma.crmField.findMany({
        where: { shelf: shelf.key, object },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: FIELD_SELECT
    });
    return rows.map(toField).filter((field): field is CustomField => field !== null);
}

/** The same fields as every screen and query reads a field. */
export async function loadFields(shelf: Shelf, object: CrmObject): Promise<FieldDef[]> {
    return (await listFields(shelf, object)).map(customDef);
}

async function refuse(key: "fieldMissing" | "fieldSlots" | "fieldNameTaken"): Promise<never> {
    const t = await crmT();
    throw new CrmRefusal(t(`errors.${key}`));
}

function sameLabel(fields: readonly CustomField[], label: string, except?: string): boolean {
    const wanted = label.toLowerCase();
    return fields.some((field) => field.id !== except && field.label.toLowerCase() === wanted);
}

/** The value a slot holds when nothing is set. */
function emptySlot(slot: string): string | boolean | null {
    const family = slot.replace(/\d+$/, "");
    if (family === "cText") return "";
    if (family === "cBool") return false;
    return null;
}

/** How many times adding a field tries again when another one took its slot. */
const CREATE_TRIES = 3;

function slotTaken(caught: unknown): boolean {
    return (caught as { code?: unknown } | null)?.code === "P2002";
}

/**
 * Every saved view of a kind of record made whole for the fields it has after
 * a change, in the same transaction: a removed field leaves no column, sort,
 * filter or grouping behind for the next field in its slot, and a filter on a
 * renamed choice follows it to its new wording.
 */
async function rewriteViews(
    tx: Prisma.TransactionClient,
    shelf: Shelf,
    object: CrmObject,
    before: readonly FieldDef[],
    after: readonly FieldDef[],
    renamed: { readonly key: string; readonly choices: readonly ChoiceRename[] } | null = null
): Promise<void> {
    const views = await tx.crmView.findMany({
        where: { shelf: shelf.key, object },
        select: { id: true, config: true }
    });
    const follow = (rule: FilterRule): FilterRule =>
        renamed && rule.key === renamed.key && Array.isArray(rule.value)
            ? {
                  ...rule,
                  value: rule.value.map((choice) => {
                      const to = renamed.choices.find((one) => one.from === choice.id)?.to;
                      return to === undefined ? choice : { ...choice, id: to };
                  })
              }
            : rule;
    for (const view of views) {
        let stored: unknown = null;
        try {
            stored = JSON.parse(view.config);
        } catch {
            continue;
        }
        const current = readConfig(object, stored, before);
        const moved = {
            ...current,
            filter: {
                ...current.filter,
                rules: current.filter.rules.map((item) =>
                    isGroup(item) ? { ...item, rules: item.rules.map(follow) } : follow(item)
                )
            }
        };
        const config = JSON.stringify(readConfig(object, moved, after));
        if (config !== view.config) await tx.crmView.update({ where: { id: view.id }, data: { config } });
    }
}

/** Add a field. It takes the first free slot of its kind's family. */
export async function createField(
    actor: CrmActor,
    object: CrmObject,
    input: FieldInput
): Promise<CustomField> {
    await requireCan(actor, object, "edit");
    for (let attempt = 1; ; attempt += 1) {
        const rows = await prisma.crmField.findMany({
            where: { shelf: actor.shelf.key, object },
            select: { ...FIELD_SELECT, position: true }
        });
        const existing = rows.map(toField).filter((field): field is CustomField => field !== null);
        if (sameLabel(existing, input.label)) await refuse("fieldNameTaken");
        const family = slotFamily(input.kind);
        const taken = new Set(rows.map((row) => row.slot));
        const slot = Array.from({ length: SLOT_FAMILIES[family] }, (_, index) => `${family}${index + 1}`).find(
            (candidate) => !taken.has(candidate)
        );
        if (!slot) return refuse("fieldSlots");
        const position = Math.max(0, ...rows.map((row) => row.position)) + 1;
        try {
            // The slot may still hold values from an older field whose cleanup
            // never ran; a new field starts empty.
            const row = await prisma.$transaction(async (tx) => {
                await table(object, tx).updateMany({
                    where: shelfWhere(actor.shelf),
                    data: { [slot]: emptySlot(slot) }
                });
                return tx.crmField.create({
                    data: {
                        ...shelfData(actor.shelf),
                        shelf: actor.shelf.key,
                        object,
                        slot,
                        label: input.label,
                        kind: input.kind,
                        options: JSON.stringify(input.options),
                        position,
                        createdById: actor.user.id
                    },
                    select: FIELD_SELECT
                });
            });
            return toField(row)!;
        } catch (caught) {
            // Another field was added at the same moment and took this slot.
            if (!slotTaken(caught) || attempt >= CREATE_TRIES) throw caught;
        }
    }
}

/**
 * Rename a field or change a select's choices. Its kind stays: the values are
 * kept in a column made for it. A choice given new wording keeps its records;
 * records holding a choice that is gone are left with no choice, which takes
 * the right to delete records.
 */
export async function updateField(
    actor: CrmActor,
    object: CrmObject,
    id: string,
    input: FieldInput,
    renames: readonly ChoiceRename[] = []
): Promise<CustomField> {
    await requireCan(actor, object, "edit");
    const existing = await listFields(actor.shelf, object);
    const field = existing.find((one) => one.id === id);
    if (!field || field.kind !== input.kind) return refuse("fieldMissing");
    if (sameLabel(existing, input.label, id)) await refuse("fieldNameTaken");
    const { renamed, removed } = choiceChanges(field.options, input.options, renames);
    if (removed.length > 0) await requireCan(actor, object, "delete");
    const before = existing.map(customDef);
    const after = existing.map((one) =>
        customDef(one.id === id ? { ...one, label: input.label, options: input.options } : one)
    );
    const row = await prisma.$transaction(async (tx) => {
        for (const rename of renamed) {
            await table(object, tx).updateMany({
                where: { ...shelfWhere(actor.shelf), [field.slot]: rename.from },
                data: { [field.slot]: rename.to }
            });
        }
        if (removed.length > 0) {
            await table(object, tx).updateMany({
                where: { ...shelfWhere(actor.shelf), [field.slot]: { in: removed } },
                data: { [field.slot]: "" }
            });
        }
        if (renamed.length > 0 || removed.length > 0) {
            await rewriteViews(tx, actor.shelf, object, before, after, {
                key: field.slot,
                choices: renamed
            });
        }
        return tx.crmField.update({
            where: { id },
            data: { label: input.label, options: JSON.stringify(input.options) },
            select: FIELD_SELECT
        });
    });
    return toField(row)!;
}

/** Remove a field, everything the records held in it, and every view's use of it. */
export async function deleteField(actor: CrmActor, object: CrmObject, id: string): Promise<void> {
    await requireCan(actor, object, "edit");
    await requireCan(actor, object, "delete");
    const existing = await listFields(actor.shelf, object);
    const field = await prisma.crmField.findFirst({
        where: { id, shelf: actor.shelf.key, object },
        select: { slot: true }
    });
    if (!field) return refuse("fieldMissing");
    const before = existing.map(customDef);
    const after = existing.filter((one) => one.id !== id).map(customDef);
    await prisma.$transaction(async (tx) => {
        await table(object, tx).updateMany({
            where: shelfWhere(actor.shelf),
            data: { [field.slot]: emptySlot(field.slot) }
        });
        await tx.crmField.delete({ where: { id } });
        await rewriteViews(tx, actor.shelf, object, before, after);
    });
}

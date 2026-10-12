/**
 * Fields somebody adds to a kind of record on their shelf.
 *
 * Each one claims a free slot column of the record's table in the family its
 * kind is kept in (`model/objects` SLOT_FAMILIES), so filtering, sorting,
 * grouping and totals run in the database exactly as for a built-in field.
 * Removing a field, or one of a select's choices, empties what the records
 * held there in the same transaction, so a slot handed to the next field
 * starts empty.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { CrmRefusal } from "./errors";
import { prisma } from "@polaris/db";
import { table } from "./columns";
import { requireCan, shelfData, shelfWhere, type CrmActor, type Shelf } from "./access";
import { SLOT_FAMILIES, slotFamily, type CrmObject, type FieldDef } from "../model/objects";
import { customDef, validStored, type CustomField, type FieldInput } from "../model/fields";

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

/** Add a field. It takes the first free slot of its kind's family. */
export async function createField(
    actor: CrmActor,
    object: CrmObject,
    input: FieldInput
): Promise<CustomField> {
    await requireCan(actor, object, "edit");
    const existing = await listFields(actor.shelf, object);
    if (sameLabel(existing, input.label)) await refuse("fieldNameTaken");
    const family = slotFamily(input.kind);
    const taken = new Set(
        (
            await prisma.crmField.findMany({
                where: { shelf: actor.shelf.key, object },
                select: { slot: true }
            })
        ).map((row) => row.slot)
    );
    const slot = Array.from({ length: SLOT_FAMILIES[family] }, (_, index) => `${family}${index + 1}`).find(
        (candidate) => !taken.has(candidate)
    );
    if (!slot) return refuse("fieldSlots");
    const last = await prisma.crmField.findFirst({
        where: { shelf: actor.shelf.key, object },
        orderBy: { position: "desc" },
        select: { position: true }
    });
    // The slot may still hold values from an older field whose cleanup never
    // ran; a new field starts empty.
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
                position: (last?.position ?? 0) + 1,
                createdById: actor.user.id
            },
            select: FIELD_SELECT
        });
    });
    return toField(row)!;
}

/**
 * Rename a field or change a select's choices. Its kind stays: the values are
 * kept in a column made for it. Records holding a choice that is gone are
 * left with no choice.
 */
export async function updateField(
    actor: CrmActor,
    object: CrmObject,
    id: string,
    input: FieldInput
): Promise<CustomField> {
    await requireCan(actor, object, "edit");
    const existing = await listFields(actor.shelf, object);
    const field = existing.find((one) => one.id === id);
    if (!field || field.kind !== input.kind) return refuse("fieldMissing");
    if (sameLabel(existing, input.label, id)) await refuse("fieldNameTaken");
    const removed = field.options.filter((option) => !input.options.includes(option));
    const row = await prisma.$transaction(async (tx) => {
        if (removed.length > 0) {
            await table(object, tx).updateMany({
                where: { ...shelfWhere(actor.shelf), [field.slot]: { in: removed } },
                data: { [field.slot]: "" }
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

/** Remove a field and everything the records held in it. */
export async function deleteField(actor: CrmActor, object: CrmObject, id: string): Promise<void> {
    await requireCan(actor, object, "edit");
    const field = await prisma.crmField.findFirst({
        where: { id, shelf: actor.shelf.key, object },
        select: { slot: true }
    });
    if (!field) return refuse("fieldMissing");
    await prisma.$transaction(async (tx) => {
        await table(object, tx).updateMany({
            where: shelfWhere(actor.shelf),
            data: { [field.slot]: emptySlot(field.slot) }
        });
        await tx.crmField.delete({ where: { id } });
    });
}

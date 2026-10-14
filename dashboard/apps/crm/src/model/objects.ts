/**
 * The CRM's records and their fields, as data.
 *
 * Every screen that draws a record - a table, a board, a filter, an import -
 * reads these definitions rather than knowing a company from a person, so a
 * field added here is a column, a filter, an import target and an export column
 * at once. The server maps each field onto its columns (`lib/columns.ts`).
 *
 * Client-safe: no server module is imported.
 */

import { CRM_OBJECTS, type CrmObject } from "@polaris/core";

export { CRM_OBJECTS, type CrmObject };

/** How a field holds its value, and so how it is drawn, edited and filtered. */
export type FieldKind =
    | "text"
    | "fullName"
    | "email"
    | "phone"
    | "url"
    | "links"
    | "address"
    | "domain"
    | "number"
    | "currency"
    | "money"
    | "date"
    | "dateTime"
    | "select"
    | "multiSelect"
    | "rating"
    | "boolean"
    | "member"
    | "relation";

export interface FieldDef {
    readonly key: string;
    readonly kind: FieldKind;
    /** The record's name: drawn first, never hidden, required to create one. */
    readonly primary?: boolean;
    /** Written by Polaris, never by a person (created, updated). */
    readonly readOnly?: boolean;
    /** The choices of a `select` or `multiSelect`, in the order a board draws
     *  its columns; for a `money` field, its one currency code. */
    readonly options?: readonly string[];
    /** The record kind a `relation` points at. */
    readonly target?: CrmObject;
    /** For a `relation` somebody added: whether it holds a list of records
     *  rather than one. Its value is a `Ref[]` either way. */
    readonly many?: boolean;
    /** Its width in a new table, in pixels. */
    readonly width: number;
    /** Left out of a new table's columns until somebody adds it. */
    readonly hiddenByDefault?: boolean;
    /** A field somebody added (`lib/fields`): its key is the slot column it
     *  is stored in, and it is drawn by `label` rather than a translation. */
    readonly custom?: boolean;
    readonly label?: string;
}

/** The kinds a field somebody adds can be. */
export const CUSTOM_KINDS = [
    "text",
    "number",
    "money",
    "date",
    "boolean",
    "select",
    "multiSelect",
    "rating",
    "url",
    "links",
    "address",
    "email",
    "phone",
    "relation"
] as const;

export type CustomKind = (typeof CUSTOM_KINDS)[number];

/** The slot columns of each record table, per family, and how many there are. */
export const SLOT_FAMILIES = { cText: 10, cNum: 5, cDate: 5, cBool: 5, cRel: 3 } as const;

export type SlotFamily = keyof typeof SLOT_FAMILIES;

/** The family of slot columns a kind of custom field is stored in. */
export function slotFamily(kind: CustomKind): SlotFamily {
    if (kind === "number" || kind === "money" || kind === "rating") return "cNum";
    if (kind === "date") return "cDate";
    if (kind === "boolean") return "cBool";
    if (kind === "relation") return "cRel";
    return "cText";
}

/** Every slot column, "cText1" to "cRel3". */
export const SLOTS: readonly string[] = Object.entries(SLOT_FAMILIES).flatMap(([family, count]) =>
    Array.from({ length: count }, (_, index) => `${family}${index + 1}`)
);

/** The family of a slot key, or null for a key that is not one. */
export function slotOf(key: string): SlotFamily | null {
    const match = /^(cText|cNum|cDate|cBool|cRel)([1-9][0-9]?)$/.exec(key);
    if (!match) return null;
    const family = match[1] as SlotFamily;
    return Number(match[2]) <= SLOT_FAMILIES[family] ? family : null;
}

/** The fields of a kind of record: its own, then the ones added on the shelf. */
export function fieldsOf(object: CrmObject, custom: readonly FieldDef[] = []): readonly FieldDef[] {
    return custom.length === 0 ? FIELDS[object] : [...FIELDS[object], ...custom];
}

/** An opportunity's stages, first to last. A board draws one column each.
 *  "customer" is won and "lost" is lost (model/forecast, model/stage-flow). */
export const OPPORTUNITY_STAGES = [
    "new",
    "screening",
    "meeting",
    "proposal",
    "customer",
    "lost"
] as const;

export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

const CREATED: FieldDef = { key: "createdAt", kind: "dateTime", readOnly: true, width: 160 };
const UPDATED: FieldDef = {
    key: "updatedAt",
    kind: "dateTime",
    readOnly: true,
    width: 160,
    hiddenByDefault: true
};
const UPDATED_BY: FieldDef = {
    key: "updatedBy",
    kind: "member",
    readOnly: true,
    width: 160,
    hiddenByDefault: true
};
const CREATED_BY: FieldDef = {
    key: "createdBy",
    kind: "member",
    readOnly: true,
    width: 160,
    hiddenByDefault: true
};

export const FIELDS: Readonly<Record<CrmObject, readonly FieldDef[]>> = {
    companies: [
        { key: "name", kind: "text", primary: true, width: 220 },
        { key: "domain", kind: "domain", width: 180 },
        { key: "accountOwner", kind: "member", width: 170 },
        { key: "employees", kind: "number", width: 130 },
        { key: "annualRevenue", kind: "currency", width: 170 },
        { key: "city", kind: "text", width: 150 },
        { key: "country", kind: "text", width: 150, hiddenByDefault: true },
        { key: "address", kind: "text", width: 200, hiddenByDefault: true },
        { key: "idealCustomer", kind: "boolean", width: 140 },
        { key: "linkedinUrl", kind: "url", width: 190, hiddenByDefault: true },
        { key: "xUrl", kind: "url", width: 170, hiddenByDefault: true },
        CREATED,
        UPDATED,
        CREATED_BY,
        UPDATED_BY
    ],
    people: [
        { key: "name", kind: "fullName", primary: true, width: 220 },
        { key: "email", kind: "email", width: 220 },
        { key: "company", kind: "relation", target: "companies", width: 190 },
        { key: "jobTitle", kind: "text", width: 170 },
        { key: "phone", kind: "phone", width: 160 },
        { key: "city", kind: "text", width: 150 },
        { key: "linkedinUrl", kind: "url", width: 190, hiddenByDefault: true },
        { key: "xUrl", kind: "url", width: 170, hiddenByDefault: true },
        CREATED,
        UPDATED,
        CREATED_BY,
        UPDATED_BY
    ],
    opportunities: [
        { key: "name", kind: "text", primary: true, width: 220 },
        { key: "amount", kind: "currency", width: 160 },
        { key: "stage", kind: "select", options: OPPORTUNITY_STAGES, width: 150 },
        { key: "closeDate", kind: "date", width: 150 },
        { key: "company", kind: "relation", target: "companies", width: 190 },
        { key: "pointOfContact", kind: "relation", target: "people", width: 190 },
        { key: "owner", kind: "member", width: 170 },
        { key: "closeReason", kind: "text", width: 200, hiddenByDefault: true },
        CREATED,
        UPDATED,
        CREATED_BY,
        UPDATED_BY
    ]
};

/** One field of one kind of record, or undefined for a key it does not have. */
export function fieldOf(
    object: CrmObject,
    key: string,
    custom: readonly FieldDef[] = []
): FieldDef | undefined {
    return (
        FIELDS[object].find((field) => field.key === key) ??
        custom.find((field) => field.key === key)
    );
}

/** The field a record is named by. */
export function primaryField(object: CrmObject): FieldDef {
    return FIELDS[object].find((field) => field.primary)!;
}

/** Whether a string is one of the record kinds. */
export function isCrmObject(value: string): value is CrmObject {
    return (CRM_OBJECTS as readonly string[]).includes(value);
}

/** What a relation or an owner cell holds: the record or person, named. */
export interface Ref {
    readonly id: string;
    readonly name: string;
}

/** An amount and the currency it is in. */
export interface Money {
    readonly amount: number | null;
    readonly currency: string;
}

/** A person's name, in its two parts. */
export interface FullName {
    readonly first: string;
    readonly last: string;
}

/**
 * A field's value as it travels. Text-like fields hold "" for empty, never
 * null; a number, a date or a reference holds null.
 */
export type FieldValue = string | number | boolean | null | Ref | Money | FullName | readonly Ref[];

/** Whether a field is a relation somebody added: it holds a list of records
 *  (`Ref[]`, at most one unless `many`) kept in a `cRel` slot. */
export function isLinkList(field: FieldDef): boolean {
    return field.kind === "relation" && field.custom === true;
}

/** The records a link-list value holds; none for anything else. */
export function linksOf(value: FieldValue | undefined): readonly Ref[] {
    return Array.isArray(value) ? value : [];
}

/** One record as every screen receives it. */
export interface CrmRecord {
    readonly id: string;
    readonly position: number;
    readonly deletedAt: string | null;
    readonly values: Readonly<Record<string, FieldValue>>;
}

/** The name a record is shown by: its primary field, read as text. */
export function recordName(object: CrmObject, record: CrmRecord): string {
    const value = record.values[primaryField(object).key];
    if (value && typeof value === "object" && "first" in value) {
        return [value.first, value.last].filter(Boolean).join(" ");
    }
    return typeof value === "string" ? value : "";
}

/** Whether a value counts as empty, the way "is empty" filters and the
 *  "empty" totals read it. */
export function isEmptyValue(value: FieldValue | undefined): boolean {
    if (value === null || value === undefined || value === "") return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object") {
        if ("first" in value) return !value.first && !value.last;
        if ("amount" in value) return value.amount === null;
    }
    return false;
}

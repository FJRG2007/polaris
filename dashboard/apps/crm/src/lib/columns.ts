/**
 * Where each field of each kind of record is stored, and the moves between a
 * database row and the values the screens draw.
 *
 * The one place that knows a person's name is two columns, an amount is two
 * and a company is a foreign key: everything above - listing, sorting, totals,
 * writing - asks this module instead of naming a column.
 *
 * Server-only.
 */

import { prisma, Prisma } from "@polaris/db";
import {
    FIELDS,
    fieldOf,
    type CrmObject,
    type CrmRecord,
    type FieldDef,
    type FieldValue,
    type FullName,
    type Money
} from "../model/objects";
import type { InputValue } from "../model/values";

/** How one field sits in its table. */
export type ColumnSpec =
    | { readonly type: "scalar"; readonly column: string }
    | { readonly type: "day"; readonly column: string }
    | { readonly type: "name"; readonly first: string; readonly last: string }
    | { readonly type: "money"; readonly amount: string; readonly currency: string }
    | {
          readonly type: "ref";
          readonly column: string;
          readonly relation: string;
          readonly target: CrmObject | "user";
      };

const scalar = (column: string): ColumnSpec => ({ type: "scalar", column });
const user = (column: string, relation: string): ColumnSpec => ({
    type: "ref",
    column,
    relation,
    target: "user"
});

const COMMON: Readonly<Record<string, ColumnSpec>> = {
    createdAt: scalar("createdAt"),
    updatedAt: scalar("updatedAt"),
    createdBy: user("createdById", "createdBy")
};

export const COLUMNS: Readonly<Record<CrmObject, Readonly<Record<string, ColumnSpec>>>> = {
    companies: {
        name: scalar("name"),
        domain: scalar("domain"),
        accountOwner: user("accountOwnerId", "accountOwner"),
        employees: scalar("employees"),
        annualRevenue: { type: "money", amount: "annualRevenue", currency: "annualRevenueCurrency" },
        city: scalar("city"),
        country: scalar("country"),
        address: scalar("address"),
        idealCustomer: scalar("idealCustomer"),
        linkedinUrl: scalar("linkedinUrl"),
        xUrl: scalar("xUrl"),
        ...COMMON
    },
    people: {
        name: { type: "name", first: "firstName", last: "lastName" },
        email: scalar("email"),
        company: { type: "ref", column: "companyId", relation: "company", target: "companies" },
        jobTitle: scalar("jobTitle"),
        phone: scalar("phone"),
        city: scalar("city"),
        linkedinUrl: scalar("linkedinUrl"),
        xUrl: scalar("xUrl"),
        ...COMMON
    },
    opportunities: {
        name: scalar("name"),
        amount: { type: "money", amount: "amount", currency: "amountCurrency" },
        stage: scalar("stage"),
        closeDate: { type: "day", column: "closeDate" },
        company: { type: "ref", column: "companyId", relation: "company", target: "companies" },
        pointOfContact: {
            type: "ref",
            column: "pointOfContactId",
            relation: "pointOfContact",
            target: "people"
        },
        owner: user("ownerId", "owner"),
        ...COMMON
    }
};

export function columnOf(object: CrmObject, key: string): ColumnSpec {
    const spec = COLUMNS[object][key];
    if (!spec) throw new Error(`crm: ${object} has no field ${key}`);
    return spec;
}

/**
 * The Prisma delegate of a kind of record. Typed loosely on purpose: the three
 * tables share every column this module touches by name, and a union of three
 * delegates is not callable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDelegate = any;

export function table(
    object: CrmObject,
    client: Prisma.TransactionClient | typeof prisma = prisma
): AnyDelegate {
    if (object === "companies") return client.crmCompany;
    if (object === "people") return client.crmPerson;
    return client.crmOpportunity;
}

/** What a reference to a record of a kind is named by. */
const REF_SELECT: Readonly<Record<CrmObject | "user", Record<string, true>>> = {
    companies: { id: true, name: true },
    people: { id: true, firstName: true, lastName: true },
    opportunities: { id: true, name: true },
    user: { id: true, name: true }
};

/** The name a referenced row is drawn by. */
function refName(row: Record<string, unknown>): string {
    if ("firstName" in row) {
        return [row.firstName, row.lastName].filter((part) => typeof part === "string" && part).join(" ");
    }
    return typeof row.name === "string" ? row.name : "";
}

/** The `select` that reads every field of a kind of record. */
export function recordSelect(object: CrmObject): Record<string, unknown> {
    const select: Record<string, unknown> = { id: true, position: true, deletedAt: true };
    for (const spec of Object.values(COLUMNS[object])) {
        if (spec.type === "scalar" || spec.type === "day") select[spec.column] = true;
        else if (spec.type === "name") Object.assign(select, { [spec.first]: true, [spec.last]: true });
        else if (spec.type === "money") Object.assign(select, { [spec.amount]: true, [spec.currency]: true });
        else select[spec.relation] = { select: REF_SELECT[spec.target] };
    }
    return select;
}

function decimal(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    return Number(value as Prisma.Decimal);
}

/** A stored day (midnight UTC) as "YYYY-MM-DD". */
export function dayText(value: Date | null): string | null {
    return value ? value.toISOString().slice(0, 10) : null;
}

/** "YYYY-MM-DD" as the instant it is stored at. */
export function dayDate(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
}

/** One field's value from a row read with `recordSelect`. */
export function readValue(spec: ColumnSpec, row: Record<string, unknown>): FieldValue {
    switch (spec.type) {
        case "scalar": {
            const value = row[spec.column];
            if (value instanceof Date) return value.toISOString();
            return (value as FieldValue) ?? null;
        }
        case "day":
            return dayText((row[spec.column] as Date | null) ?? null);
        case "name":
            return { first: String(row[spec.first] ?? ""), last: String(row[spec.last] ?? "") };
        case "money": {
            const amount = decimal(row[spec.amount]);
            return { amount, currency: amount === null ? "" : String(row[spec.currency] ?? "") };
        }
        case "ref": {
            const related = row[spec.relation] as Record<string, unknown> | null | undefined;
            return related ? { id: String(related.id), name: refName(related) } : null;
        }
    }
}

/** A row read with `recordSelect`, as the screens receive it. */
export function toRecord(object: CrmObject, row: Record<string, unknown>): CrmRecord {
    const values: Record<string, FieldValue> = {};
    for (const field of FIELDS[object]) values[field.key] = readValue(columnOf(object, field.key), row);
    return {
        id: String(row.id),
        position: Number(row.position ?? 0),
        deletedAt: row.deletedAt instanceof Date ? row.deletedAt.toISOString() : null,
        values
    };
}

/** The columns one normalized value is written to. */
export function writeData(object: CrmObject, field: FieldDef, value: InputValue): Record<string, unknown> {
    const spec = columnOf(object, field.key);
    switch (spec.type) {
        case "scalar":
            return { [spec.column]: value };
        case "day":
            return { [spec.column]: value === null ? null : dayDate(value as string) };
        case "name": {
            const name = value as FullName;
            return { [spec.first]: name.first, [spec.last]: name.last };
        }
        case "money": {
            const money = value as Money;
            return {
                [spec.amount]: money.amount === null ? null : new Prisma.Decimal(money.amount.toFixed(2)),
                [spec.currency]: money.amount === null ? "" : money.currency
            };
        }
        case "ref":
            return { [spec.column]: value };
    }
}

/** Whether a field can be written by a person, by its definition. */
export function writable(object: CrmObject, key: string): FieldDef | null {
    const field = fieldOf(object, key);
    return field && !field.readOnly ? field : null;
}

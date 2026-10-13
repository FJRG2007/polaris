/**
 * What makes two records the same one: a person's email, a company's domain,
 * and for every kind its name. Compared in lower case with single spaces, the
 * way a name typed twice by two people still matches.
 *
 * Client-safe: no server module is imported.
 */

import type { CrmObject } from "./objects";

/** A field a record is recognized by, and the value it is compared on. */
export interface DuplicateKey {
    readonly key: string;
    readonly value: string;
}

/** A record already there that a new or changed one looks like. */
export interface Duplicate {
    readonly id: string;
    readonly name: string;
    /** The field they share. */
    readonly key: string;
}

/** The fields each kind of record is recognized by, its name first. */
export const DUPLICATE_FIELDS: Readonly<Record<CrmObject, readonly string[]>> = {
    companies: ["name", "domain"],
    people: ["name", "email"],
    opportunities: ["name"]
};

/** The most records a duplicate warning names. */
export const MAX_DUPLICATES = 5;

const folded = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

/** The text a value is compared on, or null for one that recognizes nothing. */
function comparable(value: unknown): string | null {
    if (typeof value === "string") return folded(value) || null;
    if (value && typeof value === "object" && "first" in value && "last" in value) {
        const name = value as { first: unknown; last: unknown };
        return comparable(`${String(name.first ?? "")} ${String(name.last ?? "")}`);
    }
    return null;
}

/**
 * The keys a record's values are recognized by, leaving out the fields in
 * `hidden`: a reader is never told a record holds a value their role hides.
 */
export function duplicateKeys(
    object: CrmObject,
    values: Readonly<Record<string, unknown>>,
    hidden: readonly string[] = []
): DuplicateKey[] {
    return DUPLICATE_FIELDS[object].flatMap((key) => {
        if (hidden.includes(key)) return [];
        const value = comparable(values[key]);
        return value === null ? [] : [{ key, value }];
    });
}

/** The first key two sets share, or null. */
export function sharedKey(
    wanted: readonly DuplicateKey[],
    found: readonly DuplicateKey[]
): string | null {
    const match = wanted.find((one) =>
        found.some((other) => other.key === one.key && other.value === one.value)
    );
    return match?.key ?? null;
}

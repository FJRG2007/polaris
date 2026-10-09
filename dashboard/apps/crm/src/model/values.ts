/**
 * What a person may write into a field, normalized the same way on both sides.
 *
 * A cell's editor runs `normalizeInput` as somebody types, to say what is wrong
 * before they press Enter; the server runs it again on whatever arrives, and
 * stores only what comes out. Trimming, lowercasing an address, capitalizing a
 * name and reducing a web address to its host all happen here, once.
 *
 * Client-safe.
 */

import { z } from "zod";
import { CURRENCIES } from "@polaris/core";
import type { FieldDef, FullName, Money } from "./objects";

/** A value as it is written: a reference is just the id it points at. */
export type InputValue = string | number | boolean | null | Money | FullName;

/** Why a value was refused, as a key under `crm.invalid`. */
export type InvalidReason =
    | "required"
    | "tooLong"
    | "email"
    | "phone"
    | "url"
    | "domain"
    | "number"
    | "wholeNumber"
    | "currency"
    | "date"
    | "option";

export type Normalized =
    | { readonly ok: true; readonly value: InputValue }
    | { readonly ok: false; readonly reason: InvalidReason };

const CURRENCY_CODES: readonly string[] = CURRENCIES.map((entry) => entry.code);

/** The longest text any field keeps. */
export const MAX_TEXT = 500;

/** The largest amount kept, either sign: past this it is a typo. */
const MAX_AMOUNT = 1e15;

const uuid = z.string().uuid();
const email = z.string().email();
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const PHONE = /^\+?[0-9 ().-]{3,40}$/;

const ok = (value: InputValue): Normalized => ({ ok: true, value });
const no = (reason: InvalidReason): Normalized => ({ ok: false, reason });

/** Each word's first letter upper case, the rest as typed ("mcDonald" stays). */
export function capitalizeWords(text: string): string {
    return text.replace(/(^|[\s'-])(\p{Ll})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());
}

/** "https://www.Acme.com/about" -> "acme.com". Not a check: see `normalizeInput`. */
export function hostOf(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .replace(/[/?#].*$/, "")
        .replace(/:\d+$/, "")
        .replace(/^www\./, "")
        .replace(/\.$/, "");
}

/** A web address with its scheme, "linkedin.com/in/x" -> "https://linkedin.com/in/x". */
function withScheme(text: string): string {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
}

/** Whether "YYYY-MM-DD" names a day that exists. */
export function isCalendarDay(text: string): boolean {
    const match = DATE.exec(text);
    if (!match) return false;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
        year >= 1900 &&
        year <= 2999 &&
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

function text(raw: unknown): string | null {
    return typeof raw === "string" ? raw.trim() : null;
}

/**
 * One value for one field, normalized, or why it cannot be kept.
 *
 * An empty value is fine for every field but the record's name: "is empty" is a
 * state a field may be in, not a mistake.
 */
export function normalizeInput(field: FieldDef, raw: unknown): Normalized {
    switch (field.kind) {
        case "text": {
            const value = text(raw);
            if (value === null) return no("required");
            if (field.primary && !value) return no("required");
            return value.length > MAX_TEXT ? no("tooLong") : ok(value);
        }
        case "fullName": {
            const parts = z.object({ first: z.string(), last: z.string() }).safeParse(raw);
            if (!parts.success) return no("required");
            const first = capitalizeWords(parts.data.first.trim());
            const last = capitalizeWords(parts.data.last.trim());
            if (field.primary && !first && !last) return no("required");
            if (first.length > 200 || last.length > 200) return no("tooLong");
            return ok({ first, last });
        }
        case "email": {
            const value = text(raw)?.toLowerCase();
            if (value === undefined) return no("email");
            if (!value) return ok("");
            return value.length <= 254 && email.safeParse(value).success ? ok(value) : no("email");
        }
        case "phone": {
            const value = text(raw);
            if (value === null) return no("phone");
            if (!value) return ok("");
            return PHONE.test(value) ? ok(value.replace(/\s+/g, " ")) : no("phone");
        }
        case "url": {
            const value = text(raw);
            if (value === null) return no("url");
            if (!value) return ok("");
            try {
                const url = new URL(withScheme(value));
                if (url.protocol !== "https:" && url.protocol !== "http:") return no("url");
                if (!HOST.test(url.hostname.toLowerCase())) return no("url");
                return url.href.length > MAX_TEXT ? no("tooLong") : ok(url.href);
            } catch {
                return no("url");
            }
        }
        case "domain": {
            const value = text(raw);
            if (value === null) return no("domain");
            if (!value) return ok("");
            const host = hostOf(value);
            return HOST.test(host) ? ok(host) : no("domain");
        }
        case "number": {
            if (raw === null || raw === "") return ok(null);
            const value = typeof raw === "string" ? Number(raw.trim()) : raw;
            if (typeof value !== "number" || !Number.isFinite(value)) return no("number");
            if (!Number.isInteger(value) || value < 0 || value > 2_000_000_000) {
                return no("wholeNumber");
            }
            return ok(value);
        }
        case "currency": {
            const money = z
                .object({ amount: z.number().nullable(), currency: z.string() })
                .safeParse(raw);
            if (!money.success) return no("number");
            const { amount, currency } = money.data;
            if (amount === null) return ok({ amount: null, currency: "" });
            if (!Number.isFinite(amount) || Math.abs(amount) >= MAX_AMOUNT) return no("number");
            if (!CURRENCY_CODES.includes(currency)) return no("currency");
            return ok({ amount: Math.round(amount * 100) / 100, currency });
        }
        case "date": {
            if (raw === null || raw === "") return ok(null);
            const value = text(raw);
            return value && isCalendarDay(value) ? ok(value) : no("date");
        }
        case "select": {
            const value = text(raw);
            return value !== null && field.options?.includes(value) ? ok(value) : no("option");
        }
        case "boolean":
            return typeof raw === "boolean" ? ok(raw) : no("option");
        case "member":
        case "relation":
            if (raw === null || raw === "") return ok(null);
            return typeof raw === "string" && uuid.safeParse(raw).success ? ok(raw) : no("option");
        case "dateTime":
            return no("option");
    }
}

/** An amount as a person types it, in their language's punctuation, read back:
 *  "1.234,5" and "1,234.5" are both 1234.5. Null when it is not a number. */
export function parseAmount(typed: string): number | null {
    const compact = typed.replace(/[\s '_]/g, "").replace(/[^\d.,-]/g, "");
    if (!/\d/.test(compact)) return null;
    const lastDot = compact.lastIndexOf(".");
    const lastComma = compact.lastIndexOf(",");
    const decimalAt = Math.max(lastDot, lastComma);
    // One separator followed by exactly three digits reads as grouping: "1,500".
    const separators = (compact.match(/[.,]/g) ?? []).length;
    const tail = compact.length - decimalAt - 1;
    const grouped = decimalAt >= 0 && separators === 1 && tail === 3;
    const normalized =
        decimalAt < 0 || grouped
            ? compact.replace(/[.,]/g, "")
            : compact
                  .slice(0, decimalAt)
                  .replace(/[.,]/g, "")
                  .concat(".", compact.slice(decimalAt + 1).replace(/[.,]/g, ""));
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
}

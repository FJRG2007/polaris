/**
 * How a value reads in a cell, in the reader's language and the house formats
 * (`useDisplayFormat`). Pure, so a cell, a total and an export agree.
 *
 * Client-safe.
 */

import type { DisplayFormat } from "@polaris/core";
import type { FieldDef, FieldValue, Money } from "../model/objects";

/** An amount in its own currency: "1.200,00 EUR" reads "1.200,00 €" in Spanish. */
export function formatMoney(money: Money, locale: string): string {
    if (money.amount === null) return "";
    try {
        return new Intl.NumberFormat(locale, {
            style: "currency",
            currency: money.currency || "EUR",
            maximumFractionDigits: 2
        }).format(money.amount);
    } catch {
        return `${money.amount} ${money.currency}`;
    }
}

/**
 * A stored day ("2026-10-09") in the reader's date order. Formatted from its
 * parts rather than through a Date, which would move it a day in any zone west
 * of UTC.
 */
export function formatDay(day: string, format: DisplayFormat): string {
    const [year = "", month = "", date = ""] = day.split("-");
    const shown = format.preferences.yearFormat === "yy" ? year.slice(2) : year;
    return format.preferences.dateOrder === "mdy"
        ? `${month}/${date}/${shown}`
        : `${date}/${month}/${shown}`;
}

/** What a currency is called in the reader's language: "US dollar", "dólar estadounidense". */
export function currencyName(code: string, locale: string): string {
    try {
        return new Intl.DisplayNames([locale], { type: "currency" }).of(code) ?? code;
    } catch {
        return code;
    }
}

/**
 * A value as one line of text: what a cell shows, what an export writes, what
 * the search over a picker reads. Booleans and options are words, which the
 * caller translates, so they come back as their stored form here.
 */
export function plainText(
    field: FieldDef,
    value: FieldValue | undefined,
    format: DisplayFormat,
    locale: string
): string {
    if (value === null || value === undefined) return "";
    switch (field.kind) {
        case "fullName": {
            const name = value as { first: string; last: string };
            return [name.first, name.last].filter(Boolean).join(" ");
        }
        case "currency":
            return formatMoney(value as Money, locale);
        case "number":
            return format.number(value as number);
        case "date":
            return formatDay(value as string, format);
        case "dateTime":
            return format.dateTime(value as string);
        case "member":
        case "relation":
            return (value as { name: string }).name;
        default:
            return String(value);
    }
}

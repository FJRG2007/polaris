/**
 * What an operator charges for, and what an organization is willing to spend.
 *
 * Nobody pays Polaris. What this is for is the operator of an instance who
 * charges the teams on it back, or who wants to know what a project costs to
 * keep running - so the prices are theirs, written in the currency they bill
 * in, and nothing here ever makes one up. An instance that has set none shows
 * usage without money.
 *
 * Every amount a person types goes through `normalizeAmount` first, on the
 * screen and on the server alike, so "0,012" and "0.012" are the same price and
 * a field that says it is fine as somebody types is fine when it is saved.
 */

import { z } from "zod";
import { AUDIT_EXPORT_FORMATS } from "./audit.js";
import { CURRENCIES, type CurrencyCode } from "./display.js";

/** The currencies a price can be set in: the same fixed ISO 4217 list amounts are
 *  displayed in everywhere else, so a statement never needs a symbol nobody drew. */
export const BILLING_CURRENCIES = CURRENCIES;

const CURRENCY_CODES = CURRENCIES.map((entry) => entry.code) as [CurrencyCode, ...CurrencyCode[]];

/** Whether a string is one of the offered currency codes. */
export function isBillingCurrency(value: unknown): value is CurrencyCode {
    return typeof value === "string" && (CURRENCY_CODES as readonly string[]).includes(value);
}

/** The most a single price or budget may be. Far past anything real, and low
 *  enough that a total of every project on an instance stays an exact number. */
export const BILLING_AMOUNT_MAX = 1_000_000_000;

/** A plain decimal: digits, and at most six after the point. Six because a price
 *  per vCPU-hour is routinely a fraction of a cent. */
const AMOUNT_PATTERN = /^\d{1,10}(\.\d{1,6})?$/;

/**
 * An amount as somebody typed it, in the one form it is checked and stored in.
 *
 * Spaces and underscores are digit grouping, and go. A comma is the decimal
 * separator when it is the only mark in the number ("12,5") and grouping when a
 * point is there as well ("1,250.00"). Nothing else is changed: a value that is
 * still not a number after this is refused, not repaired.
 */
export function normalizeAmount(raw: string): string {
    const compact = raw.trim().replace(/[\s_]/g, "");
    if (compact.includes(".")) return compact.replace(/,/g, "");
    return compact.replace(",", ".");
}

/** A price field: empty means "not charged", anything else a non-negative amount. */
const priceField = z
    .string()
    .max(40, "Enter an amount like 0.012")
    .transform(normalizeAmount)
    .refine((value) => value === "" || AMOUNT_PATTERN.test(value), "Enter an amount like 0.012")
    .transform((value) => (value === "" ? null : Number(value)))
    .refine((value) => value === null || value <= BILLING_AMOUNT_MAX, "That is more than Polaris can price");

/** The prices, one per thing that is measured. Each is in `currency`. */
export interface BillingRates {
    readonly currency: CurrencyCode;
    /** Per vCPU-hour: one core busy for one hour. */
    readonly cpuHour: number | null;
    /** Per GB of memory held for one hour. */
    readonly memoryGbHour: number | null;
    /** Per GB kept on a volume for a whole month. */
    readonly storageGbMonth: number | null;
    /** Per GB sent out by a service. */
    readonly egressGb: number | null;
}

/** The keys of the four prices, in the order the screen lists them. */
export const BILLING_RATE_KEYS = ["cpuHour", "memoryGbHour", "storageGbMonth", "egressGb"] as const;
export type BillingRateKey = (typeof BILLING_RATE_KEYS)[number];

/** What each price is called, and the unit it is per. */
export const BILLING_RATE_LABELS: Record<BillingRateKey, { label: string; unit: string }> = {
    cpuHour: { label: "CPU", unit: "per vCPU-hour" },
    memoryGbHour: { label: "Memory", unit: "per GB-hour" },
    storageGbMonth: { label: "Storage", unit: "per GB-month" },
    egressGb: { label: "Network out", unit: "per GB" }
};

/**
 * The prices as the form sends them: strings, straight from the fields.
 *
 * At least one price has to be set. Saving four blanks would be a rate card that
 * charges nothing, which reads on every statement as "this costs 0.00" - an
 * invented price in exactly the sense this module refuses. Clearing the prices
 * is its own action.
 */
export const billingRatesInputSchema = z
    .object({
        currency: z.enum(CURRENCY_CODES, { message: "Pick a currency" }),
        cpuHour: priceField,
        memoryGbHour: priceField,
        storageGbMonth: priceField,
        egressGb: priceField
    })
    .refine((rates) => BILLING_RATE_KEYS.some((key) => rates[key] !== null), {
        message: "Set at least one price",
        path: ["cpuHour"]
    });

export type BillingRatesInput = z.input<typeof billingRatesInputSchema>;

const storedRatesSchema = z.object({
    currency: z.enum(CURRENCY_CODES),
    cpuHour: z.number().nonnegative().max(BILLING_AMOUNT_MAX).nullable(),
    memoryGbHour: z.number().nonnegative().max(BILLING_AMOUNT_MAX).nullable(),
    storageGbMonth: z.number().nonnegative().max(BILLING_AMOUNT_MAX).nullable(),
    egressGb: z.number().nonnegative().max(BILLING_AMOUNT_MAX).nullable()
});

/**
 * The stored prices, or null when there are none.
 *
 * Null is also what anything unreadable becomes: a setting written by hand or by
 * a later build must leave the statements showing usage without money, never a
 * price nobody set.
 */
export function storedBillingRates(raw: string | null | undefined): BillingRates | null {
    if (!raw) return null;
    try {
        const parsed = storedRatesSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return null;
        return BILLING_RATE_KEYS.some((key) => parsed.data[key] !== null) ? parsed.data : null;
    } catch {
        return null;
    }
}

/** A monthly budget as it is typed: an amount above zero, in the prices' currency. */
export const orgBudgetInputSchema = z.object({
    amount: z
        .string()
        .max(40, "Enter an amount like 250")
        .transform(normalizeAmount)
        .refine((value) => value !== "", "Enter an amount")
        .refine((value) => value === "" || AMOUNT_PATTERN.test(value), "Enter an amount like 250")
        .transform(Number)
        .refine((value) => value > 0, "A budget has to be more than zero")
        .refine((value) => value <= BILLING_AMOUNT_MAX, "That is more than Polaris can track")
});

export type OrgBudgetInput = z.input<typeof orgBudgetInputSchema>;

/** A calendar month, "2026-09". Months run on UTC, like the hourly figures they
 *  are added up from. */
export const BILLING_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const billingMonthField = z
    .string()
    .trim()
    .regex(BILLING_MONTH_PATTERN, "Pick a month");

/** What a statement read asks for: a month, or this one when none is given. */
export const billingStatementQuerySchema = z.object({
    month: billingMonthField.optional()
});

/** What an export asks for: the month, and the file it is wanted as. */
export const billingExportQuerySchema = z.object({
    month: billingMonthField.optional(),
    format: z.enum(AUDIT_EXPORT_FORMATS).default("csv")
});

export type BillingExportQuery = z.infer<typeof billingExportQuerySchema>;

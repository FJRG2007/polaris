/**
 * A connection's exception to the account's network rules: the countries,
 * continents and addresses one connected assistant may call from even where the
 * rules an administrator imposed on the account refuse.
 *
 * For an assistant that calls from its own servers - ChatGPT calls from
 * OpenAI's, in the United States - while the person, their sessions, their keys
 * and every other connection stay held to the rules. It only ever lets a refused
 * call through; it never refuses one, and the connection's own address rule
 * (ip-policy.ts) still applies after it.
 *
 * Unlike an allowlist, where every dimension must pass, an exception admits a
 * call that matches any one of its entries. A country is matched only when the
 * address resolved to it: an exception widens a rule, so an unknown location
 * never counts as a match.
 *
 * Pure, so the MCP endpoint and the tests share one answer.
 */

import { z } from "zod";
import { CONTINENTS, COUNTRY_CODES, ipAllowed, ipRuleField, isIpAddress } from "@polaris/core";

/** Published address lists an exception can name instead of typing them. */
export const EXCEPTION_PRESETS = ["openai"] as const;
export type ExceptionPreset = (typeof EXCEPTION_PRESETS)[number];

/** More than anybody types by hand, few enough to check on every call. */
export const EXCEPTION_LIST_MAX = 50;

const COUNTRIES = new Set(COUNTRY_CODES);
const CONTINENT_CODES = new Set(CONTINENTS.map((entry) => entry.code));

/** A list of known codes, trimmed and upper-cased first; an unknown one is
 *  refused rather than dropped. */
const codeList = (known: ReadonlySet<string>) =>
    z
        .array(
            z
                .string()
                .max(8)
                .transform((value) => value.trim().toUpperCase())
                .refine((value) => known.has(value), "Unknown place")
        )
        .max(EXCEPTION_LIST_MAX)
        .default([])
        .transform((values) => [...new Set(values)]);

export const networkExceptionSchema = z.object({
    allowedCountries: codeList(COUNTRIES),
    allowedContinents: codeList(CONTINENT_CODES),
    allowedCidrs: z.array(ipRuleField).max(EXCEPTION_LIST_MAX).default([]),
    presets: z
        .array(z.enum(EXCEPTION_PRESETS))
        .max(EXCEPTION_PRESETS.length)
        .default([])
        .transform((values) => [...new Set(values)])
});

export type NetworkException = z.infer<typeof networkExceptionSchema>;

export const NO_EXCEPTION: NetworkException = {
    allowedCountries: [],
    allowedContinents: [],
    allowedCidrs: [],
    presets: []
};

/** True when the exception lets nothing through. */
export function exceptionIsEmpty(exception: NetworkException): boolean {
    return (
        exception.allowedCountries.length === 0 &&
        exception.allowedContinents.length === 0 &&
        exception.allowedCidrs.length === 0 &&
        exception.presets.length === 0
    );
}

/** A stored exception, or none for a column that is empty or unreadable - an
 *  unreadable exception must never let anything through. */
export function readNetworkException(stored: string | null | undefined): NetworkException {
    if (!stored) return NO_EXCEPTION;
    try {
        const parsed = networkExceptionSchema.safeParse(JSON.parse(stored));
        return parsed.success ? parsed.data : NO_EXCEPTION;
    } catch {
        return NO_EXCEPTION;
    }
}

/** What goes in the column: null for no exception at all. */
export function storedNetworkException(exception: NetworkException): string | null {
    return exceptionIsEmpty(exception) ? null : JSON.stringify(exception);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && [...a].sort().join(" ") === [...b].sort().join(" ");
}

export function sameException(a: NetworkException, b: NetworkException): boolean {
    return (
        sameList(a.allowedCountries, b.allowedCountries) &&
        sameList(a.allowedContinents, b.allowedContinents) &&
        sameList(a.allowedCidrs, b.allowedCidrs) &&
        sameList(a.presets, b.presets)
    );
}

/** Whether `after` lets through nothing `before` did not. */
export function exceptionNarrows(before: NetworkException, after: NetworkException): boolean {
    const within = (next: readonly string[], prior: readonly string[]) => {
        const set = new Set(prior);
        return next.every((entry) => set.has(entry));
    };
    return (
        within(after.allowedCountries, before.allowedCountries) &&
        within(after.allowedContinents, before.allowedContinents) &&
        within(after.allowedCidrs, before.allowedCidrs) &&
        within(after.presets, before.presets)
    );
}

export interface ExceptionContext {
    /** Where the address resolved to; null when unknown. */
    readonly country: () => Promise<string | null>;
    /** The ranges a preset names right now. */
    readonly presetRanges: (preset: ExceptionPreset) => Promise<readonly string[]>;
    /** The continent a country is on. */
    readonly continentOf: (country: string) => string | null;
}

/** Whether a call from `ip` matches the exception. No address never matches. */
export async function exceptionAllows(
    exception: NetworkException,
    ip: string | undefined,
    context: ExceptionContext
): Promise<boolean> {
    if (exceptionIsEmpty(exception) || !ip || !isIpAddress(ip)) return false;
    const address = ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
    if (exception.allowedCidrs.length > 0 && ipAllowed(address, exception.allowedCidrs))
        return true;
    for (const preset of exception.presets) {
        const ranges = await context.presetRanges(preset);
        if (ranges.length > 0 && ipAllowed(address, ranges)) return true;
    }
    if (exception.allowedCountries.length === 0 && exception.allowedContinents.length === 0) {
        return false;
    }
    const country = (await context.country())?.toUpperCase() ?? null;
    if (!country) return false;
    if (exception.allowedCountries.includes(country)) return true;
    const continent = context.continentOf(country);
    return continent !== null && exception.allowedContinents.includes(continent);
}

/**
 * The rules every public link in Polaris can be narrowed by, as one set of
 * fields.
 *
 * A share, a drop point and a snippet all offer the same three allowlists, and
 * before this they each declared them: three regexes for a country code, three
 * definitions of what counts as an address. A rule that is malformed fails
 * closed - it locks out everyone the link was for - so all of them have to reject
 * a bad entry at save time, which is exactly the kind of agreement that stops
 * being true the moment it is written down three times.
 *
 * The guards that ENFORCE these at request time live server-side in
 * lib/link-guards; this is only what may be saved.
 */

import { z } from "zod";
import { isCidr, isIpAddress } from "../cidr.js";
import { EVERY_DAY, MINUTES_IN_DAY } from "./presence-schedule.js";

/** An IP address or a CIDR range. */
export const cidrOrIp = z
    .string()
    .trim()
    .refine((value) => isCidr(value) || isIpAddress(value), {
        message: "Must be an IP address or CIDR range"
    });

/** An ISO-3166 alpha-2 country code, or a continent code (AF/AS/EU/NA/SA/OC/AN),
 *  which share a shape. */
export const regionCode = z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/);

/**
 * People named the way people name each other - a username or an address, not an
 * id - lowercased with any leading "@" removed and deduplicated.
 *
 * Every link that narrows to named accounts stores identities rather than ids,
 * because an address with no account behind it yet is still a valid thing to
 * type where a field invites somebody. One identity typed two ways has to be one
 * person on all of them, which is what this normalization is for.
 */
export const accountIdentityList = z
    .array(z.string().trim().toLowerCase())
    .transform((values) =>
        Array.from(new Set(values.map((value) => value.replace(/^@+/, "")).filter(Boolean)))
    );

/**
 * The three allowlists, ready to spread into a link's own schema. Each empty by
 * default, which every enforcement path reads as "no restriction" - a link is
 * open to whoever holds it until its owner says otherwise.
 */
export const addressRuleFields = {
    /** IP/CIDR allowlist. Empty means no address restriction. */
    allowedCidrs: z.array(cidrOrIp).default([]),
    /** ISO-3166 alpha-2 country allowlist. Empty means no country restriction. */
    allowedCountries: z.array(regionCode).default([]),
    /** Continent-code allowlist. Empty means no continent restriction. */
    allowedContinents: z.array(regionCode).default([])
} as const;

/** Whether a name is an IANA time zone this runtime can read a clock in. */
function isTimeZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/** Minutes past midnight, or null for "no bound". */
const dayMinute = z
    .number()
    .int()
    .min(0)
    .max(MINUTES_IN_DAY - 1)
    .nullable();

/**
 * The part of the week a link opens in: days as the presence-schedule bitmask
 * (bit 0 Sunday), hours as minutes past midnight in `timeZone`. Both hours null
 * is the whole of each named day; an end before the start crosses midnight.
 * The same shape and rules a grant's schedule follows.
 */
export const linkScheduleSchema = z
    .object({
        days: z.number().int().min(1).max(EVERY_DAY),
        startMinute: dayMinute,
        endMinute: dayMinute,
        timeZone: z.string().trim().min(1).max(64).refine(isTimeZone, {
            message: "Pick a time zone from the list"
        })
    })
    .refine((schedule) => (schedule.startMinute === null) === (schedule.endMinute === null), {
        message: "Give the hours a start and an end, or neither",
        path: ["endMinute"]
    })
    .refine(
        (schedule) => schedule.startMinute === null || schedule.startMinute !== schedule.endMinute,
        { message: "Give it a start and an end that differ", path: ["endMinute"] }
    );

export type LinkSchedule = z.infer<typeof linkScheduleSchema>;

/**
 * Who may open a link and from when, beyond the address rules: a first moment,
 * a weekly window, "only somebody with an account here", and named accounts.
 * All absent or empty by default, which every enforcement path reads as no
 * restriction. A list of named accounts implies sign-in wherever it is checked.
 */
export const linkPeopleFields = {
    startsAt: z.coerce.date().nullable().default(null),
    schedule: linkScheduleSchema.nullable().default(null),
    requireLogin: z.boolean().default(false),
    allowedUsers: accountIdentityList.pipe(z.array(z.string().min(1).max(320)).max(200)).default([])
} as const;

/**
 * A link's limits saved whole: the password, start, expiry, weekly window, cap
 * on opens, the address rules and the account rules every public link in
 * Polaris offers. Absent or empty is no
 * restriction.
 */
export const linkLimitsSchema = z.object({
    /** Stored as a hash, never in the clear. Absent keeps the current one. */
    password: z.string().min(1).max(256).optional(),
    /** Sent to take a password off a link that had one. */
    clearPassword: z.boolean().default(false),
    maxViews: z.number().int().positive().max(1_000_000).nullable().default(null),
    expiresAt: z.coerce.date().nullable().default(null),
    ...addressRuleFields,
    ...linkPeopleFields
});

export type LinkLimitsInput = z.infer<typeof linkLimitsSchema>;

/** The same three, all optional, for an update that only sends what changed. */
export const addressRuleUpdateFields = {
    allowedCidrs: z.array(cidrOrIp).optional(),
    allowedCountries: z.array(regionCode).optional(),
    allowedContinents: z.array(regionCode).optional()
} as const;

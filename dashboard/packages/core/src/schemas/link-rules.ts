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

/** The same three, all optional, for an update that only sends what changed. */
export const addressRuleUpdateFields = {
    allowedCidrs: z.array(cidrOrIp).optional(),
    allowedCountries: z.array(regionCode).optional(),
    allowedContinents: z.array(regionCode).optional()
} as const;

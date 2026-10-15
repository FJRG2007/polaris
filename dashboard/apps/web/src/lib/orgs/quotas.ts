/**
 * What an organization may hold: the dimensions a platform administrator can cap,
 * the schema a cap is saved with, and the arithmetic that decides whether one
 * more fits.
 *
 * Pure and client-safe: the Limits screen checks a draft against the same schema
 * the server saves with. The reads and the refusals live in `quota-service.ts`.
 *
 * A cap of null is no cap. That is what every organization has until somebody
 * sets one, so an organization that existed before quotas keeps working exactly
 * as it did. Zero is a real cap - "none of these here" - which is why an empty
 * field, not a zero, is how a cap is taken off.
 */

import { z } from "zod";

/** Things an organization holds a number of. */
export const ORG_QUOTA_COUNTS = ["members", "teams", "projects", "services", "databases"] as const;
/** Things the services and databases it runs reserve, summed over their limits. */
export const ORG_QUOTA_RESERVATIONS = ["cpus", "memoryMb"] as const;
export const ORG_QUOTA_DIMENSIONS = [...ORG_QUOTA_COUNTS, ...ORG_QUOTA_RESERVATIONS] as const;

export type OrgQuotaCount = (typeof ORG_QUOTA_COUNTS)[number];
export type OrgQuotaReservation = (typeof ORG_QUOTA_RESERVATIONS)[number];
export type OrgQuotaDimension = (typeof ORG_QUOTA_DIMENSIONS)[number];

export type OrgQuotaLimits = Record<OrgQuotaDimension, number | null>;
export type OrgQuotaUsage = Record<OrgQuotaDimension, number>;

export const NO_ORG_QUOTA: OrgQuotaLimits = {
    members: null,
    teams: null,
    projects: null,
    services: null,
    databases: null,
    cpus: null,
    memoryMb: null
};

/** A form sends strings and an empty one means "no cap"; anything else is a number. */
function blankIsNull(value: unknown): unknown {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed === "" ? null : Number(trimmed);
    }
    return value;
}

const countCap = (min: number) =>
    z.preprocess(blankIsNull, z.number({ message: "quotas.issues.number" }).int("quotas.issues.whole").min(min, "quotas.issues.tooSmall").max(100_000, "quotas.issues.tooLarge").nullable());

export const orgQuotaInputSchema = z.object({
    // The owner is always on the roster, so a roster cap below one could never be met.
    members: countCap(1),
    teams: countCap(0),
    projects: countCap(0),
    services: countCap(0),
    databases: countCap(0),
    cpus: z.preprocess(
        blankIsNull,
        z
            .number({ message: "quotas.issues.number" })
            .min(0, "quotas.issues.tooSmall")
            .max(4096, "quotas.issues.tooLarge")
            .transform((value) => Math.round(value * 100) / 100)
            .nullable()
    ),
    memoryMb: z.preprocess(blankIsNull, z.number({ message: "quotas.issues.number" }).int("quotas.issues.whole").min(0, "quotas.issues.tooSmall").max(16_777_216, "quotas.issues.tooLarge").nullable())
});

export type OrgQuotaInput = z.infer<typeof orgQuotaInputSchema>;

/**
 * The cap that actually applies when the instance has one of its own as well.
 * The instance's uses zero for "none" (its field predates this); the tighter of
 * the two wins, and `source` says whose it is so a refusal can name the right one.
 */
export function effectiveCap(
    instanceCap: number,
    orgCap: number | null
): { limit: number | null; source: "org" | "instance" | null } {
    const instance = instanceCap > 0 ? instanceCap : null;
    if (orgCap === null && instance === null) return { limit: null, source: null };
    if (orgCap === null) return { limit: instance, source: "instance" };
    if (instance === null || orgCap <= instance) return { limit: orgCap, source: "org" };
    return { limit: instance, source: "instance" };
}

/** True when one more fits under the cap. */
export function roomForOne(limit: number | null, current: number): boolean {
    return limit === null || current < limit;
}

/**
 * True when a reservation may change from `previous` to `next`, with `others`
 * already reserved by everything else. Shrinking is always allowed, so an
 * organization already past its cap can still come back under it.
 */
export function roomForReservation(limit: number | null, others: number, previous: number, next: number): boolean {
    if (limit === null || next <= previous) return true;
    // Cores are fractional; a sum of 0.1s must not refuse an exact fit.
    return others + next <= limit + 1e-9;
}

/** What one service or database reserves: its limit times the copies it runs. */
export function reservationOf(limit: number | null | undefined, copies: number): number {
    return limit ? limit * Math.max(1, copies) : 0;
}

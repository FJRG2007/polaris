/**
 * Whether this Polaris takes domains people bring themselves, and how many.
 *
 * Split from `owner-domains` because the screen that edits it runs in the
 * browser, and that module reaches for Prisma, node:dns and - through the network
 * helpers - the SSH stack. Importing any of it from a client component drags all
 * of that into the bundle and the build stops. So the vocabulary and the shape a
 * write has to arrive in live here, where both sides can read them, and the I/O
 * stays over there.
 *
 * Pure, so the form validates against exactly what the server does.
 */

import { z } from "zod";

/** Who may bring a domain of their own. `off` removes the feature rather than
 *  leaving it in the navigation doing nothing. */
export const OWNER_DOMAIN_MODES = ["everyone", "admins", "off"] as const;
export type OwnerDomainMode = (typeof OWNER_DOMAIN_MODES)[number];

export const OWNER_DOMAIN_LABELS: Record<OwnerDomainMode, string> = {
    everyone: "Anyone with an account",
    admins: "Administrators only",
    off: "Nobody"
};

export const OWNER_DOMAIN_HINTS: Record<OwnerDomainMode, string> = {
    everyone: "Accounts and organizations can add a domain they own and deploy on it.",
    admins: "Only administrators can. Everybody else deploys on this Polaris's own domains.",
    off: "Domains already added keep working; no new ones can be added."
};

export const ownerDomainPolicySchema = z.object({
    mode: z.enum(OWNER_DOMAIN_MODES).default("everyone"),
    /** How many domains one account or one organization may hold. Zero is no cap,
     *  matching every other limit in Polaris - the field is a number input, and an
     *  empty one has to mean unlimited rather than none-allowed. */
    maxPerOwner: z.coerce.number().int().min(0).max(1000).default(0)
});

export type OwnerDomainPolicy = z.infer<typeof ownerDomainPolicySchema>;

/** What an instance does before anybody has said otherwise: the feature is
 *  available and uncapped, which is what somebody who has just read about it
 *  expects, and both limits are one setting away. */
export const OWNER_DOMAIN_POLICY_DEFAULTS: OwnerDomainPolicy = ownerDomainPolicySchema.parse({});

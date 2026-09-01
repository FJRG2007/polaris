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

/**
 * Whether what has been typed so far is a domain at all, and why not.
 *
 * The Add button used to come alive on the first keystroke, so a single letter
 * looked like something Polaris would accept - and pressing it spent a round
 * trip to be told no by the schema. A control that offers itself for input it is
 * going to refuse is a control that has to be tried before it can be understood.
 *
 * Written here rather than reached for from `@polaris/deploy`, which owns the
 * same pattern: that package pulls in node:crypto and the SSH stack the moment
 * it is imported, and this module exists to be read by a form running in a
 * browser. The pattern is small and stated in both places on purpose - see
 * `bareDomain` below, which is inlined for the same reason.
 *
 * Silent on an empty field. Nothing has been typed, so there is nothing to be
 * wrong about, and a form that scolds somebody before they start is worse than
 * one that waits.
 */
export function domainProblem(value: string): string | null {
    const wanted = bareDomain(value);
    if (!wanted) return null;
    // A name that reached this pattern is well formed, but four groups of digits
    // is well formed too and is an address: nothing can publish a TXT record
    // under it, so a claim on one would sit here unverifiable forever while
    // looking like a claim somebody made. Named separately because the sentence
    // has to say which of the two it is.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(wanted)) return "That is an address, not a domain";
    if (!wanted.includes(".")) return "A domain needs a suffix, like example.com";
    if (!DOMAIN_PATTERN.test(wanted)) return "Enter a domain like example.com";
    // The last label is the suffix, and it is the one part that cannot be
    // digits or a single letter. `example.c` and `example.1` both pass the
    // pattern above and neither is a name anybody can hold.
    const suffix = wanted.slice(wanted.lastIndexOf(".") + 1);
    if (suffix.length < 2 || !/^[a-z]+$/.test(suffix)) return "That suffix is not a real one";
    // RFC 1035, and the reason a domain cannot be arbitrarily long.
    if (wanted.length > 253) return "That domain is too long";
    return null;
}

/** A registrable domain: two or more labels, no wildcard, no scheme. The same
 *  pattern `@polaris/deploy` applies on the server. */
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Whether a domain somebody wants to claim collides with one this Polaris itself
 * occupies.
 *
 * The dangerous shape is a claim on the *parent* of an instance hostname: an
 * account claiming `example.com` while the dashboard answers on
 * `polaris.example.com` would be proving ownership of the name Polaris is reached
 * on, and then be issued certificates for hostnames under it. A claim on the
 * instance's own name, or on something beneath it, is the same problem in the
 * other direction - Polaris mints hostnames there itself, and two writers of the
 * same zone is a collision waiting for the first deploy.
 *
 * Pure, so the form refuses as the domain is typed and the service refuses the
 * same input for the same reason.
 */
export function instanceDomainConflict(candidate: string, instanceHosts: readonly string[]): string | null {
    const wanted = bareDomain(candidate);
    if (!wanted) return null;
    for (const raw of instanceHosts) {
        const host = bareDomain(raw);
        if (!host) continue;
        if (wanted === host) return `${host} is this Polaris's own domain`;
        // The claim covers a name Polaris answers on.
        if (host.endsWith(`.${wanted}`)) return `This Polaris answers on ${host}, so ${wanted} is not yours to claim`;
        // The claim sits inside a zone Polaris already mints hostnames in.
        if (wanted.endsWith(`.${host}`)) return `${wanted} is part of this Polaris's own domain`;
    }
    return null;
}

/** A typed domain as the bare name to compare: no scheme, no wildcard, no port,
 *  no path, no trailing dot.
 *
 *  The same shape `normalizeBaseDomain` produces, written out here rather than
 *  imported: this module is read by the browser, and the package that owns that
 *  helper reaches for node:crypto, which a client bundle cannot follow. */
function bareDomain(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .replace(/^\*\./, "")
        .replace(/[/?#].*$/, "")
        .replace(/:\d+$/, "")
        .replace(/\.+$/, "");
}

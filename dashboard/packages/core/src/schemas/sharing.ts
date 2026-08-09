/**
 * What this instance lets people hand out to each other.
 *
 * Polaris has no public registration: every account comes from an administrator's
 * invite. That is a deliberate posture, and sharing a server with somebody must
 * not quietly undo it - so a non-administrator giving somebody access is one
 * setting, and a non-administrator creating an account to give it to is another,
 * stricter one.
 *
 * The default is the strict end: an administrator gives out access, and loosening
 * that is a decision somebody makes on purpose rather than one an instance starts
 * out having made.
 */

import { z } from "zod";
import { PERMISSIONS } from "../permissions.js";
import { RESOURCE_KINDS } from "../resources.js";

/**
 * How far somebody who is not an administrator may go when sharing.
 *
 *  - `off`: only an administrator gives access to anything.
 *  - `existing`: the owner of a thing may share it with accounts that exist.
 *  - `invite`: the same, and they may also invite an address that has none.
 */
export const DELEGATED_SHARING_MODES = ["off", "existing", "invite"] as const;

export type DelegatedSharingMode = (typeof DELEGATED_SHARING_MODES)[number];

export const DELEGATED_SHARING_LABELS: Readonly<Record<DelegatedSharingMode, string>> = {
    off: "Administrators only",
    existing: "Owners can share with existing accounts",
    invite: "Owners can invite by email"
};

export const DELEGATED_SHARING_HINTS: Readonly<Record<DelegatedSharingMode, string>> = {
    off: "Only an administrator gives anybody access to anything.",
    existing: "Somebody who runs a server can give access to people who already have an account here.",
    invite: "The same, and they can send an invite to an address with no account yet."
};

export const sharingPolicySchema = z.object({
    delegated: z.enum(DELEGATED_SHARING_MODES).default("off"),
    /** The role an account made this way is created with. `guest` grants nothing
     *  on its own, which is the point: what the account reaches is the one thing
     *  it was invited to. */
    inviteRole: z.string().trim().min(1).max(32).default("guest"),
    /** How long a delegated invite stays claimable. */
    inviteDays: z.coerce.number().int().min(1).max(30).default(7)
});

export type SharingPolicy = z.infer<typeof sharingPolicySchema>;

/** What an instance does before anybody has said otherwise. */
export const SHARING_POLICY_DEFAULTS: SharingPolicy = sharingPolicySchema.parse({});

/** Whether this mode lets a non-administrator create an account to share with. */
export function mayInviteStrangers(policy: SharingPolicy): boolean {
    return policy.delegated === "invite";
}

/** Whether this mode lets a non-administrator share with anybody at all. */
export function mayShareAtAll(policy: SharingPolicy): boolean {
    return policy.delegated !== "off";
}

/**
 * The access an invite promises, carried on the invite until it is claimed.
 *
 * Stored as JSON on the row, so it is validated on the way in AND on the way out:
 * a hand-edited or half-written value has to grant nothing rather than something
 * nobody chose. What it says is still only an intention - the claim resolves it
 * again against what the inviter holds at that moment.
 */
export const pendingGrantSchema = z.object({
    resourceKind: z.enum(RESOURCE_KINDS),
    resourceId: z.string().trim().min(1).max(200),
    actions: z.array(z.enum(PERMISSIONS)).min(1).max(PERMISSIONS.length),
    canShare: z.boolean().default(false),
    /** ISO 8601, or null for no end date. */
    expiresAt: z.string().datetime().nullable().default(null),
    /** Whose reach this was carved out of, and whose it is re-checked against. */
    grantedById: z.string().uuid()
});

export type PendingGrant = z.infer<typeof pendingGrantSchema>;

/** Read a stored pending grant back. Anything unreadable promises nothing. */
export function parsePendingGrant(raw: string | null | undefined): PendingGrant | null {
    if (!raw) return null;
    try {
        const parsed = pendingGrantSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

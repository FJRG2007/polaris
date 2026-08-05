/**
 * Organizations and teams: the vocabulary, the shapes a write has to arrive in,
 * and the instance policy an administrator sets over both.
 *
 * An organization is a group of people that owns work. It is not a second kind
 * of account - nobody signs in as one - so nothing here touches authentication.
 * What it does is answer three questions the server keeps having to ask: who is
 * allowed to run this organization, what a team may reach, and whether this
 * instance offers organizations at all.
 *
 * Pure, so both the browser and the server validate against exactly this.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

/** Long enough for a real company name, short enough to stay a heading. */
export const ORG_NAME_MAX = 60;

/**
 * The handle in a URL. Deliberately the same alphabet and length an account
 * username uses, because the two share a namespace: an organization cannot take
 * a handle somebody already signs in with, and the check that enforces it
 * compares like with like.
 */
export const orgSlugField = z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "At least 3 characters")
    .max(30, "At most 30 characters")
    .regex(/^[a-z0-9_-]+$/, "Use letters, numbers, - or _")
    .refine((value) => !value.startsWith("-") && !value.endsWith("-"), "Cannot start or end with -");

/**
 * A handle suggested from a name, so somebody typing "Acme Design Co." is
 * offered `acme-design-co` rather than an empty field. Only a suggestion: what
 * is stored is whatever they confirm, put through `orgSlugField`.
 */
export function suggestSlug(name: string): string {
    return name
        .normalize("NFKD")
        // Drop the accents NFKD just split off, so "Pena" comes out of "Peña".
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30);
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * What somebody may do across a whole organization. Ordered least to most and
 * compared by index, so a check reads as "at least an admin". The owner is never
 * a member row and outranks both.
 */
export const ORG_ROLES = ["member", "admin"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** The owner sits above every role, exactly as a space owner does. */
export type OrgAccess = OrgRole | "owner";

export const ORG_ROLE_LABELS: Record<OrgRole, string> = {
    member: "Member",
    admin: "Admin"
};

export const ORG_ROLE_HINTS: Record<OrgRole, string> = {
    member: "See the organization and the teams they are on.",
    admin: "Run the roster, the teams and the organization's spaces."
};

export function orgRoleAtLeast(role: OrgAccess, minimum: OrgRole): boolean {
    if (role === "owner") return true;
    return ORG_ROLES.indexOf(role) >= ORG_ROLES.indexOf(minimum);
}

/** What somebody may do inside one team. A maintainer runs that team's roster
 *  without administering the organization around it. */
export const TEAM_ROLES = ["member", "maintainer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
    member: "Member",
    maintainer: "Maintainer"
};

export const TEAM_ROLE_HINTS: Record<TeamRole, string> = {
    member: "Reaches everything the team has been granted.",
    maintainer: "The same, plus adding and removing the team's own people."
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export const organizationSchema = z.object({
    name: z.string().trim().min(1, "Enter a name").max(ORG_NAME_MAX, `At most ${ORG_NAME_MAX} characters`),
    slug: orgSlugField,
    description: z.string().trim().max(500).default("")
});

export type OrganizationInput = z.infer<typeof organizationSchema>;

/** Renaming never moves the handle: links, and anything anybody wrote down,
 *  keep working. Changing a handle is its own deliberate action. */
export const organizationProfileSchema = organizationSchema.omit({ slug: true });

export type OrganizationProfileInput = z.infer<typeof organizationProfileSchema>;

export const teamSchema = z.object({
    name: z.string().trim().min(1, "Enter a name").max(ORG_NAME_MAX, `At most ${ORG_NAME_MAX} characters`),
    slug: orgSlugField,
    description: z.string().trim().max(500).default("")
});

export type TeamInput = z.infer<typeof teamSchema>;

// ---------------------------------------------------------------------------
// Instance policy
// ---------------------------------------------------------------------------

/**
 * Who may create an organization on this instance.
 *
 * `off` is the setting for a deployment that is one household or one team: the
 * whole feature disappears rather than sitting in the navigation doing nothing.
 * Turning it off never deletes anything - organizations that already exist stay
 * reachable and administrable, they just cannot be joined by new ones being
 * made.
 */
export const ORG_CREATION_MODES = ["everyone", "admins", "off"] as const;
export type OrgCreationMode = (typeof ORG_CREATION_MODES)[number];

export const ORG_CREATION_LABELS: Record<OrgCreationMode, string> = {
    everyone: "Anyone with an account",
    admins: "Administrators only",
    off: "Nobody"
};

export const ORG_CREATION_HINTS: Record<OrgCreationMode, string> = {
    everyone: "Everybody signed in can start an organization.",
    admins: "Only administrators can, and they add people to it.",
    off: "Organizations already here keep working; no new ones are made."
};

/** A cap of zero means no cap. Written this way because the field is a number
 *  input, and an empty one has to mean "unlimited" rather than "none allowed". */
const limitField = z.coerce.number().int().min(0).max(100_000).default(0);

export const organizationPolicySchema = z.object({
    creation: z.enum(ORG_CREATION_MODES).default("everyone"),
    /** How many organizations one account may own. Being a member of somebody
     *  else's never counts against this. */
    maxPerUser: limitField,
    /** Roster size, counting the owner. */
    maxMembers: limitField,
    maxTeams: limitField
});

export type OrganizationPolicy = z.infer<typeof organizationPolicySchema>;

/** What an instance does before anybody has said otherwise: organizations are
 *  available and uncapped, which is what somebody enabling teams expects, and
 *  every limit is one setting away. */
export const ORGANIZATION_POLICY_DEFAULTS: OrganizationPolicy = organizationPolicySchema.parse({});

/** True when this cap allows one more. A cap of zero is no cap. */
export function withinLimit(limit: number, current: number): boolean {
    return limit === 0 || current < limit;
}

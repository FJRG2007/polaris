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
import { isReservedUsername, RESERVED_USERNAME_MESSAGE } from "./usernames.js";

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
    .refine((value) => !value.startsWith("-") && !value.endsWith("-"), "Cannot start or end with -")
    // The same names an account cannot take, for the same reason and out of the
    // same list. A handle addresses a public page here whether it belongs to a
    // person or to a company, and `@polaris-support` is exactly as convincing
    // signed by one as by the other.
    .refine((value) => !isReservedUsername(value), RESERVED_USERNAME_MESSAGE);

/**
 * A handle suggested from a name, so somebody typing "Acme Design Co." is
 * offered `acme-design-co` rather than an empty field. Only a suggestion: what
 * is stored is whatever they confirm, put through `orgSlugField`.
 */
export function suggestSlug(name: string): string {
    return (
        name
            .normalize("NFKD")
            // Drop the accents NFKD just split off, so "Pena" comes out of "Peña".
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 30)
    );
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * What somebody may do across a whole organization.
 *
 * Permissions rather than a ladder of role names, for the same reason the
 * instance itself works that way: an organization is a company, a studio or a
 * household, and none of them agree on what "admin" should mean. So a call site
 * asks whether this person may run the roster, and each organization decides for
 * itself which of its roles carries that.
 *
 * Two things are deliberately absent. Handing the organization on and deleting it
 * are not permissions and never will be - they belong to the owner alone, so no
 * role anybody writes can end up able to give the organization away. And there is
 * nothing here about the instance: an organization runs its own work, not the
 * Polaris it happens to live on.
 */
export const ORG_PERMISSIONS = [
    "org.read",
    "people.manage",
    "teams.manage",
    "roles.manage",
    "spaces.manage",
    "deploy.manage",
    "domains.manage",
    "vault.manage",
    // Handing out the organization's mailboxes and taking them back. Reading one
    // is not a permission and cannot be made into one: a mailbox is reached by
    // being the person it was given to, and nothing an organization writes about
    // its own roles changes that.
    "mail.manage",
    // Changing what is in the organization's Drive. Reading it is not a
    // permission and deliberately never was: being on the roster is what lets
    // somebody open the company's shelf, because a permission no existing role
    // holds would be an empty shelf on every organization that already exists.
    "drive.manage",
    "activity.read",
    "settings.manage"
] as const;

export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

/** Held by the seeded admin role, and by nothing a person writes: it means every
 *  permission, including ones a later version of Polaris adds. */
export const ALL_ORG_PERMISSIONS = "*" as const;

export type GrantedOrgPermission = OrgPermission | typeof ALL_ORG_PERMISSIONS;

/** What each permission is called and where it belongs, so the role editor is
 *  grouped the way the organization's own screens are rather than listing keys. */
export const ORG_PERMISSION_META: Readonly<Record<OrgPermission, { area: string; label: string }>> =
    {
        "org.read": { area: "General", label: "See the organization, its people and its teams" },
        "settings.manage": {
            area: "General",
            label: "Change the name, handle, description and photo"
        },
        "activity.read": { area: "General", label: "Read what has been done here" },
        "people.manage": { area: "People", label: "Add and remove people, and set their role" },
        "teams.manage": { area: "People", label: "Create teams and run their rosters" },
        "roles.manage": { area: "People", label: "Define what the organization's roles may do" },
        "spaces.manage": { area: "Work", label: "Create and administer the organization's spaces" },
        "deploy.manage": {
            area: "Work",
            label: "Deploy and configure the organization's services"
        },
        "domains.manage": { area: "Work", label: "Add and verify the organization's domains" },
        // Who is in the shared vault and what is in it. NOT the ability to read what
        // is in it: that needs the organization's key, which only a member somebody
        // has already vouched for holds, and no permission can hand it over.
        "vault.manage": { area: "Work", label: "Run the shared vault's collections and members" },
        // Reading is not here because reading is not a permission: every member
        // opens the organization's files. This is being able to change them.
        "drive.manage": { area: "Work", label: "Add to and change the organization's files" },
        // Giving somebody the company address or the support mailbox, and taking
        // it back when they leave. Never reading what is in one.
        "mail.manage": { area: "Work", label: "Hand out the organization's mailboxes" }
    };

/** The areas in the order the editor draws them. Read off the meta rather than
 *  written twice, so a permission added above cannot go missing from the screen. */
export const ORG_PERMISSION_AREAS: readonly string[] = [
    ...new Set(ORG_PERMISSIONS.map((permission) => ORG_PERMISSION_META[permission].area))
];

/**
 * The roles every organization starts with.
 *
 * They exist because a brand-new organization has to be usable before anybody
 * opens the roles screen, and they are seeded rather than hardcoded so an
 * organization that wants "Member" to reach its spaces can simply say so. What
 * cannot be edited is `admin` - it holds the wildcard, so editing it could only
 * ever narrow the one role that exists to be unrestricted - and neither can be
 * deleted, because a membership row may still name it.
 */
export const ORG_SYSTEM_ROLES: Readonly<
    Record<
        string,
        {
            name: string;
            description: string;
            permissions: readonly GrantedOrgPermission[];
            /** Holds nothing implicitly - not even `org.read`. See `OrgRole.restricted`. */
            restricted?: boolean;
        }
    >
> = {
    admin: {
        name: "Admin",
        description: "Runs the roster, the teams, the work and the settings.",
        permissions: [ALL_ORG_PERMISSIONS]
    },
    member: {
        name: "Member",
        description: "Sees the organization and reaches whatever their teams reach.",
        permissions: ["org.read"]
    },
    // Least privilege as a starting point. Somebody holding this is on the
    // roster for whoever runs it and reaches exactly what is granted to them -
    // a team, a project, a space - and nothing because of where they belong.
    restricted: {
        name: "Restricted",
        description: "Reaches only what is granted to them. Does not see the roster, the files or internal work.",
        permissions: [],
        restricted: true
    }
};

/** The seeded slugs, in the order a picker should offer them. */
export const ORG_SYSTEM_ROLE_SLUGS: readonly string[] = Object.keys(ORG_SYSTEM_ROLES);

/** The role whose grants are fixed, for the reason above. */
export const UNEDITABLE_ORG_ROLE = "admin";

/** The role somebody falls to when the one they held is deleted, and what a new
 *  membership takes unless the person adding them says otherwise. */
export const DEFAULT_ORG_ROLE = "member";

/** The seeded role that holds nothing. Named so an organization's settings can
 *  offer it as the default for invitations; what it means is read from the role
 *  row's own `restricted`, never from this slug. */
export const RESTRICTED_ORG_ROLE = "restricted";

/** Role names are typed by hand and read back in a roster, a picker and an audit
 *  entry, so they stay short. */
export const ORG_ROLE_NAME_MAX = 32;

/** A role's handle within its organization. Shorter than an organization handle
 *  on purpose: "qa" and "ops" are the names people actually use. */
export const orgRoleSlugField = z
    .string()
    .trim()
    .toLowerCase()
    .min(2, "At least 2 characters")
    .max(30, "At most 30 characters")
    .regex(/^[a-z0-9-]+$/, "Use letters, numbers or -")
    .refine(
        (value) => !value.startsWith("-") && !value.endsWith("-"),
        "Cannot start or end with -"
    );

/**
 * Whether a set of grants carries a permission. The wildcard answers yes to
 * everything, which is what makes a permission added in a later version reach the
 * admin role without a migration.
 */
export function hasOrgPermission(granted: readonly string[], permission: OrgPermission): boolean {
    return granted.includes(ALL_ORG_PERMISSIONS) || granted.includes(permission);
}

/** A role as it is written. The wildcard is absent from the input on purpose:
 *  only the seeded admin holds it, so nobody can mint a second unrestricted role
 *  and then be surprised by what a future version put inside it. */
export const orgRoleSchema = z.object({
    name: z
        .string()
        .trim()
        .min(1, "Enter a name")
        .max(ORG_ROLE_NAME_MAX, `At most ${ORG_ROLE_NAME_MAX} characters`),
    slug: orgRoleSlugField,
    description: z.string().trim().max(200).default(""),
    permissions: z.array(z.enum(ORG_PERMISSIONS)).default([])
});

export type OrgRoleInput = z.infer<typeof orgRoleSchema>;

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
    name: z
        .string()
        .trim()
        .min(1, "Enter a name")
        .max(ORG_NAME_MAX, `At most ${ORG_NAME_MAX} characters`),
    slug: orgSlugField,
    description: z.string().trim().max(500).default("")
});

export type OrganizationInput = z.infer<typeof organizationSchema>;

/** Renaming never moves the handle: links, and anything anybody wrote down,
 *  keep working. Changing a handle is its own deliberate action. */
export const organizationProfileSchema = organizationSchema.omit({ slug: true });

export type OrganizationProfileInput = z.infer<typeof organizationProfileSchema>;

export const teamSchema = z.object({
    name: z
        .string()
        .trim()
        .min(1, "Enter a name")
        .max(ORG_NAME_MAX, `At most ${ORG_NAME_MAX} characters`),
    slug: orgSlugField,
    description: z.string().trim().max(500).default("")
});

export type TeamInput = z.infer<typeof teamSchema>;

/**
 * Asking somebody to join: an account's handle or email, or the email of
 * somebody with no account yet, and the role they would take.
 *
 * The identifier is lowercased here so the lookup, the refusal and the invite
 * that may be emailed all see the same address.
 */
export const orgInviteSchema = z.object({
    identifier: z.string().trim().toLowerCase().min(1, "Enter an email or a username").max(254),
    role: orgRoleSlugField
});

export type OrgInviteInput = z.infer<typeof orgInviteSchema>;

/** Whether an identifier is written as an address rather than a handle. The
 *  handle alphabet has no `@`, so the two cannot be mistaken for each other. */
export function isEmailIdentifier(identifier: string): boolean {
    return z.string().email().safeParse(identifier).success;
}

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

/**
 * Who may invite somebody with no account yet from an organization's People
 * screen.
 *
 * Such an invitation makes an account on this Polaris, which is otherwise
 * something only an administrator does - so it is theirs by default, and
 * handing it to whoever runs an organization's people is a choice an
 * administrator makes. Somebody who already has an account can always be
 * invited; this is only about making new ones.
 */
export const ORG_NEW_PEOPLE_MODES = ["admins", "managers", "off"] as const;
export type OrgNewPeopleMode = (typeof ORG_NEW_PEOPLE_MODES)[number];

export const ORG_NEW_PEOPLE_LABELS: Record<OrgNewPeopleMode, string> = {
    admins: "Administrators only",
    managers: "Anyone who manages an organization's people",
    off: "Nobody"
};

export const ORG_NEW_PEOPLE_HINTS: Record<OrgNewPeopleMode, string> = {
    admins: "Administrators can invite by email from any organization. Everybody else invites people who already have an account.",
    managers: "The invitation creates their account when they accept it, so this lets organizations bring in new people.",
    off: "Organizations only invite people who already have an account."
};

/** How many invitations one person may send from one organization in an hour,
 *  before it is turned down. Twenty is a busy onboarding afternoon and far short
 *  of what somebody using an organization to send mail to strangers would want. */
export const ORG_INVITES_PER_HOUR_DEFAULT = 20;

export const organizationPolicySchema = z.object({
    creation: z.enum(ORG_CREATION_MODES).default("everyone"),
    /** How many organizations one account may own. Being a member of somebody
     *  else's never counts against this. */
    maxPerUser: limitField,
    /** Roster size, counting the owner. */
    maxMembers: limitField,
    maxTeams: limitField,
    newPeople: z.enum(ORG_NEW_PEOPLE_MODES).default("admins"),
    /** Per person, per organization, per hour. Zero is no limit. */
    invitesPerHour: z.coerce
        .number()
        .int()
        .min(0)
        .max(10_000)
        .default(ORG_INVITES_PER_HOUR_DEFAULT)
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

/**
 * Project-level domain rules for Deploy: who may reach a project, how it behaves,
 * and what a change to it has to look like before the service layer will take it.
 *
 * A project is the unit an operator actually administers - services, environments,
 * variables, webhooks and tokens all hang off one - so the settings that decide
 * how those behave live here rather than being re-derived at each call site.
 */

import { z } from "zod";
import { WEBHOOK_FORMATS } from "./notifications.js";

// ---------------------------------------------------------------------------
// Visibility and membership
// ---------------------------------------------------------------------------

/**
 * `private` limits a project to its owner and whoever was added to it. `internal`
 * opens it to anyone on the instance already holding `deploy.read`, which is what
 * a household or a small team running one Polaris usually wants - and is still a
 * long way from public: nothing here is reachable without an account.
 */
export const PROJECT_VISIBILITIES = ["private", "internal"] as const;
export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];

/**
 * What a member may do. Ordered least to most, and compared by index rather than
 * by name so a check reads as "at least a developer" instead of listing roles.
 * The owner is never a member row and always outranks every one of these.
 */
export const PROJECT_ROLES = ["viewer", "developer", "admin"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const PROJECT_ROLE_LABELS: Record<ProjectRole, string> = {
    viewer: "Viewer",
    developer: "Developer",
    admin: "Admin"
};

export const PROJECT_ROLE_HINTS: Record<ProjectRole, string> = {
    viewer: "Read the project, its services, and their logs.",
    developer: "Deploy and configure services, variables, and domains.",
    admin: "Everything a developer can do, plus project settings and deletions."
};

/** True when `role` is at least `minimum`. */
export function roleAtLeast(role: ProjectRole, minimum: ProjectRole): boolean {
    return PROJECT_ROLES.indexOf(role) >= PROJECT_ROLES.indexOf(minimum);
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

/**
 * A project's behaviour toggles. Every one of these changes what Polaris actually
 * does - there are no display-only flags here - so the list doubles as the
 * documentation for the Feature Flags screen.
 */
export const PROJECT_FLAGS = [
    {
        id: "stageDestructiveChanges",
        label: "Stage destructive changes",
        description:
            "Removing a service or a volume is collected as a pending change and only takes effect when the changeset is deployed.",
        default: true
    },
    {
        id: "autoDeployNewServices",
        label: "Auto-deploy new services",
        description: "A service created from a git branch redeploys itself when a new commit lands on that branch.",
        default: true
    },
    {
        id: "keepReleasesByDefault",
        label: "Keep previous releases",
        description: "New services keep earlier builds running alongside the current one instead of replacing them.",
        default: false
    },
    {
        id: "autoSubdomain",
        label: "Automatic subdomain",
        description: "A new service is given a free subdomain as soon as one can be minted for it.",
        default: true
    },
    {
        id: "wipeVolumesOnDelete",
        label: "Wipe volumes on delete",
        description: "Deleting a service also destroys the data in the volumes attached to it. There is no undo.",
        default: false
    }
] as const;

export type ProjectFlagId = (typeof PROJECT_FLAGS)[number]["id"];

export type ProjectFlags = Record<ProjectFlagId, boolean>;

/** Every flag at its documented default. */
export function defaultProjectFlags(): ProjectFlags {
    const flags = {} as ProjectFlags;
    for (const flag of PROJECT_FLAGS) flags[flag.id] = flag.default;
    return flags;
}

/**
 * Read the stored JSON into a complete flag set. A column that is empty, corrupt,
 * or written by an older build simply falls back per flag, so a flag added later
 * arrives at its default rather than as `undefined` at the call site.
 */
export function parseProjectFlags(raw: string | null | undefined): ProjectFlags {
    const flags = defaultProjectFlags();
    if (!raw) return flags;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return flags;
    }
    if (!parsed || typeof parsed !== "object") return flags;
    const record = parsed as Record<string, unknown>;
    for (const flag of PROJECT_FLAGS) {
        if (typeof record[flag.id] === "boolean") flags[flag.id] = record[flag.id] as boolean;
    }
    return flags;
}

export const projectFlagsSchema = z.object(
    Object.fromEntries(PROJECT_FLAGS.map((flag) => [flag.id, z.boolean()])) as {
        [K in ProjectFlagId]: z.ZodBoolean;
    }
);

// ---------------------------------------------------------------------------
// Staged changes
// ---------------------------------------------------------------------------

/**
 * The changes that are parked rather than applied. Only removals stage: they are
 * the ones a misclick cannot take back, and they are what Railway's changeset is
 * for. Everything else - a variable, a domain, a port - still applies as it did.
 */
export const STAGED_CHANGE_KINDS = ["service.delete", "database.delete", "volume.delete"] as const;
export type StagedChangeKind = (typeof STAGED_CHANGE_KINDS)[number];

export const STAGED_CHANGE_LABELS: Record<StagedChangeKind, string> = {
    "service.delete": "Delete service",
    "database.delete": "Delete database",
    "volume.delete": "Delete volume"
};

/** Extra detail carried by a staged change, per kind. */
export const stagedChangePayloadSchema = z.object({
    /** On a volume: destroy the data as well as detaching it. */
    wipe: z.boolean().optional()
});

export type StagedChangePayload = z.infer<typeof stagedChangePayloadSchema>;

export function parseStagedChangePayload(raw: string | null | undefined): StagedChangePayload {
    if (!raw) return {};
    try {
        const parsed = stagedChangePayloadSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/** True if the string contains a C0 control character. */
function hasControlChar(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        if (value.charCodeAt(index) < 0x20) return true;
    }
    return false;
}

/** Names shown in a nav and used to derive a slug: printable, and never blank. */
const projectName = z
    .string()
    .trim()
    .min(1, "A name is required")
    .max(64, "Keep the name under 64 characters")
    .refine((value) => !hasControlChar(value), "The name must not contain control characters");

export const projectGeneralSchema = z.object({
    projectId: z.string().uuid(),
    name: projectName,
    // An empty box clears the description rather than leaving the old one behind.
    description: z.string().trim().max(500, "Keep the description under 500 characters")
});

export type ProjectGeneralInput = z.infer<typeof projectGeneralSchema>;

export const projectVisibilitySchema = z.object({
    projectId: z.string().uuid(),
    visibility: z.enum(PROJECT_VISIBILITIES)
});

export const environmentNameSchema = z.object({
    environmentId: z.string().uuid(),
    name: projectName
});

/** The deploy events an endpoint can subscribe to. An empty selection means all
 *  of them, so a webhook added without a choice still reports something. */
export const PROJECT_WEBHOOK_EVENTS = [
    { id: "deploy.succeeded", label: "Deploy succeeded" },
    { id: "deploy.failed", label: "Deploy failed" },
    { id: "deploy.started", label: "Deploy started" }
] as const;

export type ProjectWebhookEvent = (typeof PROJECT_WEBHOOK_EVENTS)[number]["id"];

const PROJECT_WEBHOOK_EVENT_IDS = PROJECT_WEBHOOK_EVENTS.map((event) => event.id) as [
    ProjectWebhookEvent,
    ...ProjectWebhookEvent[]
];

export const projectWebhookInputSchema = z.object({
    projectId: z.string().uuid(),
    name: z.string().trim().min(1, "A name is required").max(64),
    url: z
        .string()
        .trim()
        .url("Enter a full URL, including https://")
        .max(2048)
        .refine((value) => value.startsWith("https://") || value.startsWith("http://"), "Only http(s) endpoints"),
    format: z.enum(WEBHOOK_FORMATS).optional(),
    events: z.array(z.enum(PROJECT_WEBHOOK_EVENT_IDS)).max(PROJECT_WEBHOOK_EVENTS.length).default([])
});

export type ProjectWebhookInput = z.infer<typeof projectWebhookInputSchema>;

/** How long a project token may live. `never` is offered because a deploy key in
 *  a CI file that silently expires is its own kind of outage. */
export const TOKEN_LIFETIMES = ["30d", "90d", "365d", "never"] as const;
export type TokenLifetime = (typeof TOKEN_LIFETIMES)[number];

export const TOKEN_LIFETIME_DAYS: Record<TokenLifetime, number | null> = {
    "30d": 30,
    "90d": 90,
    "365d": 365,
    never: null
};

export const projectTokenInputSchema = z.object({
    projectId: z.string().uuid(),
    name: z.string().trim().min(1, "A name is required").max(64),
    lifetime: z.enum(TOKEN_LIFETIMES).default("90d"),
    /** Whether the token may change the project as well as read it. */
    canManage: z.boolean().default(false)
});

export type ProjectTokenInput = z.infer<typeof projectTokenInputSchema>;

// ---------------------------------------------------------------------------
// Volume usage alerts
// ---------------------------------------------------------------------------

/** Percentages a volume alert can be set at. A free-text field would invite 3%,
 *  which fires constantly and teaches the reader to ignore the alert. */
export const VOLUME_ALERT_THRESHOLDS = [50, 75, 80, 90, 95] as const;

export const volumeAlertSchema = z.object({
    volumeId: z.string().uuid(),
    enabled: z.boolean(),
    threshold: z
        .number()
        .int()
        .min(1)
        .max(99)
        .refine((value) => (VOLUME_ALERT_THRESHOLDS as readonly number[]).includes(value), "Pick an offered threshold")
});

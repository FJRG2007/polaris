/**
 * What somebody may do inside one Deploy project.
 *
 * The three project roles answer the question most of the time, and they stay
 * the way access is normally handed out. They cannot answer it all of the time:
 * "deploy the services but never read the variables" and "work in development,
 * not in production" are ordinary things to want from somebody helping on a
 * project, and neither is a point on a ladder from viewer to admin.
 *
 * So a role is a named set of capabilities rather than a rank, and an entry may
 * carry its own set instead. Everything else about access is expressed the same
 * way: who it is for (one person, a team, an organization, or everyone with an
 * account), which environments it reaches, and when it stops applying.
 *
 * Pure - the browser builds the editor from this and the server decides with it,
 * so what a checkbox says and what a call site enforces cannot drift.
 */

import { z } from "zod";
import { PROJECT_ROLES, type ProjectRole } from "./project.js";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * One thing that can be done to a project, in the granularity somebody actually
 * reasons about when they are deciding what a collaborator should reach. Every
 * write path in Deploy is gated on exactly one of these.
 */
export const PROJECT_CAPABILITIES = [
    "project.read",
    "logs.read",
    "deploy.run",
    "service.configure",
    "service.create",
    "service.delete",
    "variables.read",
    "variables.write",
    "console.use",
    "files.read",
    "files.write",
    "domains.manage",
    "volumes.manage",
    "databases.manage",
    "project.settings",
    "members.manage"
] as const;

export type ProjectCapability = (typeof PROJECT_CAPABILITIES)[number];

export interface ProjectCapabilityMeta {
    /** The heading it sits under in the editor. */
    readonly area: string;
    readonly label: string;
    /** Said only where the label leaves a real question open. */
    readonly hint?: string;
}

export const PROJECT_CAPABILITY_META: Readonly<Record<ProjectCapability, ProjectCapabilityMeta>> = {
    "project.read": {
        area: "Project",
        label: "See the project and its services",
        hint: "Held by everyone who reaches the project at all."
    },
    "logs.read": { area: "Project", label: "Read build and runtime logs" },
    "deploy.run": {
        area: "Services",
        label: "Deploy, restart, stop and roll back",
        hint: "Ships what is already configured. It does not allow changing how a service is built."
    },
    "service.configure": {
        area: "Services",
        label: "Change how a service is built and run",
        hint: "Source, branch, ports, build commands, auto-deploy."
    },
    "service.create": { area: "Services", label: "Add services" },
    "service.delete": { area: "Services", label: "Remove services" },
    "variables.read": {
        area: "Variables",
        label: "See variable names and values",
        hint: "Without this the variables tab is not shown at all - not the names, not the secrets."
    },
    "variables.write": { area: "Variables", label: "Add, change and remove variables" },
    "console.use": {
        area: "Access",
        label: "Open a terminal in a running service",
        hint: "A shell inside the container reaches whatever the container can, variables included."
    },
    "files.read": { area: "Access", label: "Browse and download service files" },
    "files.write": { area: "Access", label: "Upload, edit and delete service files" },
    "domains.manage": { area: "Networking", label: "Add and remove domains and tunnels" },
    "volumes.manage": {
        area: "Storage",
        label: "Add, resize and detach volumes",
        hint: "Detaching a volume can erase what it holds, and that cannot be undone."
    },
    "databases.manage": { area: "Storage", label: "Create databases and read their connection details" },
    "project.settings": {
        area: "Project",
        label: "Change project settings",
        hint: "Name, visibility, flags, environments, webhooks and deploy tokens."
    },
    "members.manage": { area: "Project", label: "Give other people access" }
};

/** The order the editor groups capabilities in. */
export const PROJECT_CAPABILITY_AREAS = ["Project", "Services", "Variables", "Access", "Networking", "Storage"] as const;

/**
 * Capabilities another one cannot sensibly be held without, in the same spirit
 * as IMPLIED_PERMISSIONS: writing a variable you cannot read back, or managing a
 * service you cannot see, is an access set that only looks narrower than it is.
 */
export const IMPLIED_PROJECT_CAPABILITIES: Readonly<Partial<Record<ProjectCapability, readonly ProjectCapability[]>>> = {
    "logs.read": ["project.read"],
    "deploy.run": ["project.read", "logs.read"],
    "service.configure": ["project.read", "logs.read"],
    "service.create": ["project.read"],
    "service.delete": ["project.read"],
    "variables.read": ["project.read"],
    "variables.write": ["project.read", "variables.read"],
    "console.use": ["project.read"],
    "files.read": ["project.read"],
    "files.write": ["project.read", "files.read"],
    "domains.manage": ["project.read"],
    "volumes.manage": ["project.read"],
    "databases.manage": ["project.read"],
    "project.settings": ["project.read"],
    "members.manage": ["project.read"]
};

/** Complete a set with everything its members imply, in catalogue order so a
 *  stored set reads the same however it was picked. */
export function expandProjectCapabilities(
    granted: Iterable<ProjectCapability>
): ProjectCapability[] {
    const expanded = new Set<ProjectCapability>();
    for (const capability of granted) {
        expanded.add(capability);
        for (const implied of IMPLIED_PROJECT_CAPABILITIES[capability] ?? []) expanded.add(implied);
    }
    return PROJECT_CAPABILITIES.filter((capability) => expanded.has(capability));
}

// ---------------------------------------------------------------------------
// Roles as capability sets
// ---------------------------------------------------------------------------

/**
 * What each role means, written out.
 *
 * A developer deliberately holds the variables: somebody who can deploy a
 * service and open a terminal in it can read its environment anyway, so
 * withholding the tab would be a lock on a door with no wall beside it. Taking
 * the variables away is a real decision, and it is made by taking the console
 * and the files with them - which is what the custom set is for.
 */
export const PROJECT_ROLE_CAPABILITIES: Readonly<Record<ProjectRole, readonly ProjectCapability[]>> = {
    viewer: ["project.read", "logs.read"],
    developer: [
        "project.read",
        "logs.read",
        "deploy.run",
        "service.configure",
        "service.create",
        "variables.read",
        "variables.write",
        "console.use",
        "files.read",
        "files.write",
        "domains.manage",
        "volumes.manage",
        "databases.manage"
    ],
    admin: [...PROJECT_CAPABILITIES]
};

/** Everything, for the project's owner and whoever administers its organization. */
export const ALL_PROJECT_CAPABILITIES: readonly ProjectCapability[] = PROJECT_CAPABILITIES;

/** The role a stored capability set was picked from, or null when it was built by
 *  hand - so an editor reopens on the choice somebody made rather than on a row
 *  of ticks they never set one by one. */
export function projectRoleFor(capabilities: readonly ProjectCapability[]): ProjectRole | null {
    const held = new Set(capabilities);
    for (const role of PROJECT_ROLES) {
        const expected = expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES[role]);
        if (expected.length === held.size && expected.every((capability) => held.has(capability))) return role;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

/**
 * Who an access entry is for.
 *
 * `everyone` is every account on this instance that already holds `deploy.read`
 * - the same reach the `internal` visibility has always had, said as an entry
 * with a role of its own so it can be narrowed instead of being all or nothing.
 */
export const PROJECT_PRINCIPALS = ["user", "team", "org", "everyone"] as const;
export type ProjectPrincipalKind = (typeof PROJECT_PRINCIPALS)[number];

export const PROJECT_PRINCIPAL_LABELS: Record<ProjectPrincipalKind, string> = {
    user: "Person",
    team: "Team",
    org: "Organization",
    everyone: "Everyone with an account"
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const capability = z.enum(PROJECT_CAPABILITIES);

/**
 * One access entry as a screen submits it.
 *
 * `role` and `capabilities` are alternatives: a role is stored as its own set,
 * so what an entry grants is always written out in full and a role whose meaning
 * changes later cannot silently widen access somebody already has.
 */
export const projectAccessInputSchema = z
    .object({
        projectId: z.string().uuid(),
        principal: z.enum(PROJECT_PRINCIPALS),
        /** The account, team or organization. Omitted for `everyone`. */
        principalId: z.string().uuid().optional(),
        /** An email or username, when a person is being added by name rather than id. */
        identifier: z.string().trim().max(320).optional(),
        role: z.enum(PROJECT_ROLES).optional(),
        capabilities: z.array(capability).max(PROJECT_CAPABILITIES.length).optional(),
        /** Environment ids this entry is limited to. Empty means every one. */
        environmentIds: z.array(z.string().uuid()).max(64).default([]),
        /** When it stops applying, as an ISO date. Omitted means indefinitely. */
        expiresAt: z.string().datetime().optional().nullable()
    })
    .refine(
        (value) => value.principal === "everyone" || Boolean(value.principalId) || Boolean(value.identifier),
        { message: "Choose who this is for", path: ["principalId"] }
    )
    .refine((value) => Boolean(value.role) || (value.capabilities?.length ?? 0) > 0, {
        message: "Choose a role, or at least one thing they may do",
        path: ["capabilities"]
    });

export type ProjectAccessInput = z.infer<typeof projectAccessInputSchema>;

/** The capabilities an entry grants: its own set, else its role's. Always
 *  expanded, so a stored entry never depends on being read back through this. */
export function resolveProjectCapabilities(input: {
    role?: ProjectRole;
    capabilities?: readonly ProjectCapability[];
}): ProjectCapability[] {
    const chosen = input.capabilities?.length ? input.capabilities : PROJECT_ROLE_CAPABILITIES[input.role ?? "viewer"];
    return expandProjectCapabilities(chosen);
}

/** Read a stored capability list, dropping anything this version does not know.
 *  A row nobody can read grants nothing, which is the only safe direction. */
export function parseProjectCapabilities(raw: string | null | undefined): ProjectCapability[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const known = new Set(parsed.filter((value): value is string => typeof value === "string"));
        return PROJECT_CAPABILITIES.filter((value) => known.has(value));
    } catch {
        return [];
    }
}

/** Read a stored environment restriction. An unreadable value restricts to
 *  nothing rather than to everything, for the same reason. */
export function parseEnvironmentScope(raw: string | null | undefined): string[] | null {
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((value): value is string => typeof value === "string");
    } catch {
        return [];
    }
}

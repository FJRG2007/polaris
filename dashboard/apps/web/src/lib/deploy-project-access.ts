/**
 * Who may reach a Deploy project, and to do what.
 *
 * Everything else in Deploy is scoped to the project owner: a target, a volume,
 * a deploy log all belong to whoever created the project, and every query in
 * deploy-service takes an `ownerId`. Access is layered on top rather than
 * threaded through all of that - this module answers "is this user allowed to do
 * this here, and whose resources are they acting on", and the caller then uses
 * the existing owner-scoped path with the owner's id.
 *
 * That keeps one place deciding access. Somebody added to a project never gains a
 * second, weaker route into it: they go through the same queries the owner does,
 * after being authorized here.
 *
 * An entry reaches a person directly, through a team they are on, through an
 * organization they belong to, or through the entry that covers everyone with an
 * account. All of them are unioned - the widest thing said about somebody is what
 * they hold - and an expired entry says nothing at all.
 */

import { prisma } from "@polaris/db";
import { canOn, grantedResourceIds } from "@polaris/auth";
import { memberOrgIds, orgCan, orgIdsWhere, resolveOrgAccess, teamIdsFor } from "@/lib/orgs/org-service";
import {
    resourceRef,
    parseProjectCapabilities,
    parseEnvironmentScope,
    projectRoleFor,
    expandProjectCapabilities,
    PROJECT_ROLE_CAPABILITIES,
    ALL_PROJECT_CAPABILITIES,
    type ProjectCapability,
    type ProjectRole
} from "@polaris/core";

/** The owner outranks every entry, and is never one. "custom" is an entry whose
 *  capabilities were assembled by hand rather than taken from a role. */
export type EffectiveRole = ProjectRole | "owner" | "custom";

export interface ProjectAccess {
    readonly projectId: string;
    /** Whose resources this project's services live on. */
    readonly ownerId: string;
    /** For display only. What is enforced is `capabilities`. */
    readonly role: EffectiveRole;
    readonly isOwner: boolean;
    readonly capabilities: readonly ProjectCapability[];
    /** The environments this access is limited to, or null for every one. */
    readonly environmentIds: readonly string[] | null;
}

/** True when the access carries this capability. */
export function accessCan(access: ProjectAccess, capability: ProjectCapability): boolean {
    return access.capabilities.includes(capability);
}

/** True when the access reaches this environment at all. */
export function accessInEnvironment(access: ProjectAccess, environmentId: string): boolean {
    return access.environmentIds === null || access.environmentIds.includes(environmentId);
}

/** Access built from a capability set, with its role named for display. */
function fromCapabilities(
    project: { id: string; ownerId: string },
    capabilities: readonly ProjectCapability[],
    environmentIds: readonly string[] | null
): ProjectAccess {
    return {
        projectId: project.id,
        ownerId: project.ownerId,
        role: projectRoleFor(capabilities) ?? "custom",
        isOwner: false,
        capabilities,
        environmentIds
    };
}

/**
 * The clause matching every access entry that reaches this user, expiry
 * included. Shared with the listing queries in deploy-service so a project shows
 * up in the list exactly when it can be opened - a listing that authorizes more
 * loosely than the page it links to ends every link on "not found", and one that
 * authorizes more tightly hides a project somebody was given.
 */
export async function projectEntryWhere(userId: string) {
    const [teamIds, orgIds] = await Promise.all([teamIdsFor(userId), memberOrgIds(userId)]);
    return {
        some: {
            AND: [
                { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
                {
                    OR: [
                        { userId },
                        ...(teamIds.length > 0 ? [{ teamId: { in: teamIds } }] : []),
                        ...(orgIds.length > 0 ? [{ orgId: { in: orgIds } }] : []),
                        // The entry for everybody. Every read path here has already
                        // required `deploy.read` of the instance, which is what
                        // "everyone with an account" has always meant in Deploy.
                        { userId: null, teamId: null, orgId: null }
                    ]
                }
            ]
        }
    };
}

/** Every entry reaching this user on one project, already unioned. Null when
 *  none does. */
async function entriesFor(
    projectId: string,
    userId: string
): Promise<{ capabilities: ProjectCapability[]; environmentIds: string[] | null } | null> {
    const rows = await prisma.projectMember.findMany({
        where: { projectId, ...(await projectEntryWhere(userId)).some },
        select: { capabilities: true, environments: true }
    });
    if (rows.length === 0) return null;
    const capabilities = new Set<ProjectCapability>();
    // One unrestricted entry makes the whole access unrestricted: the widest
    // thing said about somebody is what they hold, exactly as with the
    // capabilities themselves.
    let environmentIds: string[] | null = [];
    for (const row of rows) {
        for (const capability of parseProjectCapabilities(row.capabilities)) capabilities.add(capability);
        const scope = parseEnvironmentScope(row.environments);
        if (scope === null) environmentIds = null;
        else if (environmentIds !== null) environmentIds.push(...scope);
    }
    return {
        capabilities: expandProjectCapabilities(capabilities),
        environmentIds: environmentIds === null ? null : [...new Set(environmentIds)]
    };
}

/**
 * The user's standing on a project, or null when they have none. Reading an
 * `internal` project is deliberately the weakest access there is - the viewer
 * set - so opening a project up never quietly hands out the ability to change it.
 */
export async function projectAccess(projectId: string, userId: string): Promise<ProjectAccess | null> {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, ownerId: true, orgId: true, visibility: true }
    });
    if (!project) return null;

    if (project.ownerId === userId) {
        return {
            projectId: project.id,
            ownerId: project.ownerId,
            role: "owner",
            isOwner: true,
            capabilities: ALL_PROJECT_CAPABILITIES,
            environmentIds: null
        };
    }

    const entry = await entriesFor(project.id, userId);
    if (entry) return fromCapabilities(project, entry.capabilities, entry.environmentIds);

    // Access written for this project alone, which is what lets somebody reach one
    // without being on the roster of anything. Mapped onto the same sets every
    // other way in uses, and deliberately never the admin one: settings and
    // deletion stay with the people the project belongs to.
    const ref = resourceRef("project", project.id);
    if (await canOn(userId, "deploy.manage", ref, { ownerId: project.ownerId })) {
        return fromCapabilities(project, expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES.developer), null);
    }
    if (await canOn(userId, "deploy.read", ref, { ownerId: project.ownerId })) {
        return fromCapabilities(project, expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES.viewer), null);
    }

    // A project on an organization's shelf answers to that organization first.
    // Whoever runs its services reaches all of them as an admin, and everybody
    // else on the roster reaches an internal one as a viewer - which is what
    // `internal` means there. On a personal project it keeps meaning "anybody on
    // this instance", which is what a household wants and what was always true.
    if (project.orgId) {
        const access = await resolveOrgAccess({ id: userId, isAdmin: false }, project.orgId);
        // `org.read` rather than merely having an answer: not everybody the
        // organization answers for is on its roster. The successor its owner
        // named holds nothing, and `internal` has to keep meaning the roster.
        if (!orgCan(access, "org.read")) return null;
        if (orgCan(access, "deploy.manage")) {
            return fromCapabilities(project, expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES.admin), null);
        }
        if (project.visibility === "internal") {
            return fromCapabilities(project, expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES.viewer), null);
        }
        return null;
    }

    if (project.visibility === "internal") {
        return fromCapabilities(project, expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES.viewer), null);
    }
    return null;
}

/**
 * Resolve access and require one capability, throwing the same message for "no
 * such project" and "not allowed to do that on it" - which of the two it was is
 * not something a caller who cannot see the project is owed.
 */
export async function requireProjectAccess(
    projectId: string,
    userId: string,
    capability: ProjectCapability = "project.read"
): Promise<ProjectAccess> {
    const access = await projectAccess(projectId, userId);
    if (!access || !accessCan(access, capability)) throw new Error("Project not found");
    return access;
}

/**
 * The same, reached through one of the project's environments - and refused when
 * the access does not cover that environment. This is what makes "development,
 * not production" hold: the capability is only half the question once an entry
 * names environments.
 */
export async function requireEnvironmentAccess(
    environmentId: string,
    userId: string,
    capability: ProjectCapability = "project.read"
): Promise<ProjectAccess & { environmentId: string }> {
    const environment = await prisma.environment.findUnique({
        where: { id: environmentId },
        select: { id: true, projectId: true }
    });
    if (!environment) throw new Error("Environment not found");
    const access = await requireProjectAccess(environment.projectId, userId, capability);
    if (!accessInEnvironment(access, environment.id)) throw new Error("Environment not found");
    return { ...access, environmentId: environment.id };
}

/** The same, reached through one of the project's services. */
export async function requireApplicationAccess(
    applicationId: string,
    userId: string,
    capability: ProjectCapability = "project.read"
): Promise<ProjectAccess & { environmentId: string }> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { environmentId: true, environment: { select: { projectId: true } } }
    });
    if (!app) throw new Error("Service not found");
    const access = await requireProjectAccess(app.environment.projectId, userId, capability);
    if (!accessInEnvironment(access, app.environmentId)) throw new Error("Service not found");
    return { ...access, environmentId: app.environmentId };
}

/** The same, reached through a managed database. */
export async function requireDatabaseAccess(
    databaseId: string,
    userId: string,
    capability: ProjectCapability = "project.read"
): Promise<ProjectAccess & { environmentId: string }> {
    const database = await prisma.managedDatabase.findUnique({
        where: { id: databaseId },
        select: { environmentId: true, environment: { select: { projectId: true } } }
    });
    if (!database) throw new Error("Database not found");
    const access = await requireProjectAccess(database.environment.projectId, userId, capability);
    if (!accessInEnvironment(access, database.environmentId)) throw new Error("Database not found");
    return { ...access, environmentId: database.environmentId };
}

/** The same, reached through a hostname attached to a service. */
export async function requireDomainAccess(
    domainId: string,
    userId: string,
    capability: ProjectCapability = "project.read"
): Promise<ProjectAccess & { environmentId: string }> {
    const domain = await prisma.domain.findUnique({
        where: { id: domainId },
        select: { applicationId: true }
    });
    if (!domain) throw new Error("Domain not found");
    return requireApplicationAccess(domain.applicationId, userId, capability);
}

/**
 * The same, reached through a deployment.
 *
 * `deployableId` is a soft pointer - a deployment names an application, a
 * database or a stack - so a row naming something this cannot resolve is refused
 * rather than let through on the strength of having found a row.
 */
export async function requireDeploymentAccess(
    deploymentId: string,
    userId: string,
    capability: ProjectCapability = "project.read"
): Promise<ProjectAccess & { environmentId: string }> {
    const deployment = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { deployableType: true, deployableId: true }
    });
    if (!deployment) throw new Error("Deployment not found");
    if (deployment.deployableType === "application") {
        return requireApplicationAccess(deployment.deployableId, userId, capability);
    }
    if (deployment.deployableType === "database") {
        return requireDatabaseAccess(deployment.deployableId, userId, capability);
    }
    throw new Error("Deployment not found");
}

/** The same, reached through a variable scope - one service, or the environment
 *  every service in it shares. */
export async function requireEnvScopeAccess(
    scope: "application" | "environment",
    scopeId: string,
    userId: string,
    capability: ProjectCapability
): Promise<ProjectAccess & { environmentId: string }> {
    return scope === "environment"
        ? requireEnvironmentAccess(scopeId, userId, capability)
        : requireApplicationAccess(scopeId, userId, capability);
}

/** Ids of every project the user may at least read. Used to widen the Deploy
 *  landing beyond what they own without loading each project to check. */
export async function visibleProjectIds(userId: string): Promise<string[]> {
    const [belongsTo, runs, granted, entries] = await Promise.all([
        memberOrgIds(userId),
        orgIdsWhere({ id: userId, isAdmin: false }, "deploy.manage"),
        grantedResourceIds(userId, "project", "deploy.read"),
        projectEntryWhere(userId)
    ]);
    const rows = await prisma.project.findMany({
        where: {
            OR: [
                { ownerId: userId },
                { members: entries },
                // Written for one project, rather than through a roster.
                ...(granted.ids.length > 0 ? [{ id: { in: granted.ids } }] : []),
                // Internal on a personal project is the whole instance; on an
                // organization's it is that roster and no further.
                { visibility: "internal", orgId: null },
                ...(belongsTo.length > 0 ? [{ visibility: "internal", orgId: { in: belongsTo } }] : []),
                ...(runs.length > 0 ? [{ orgId: { in: runs } }] : [])
            ]
        },
        select: { id: true },
        orderBy: { createdAt: "asc" }
    });
    return rows.map((row) => row.id);
}

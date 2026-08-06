/**
 * Who may reach a Deploy project, and as what.
 *
 * Everything else in Deploy is scoped to the project owner: a target, a volume,
 * a deploy log all belong to whoever created the project, and every query in
 * deploy-service takes an `ownerId`. Membership is layered on top rather than
 * threaded through all of that - this module answers "is this user allowed, and
 * whose resources are they acting on", and the caller then uses the existing
 * owner-scoped path with the owner's id.
 *
 * That keeps one place deciding access. A member never gains a second, weaker
 * route into a project: they go through the same queries the owner does, after
 * being authorized here.
 */

import { prisma } from "@polaris/db";
import { roleAtLeast, type ProjectRole } from "@polaris/core";
import { memberOrgIds, orgCan, orgIdsWhere, resolveOrgAccess } from "@/lib/orgs/org-service";

/** The owner outranks every role, and is never a membership row. */
export type EffectiveRole = ProjectRole | "owner";

export interface ProjectAccess {
    readonly projectId: string;
    /** Whose resources this project's services live on. */
    readonly ownerId: string;
    readonly role: EffectiveRole;
    readonly isOwner: boolean;
}

/** True when the effective role clears the bar. The owner always does. */
export function accessAtLeast(access: ProjectAccess, minimum: ProjectRole): boolean {
    return access.role === "owner" || roleAtLeast(access.role, minimum);
}

/**
 * The user's standing on a project, or null when they have none. Reading an
 * `internal` project is deliberately the weakest grant there is - viewer - so
 * opening a project up never quietly hands out the ability to change it.
 */
export async function projectAccess(projectId: string, userId: string): Promise<ProjectAccess | null> {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
            id: true,
            ownerId: true,
            orgId: true,
            visibility: true,
            members: { where: { userId }, select: { role: true } }
        }
    });
    if (!project) return null;

    if (project.ownerId === userId) {
        return { projectId: project.id, ownerId: project.ownerId, role: "owner", isOwner: true };
    }
    const membership = project.members[0];
    if (membership) {
        return {
            projectId: project.id,
            ownerId: project.ownerId,
            role: membership.role as ProjectRole,
            isOwner: false
        };
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
            return { projectId: project.id, ownerId: project.ownerId, role: "admin", isOwner: false };
        }
        if (project.visibility === "internal") {
            return { projectId: project.id, ownerId: project.ownerId, role: "viewer", isOwner: false };
        }
        return null;
    }

    if (project.visibility === "internal") {
        return { projectId: project.id, ownerId: project.ownerId, role: "viewer", isOwner: false };
    }
    return null;
}

/**
 * Resolve access and require a minimum role, throwing the same message for "no
 * such project" and "not allowed on it" - which of the two it was is not
 * something a caller who cannot see the project is owed.
 */
export async function requireProjectAccess(
    projectId: string,
    userId: string,
    minimum: ProjectRole = "viewer"
): Promise<ProjectAccess> {
    const access = await projectAccess(projectId, userId);
    if (!access || !accessAtLeast(access, minimum)) throw new Error("Project not found");
    return access;
}

/** The same, reached through one of the project's environments. */
export async function requireEnvironmentAccess(
    environmentId: string,
    userId: string,
    minimum: ProjectRole = "viewer"
): Promise<ProjectAccess & { environmentId: string }> {
    const environment = await prisma.environment.findUnique({
        where: { id: environmentId },
        select: { id: true, projectId: true }
    });
    if (!environment) throw new Error("Environment not found");
    const access = await requireProjectAccess(environment.projectId, userId, minimum);
    return { ...access, environmentId: environment.id };
}

/** The same, reached through one of the project's services. */
export async function requireApplicationAccess(
    applicationId: string,
    userId: string,
    minimum: ProjectRole = "viewer"
): Promise<ProjectAccess & { environmentId: string }> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { environmentId: true, environment: { select: { projectId: true } } }
    });
    if (!app) throw new Error("Service not found");
    const access = await requireProjectAccess(app.environment.projectId, userId, minimum);
    return { ...access, environmentId: app.environmentId };
}

/** Ids of every project the user may at least read. Used to widen the Deploy
 *  landing beyond what they own without loading each project to check. */
export async function visibleProjectIds(userId: string): Promise<string[]> {
    const [belongsTo, runs] = await Promise.all([
        memberOrgIds(userId),
        orgIdsWhere({ id: userId, isAdmin: false }, "deploy.manage")
    ]);
    const rows = await prisma.project.findMany({
        where: {
            OR: [
                { ownerId: userId },
                { members: { some: { userId } } },
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

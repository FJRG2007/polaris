/**
 * Organizations and teams: reading them, changing them, and answering who may.
 *
 * Two rules run through everything here. The first is that an organization's
 * roster reaches no work on its own - being on it makes you available to teams
 * and visible to the other members, and that is all - so nothing in this module
 * grants access to a space. The second is that the owner is never a member row,
 * which is what makes "remove everybody" a survivable mistake.
 *
 * Authorization lives in `requireOrg` / `requireTeam` and nowhere else. Every
 * other function takes ids that have already been cleared.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { organizationPolicy } from "./policy";

/** The caller, as the action layer resolved them. An instance administrator is
 *  treated as an owner so whoever runs the deployment is never locked out of an
 *  organization on it. */
export interface OrgActor {
    readonly id: string;
    readonly isAdmin: boolean;
}

export class OrgError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OrgError";
    }
}

export class OrgAccessError extends OrgError {
    constructor(message = "You do not have access to that organization") {
        super(message);
        this.name = "OrgAccessError";
    }
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** What this actor may do across a whole organization, or null when it is not
 *  theirs to see. */
export async function resolveOrgRole(actor: OrgActor, orgId: string): Promise<core.OrgAccess | null> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { ownerId: true, members: { where: { userId: actor.id }, select: { role: true } } }
    });
    if (!org) return null;
    if (org.ownerId === actor.id || actor.isAdmin) return "owner";
    const membership = org.members[0];
    return membership ? (membership.role as core.OrgRole) : null;
}

export async function requireOrg(actor: OrgActor, orgId: string, minimum: core.OrgRole): Promise<core.OrgAccess> {
    const role = await resolveOrgRole(actor, orgId);
    if (!role) throw new OrgAccessError();
    if (!core.orgRoleAtLeast(role, minimum)) {
        throw new OrgAccessError("You do not have permission to do that in this organization");
    }
    return role;
}

/** Only the owner - renaming the organization, moving its handle, handing it on,
 *  and deleting it. An instance administrator counts, and nobody else does. */
export async function requireOrgOwner(actor: OrgActor, orgId: string): Promise<void> {
    if ((await resolveOrgRole(actor, orgId)) !== "owner") {
        throw new OrgAccessError("Only the organization's owner can do that");
    }
}

/**
 * Clear the actor for one team, and say whether they may change its roster.
 *
 * A team is run by its maintainers as well as by the organization's admins,
 * which is the whole point of the role: a team lead adds and removes their own
 * people without being handed the organization.
 */
export async function requireTeam(
    actor: OrgActor,
    teamId: string,
    minimum: "read" | "manage"
): Promise<{ orgId: string; orgRole: core.OrgAccess; canManage: boolean }> {
    const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: { orgId: true, members: { where: { userId: actor.id }, select: { role: true } } }
    });
    if (!team) throw new OrgAccessError("That team no longer exists");
    const orgRole = await resolveOrgRole(actor, team.orgId);
    if (!orgRole) throw new OrgAccessError();
    const canManage =
        core.orgRoleAtLeast(orgRole, "admin") || team.members[0]?.role === "maintainer";
    if (minimum === "manage" && !canManage) {
        throw new OrgAccessError("Only an organization admin or a maintainer of this team can do that");
    }
    return { orgId: team.orgId, orgRole, canManage };
}

/** Every team this account is on. The one thing the Tasks access layer needs
 *  from this module, which is why it takes an id and returns ids. */
export async function teamIdsFor(userId: string): Promise<string[]> {
    const rows = await prisma.teamMember.findMany({ where: { userId }, select: { teamId: true } });
    return rows.map((row) => row.teamId);
}

/** Every organization this account runs - owns, administers, or is an instance
 *  administrator of. Used where a space needs to know whether its organization
 *  opens it to the reader. */
export async function administeredOrgIds(actor: OrgActor): Promise<string[]> {
    if (actor.isAdmin) {
        const all = await prisma.organization.findMany({ select: { id: true } });
        return all.map((org) => org.id);
    }
    const [owned, admin] = await Promise.all([
        prisma.organization.findMany({ where: { ownerId: actor.id }, select: { id: true } }),
        prisma.organizationMember.findMany({
            where: { userId: actor.id, role: "admin" },
            select: { orgId: true }
        })
    ]);
    return [...new Set([...owned.map((org) => org.id), ...admin.map((row) => row.orgId)])];
}

/** The organizations this account can create work for, named. What the "who owns
 *  this space" picker is built from - a member of an organization is not offered
 *  it, because putting a space on somebody's shelf takes administering them. */
export async function listAdministeredOrgs(actor: OrgActor): Promise<{ id: string; name: string }[]> {
    const ids = await administeredOrgIds(actor);
    if (ids.length === 0) return [];
    return prisma.organization.findMany({
        where: { id: { in: ids } },
        orderBy: { name: "asc" },
        select: { id: true, name: true }
    });
}

/** Every organization this account belongs to in any capacity. What `internal`
 *  visibility on an organization's space is measured against. */
export async function memberOrgIds(userId: string): Promise<string[]> {
    const [owned, member] = await Promise.all([
        prisma.organization.findMany({ where: { ownerId: userId }, select: { id: true } }),
        prisma.organizationMember.findMany({ where: { userId }, select: { orgId: true } })
    ]);
    return [...new Set([...owned.map((org) => org.id), ...member.map((row) => row.orgId)])];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface OrgSummary {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly image: string | null;
    readonly role: core.OrgAccess;
    readonly memberCount: number;
    readonly teamCount: number;
    readonly spaceCount: number;
}

/** The organizations this account is part of, owned ones first. */
export async function listMyOrgs(userId: string): Promise<OrgSummary[]> {
    const orgs = await prisma.organization.findMany({
        where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
        orderBy: { name: "asc" },
        select: {
            id: true,
            slug: true,
            name: true,
            description: true,
            image: true,
            ownerId: true,
            members: { where: { userId }, select: { role: true } },
            _count: { select: { members: true, teams: true, spaces: true } }
        }
    });

    return orgs
        .map((org) => ({
            id: org.id,
            slug: org.slug,
            name: org.name,
            description: org.description,
            image: org.image,
            role: (org.ownerId === userId ? "owner" : (org.members[0]?.role as core.OrgRole)) as core.OrgAccess,
            // The owner is not a member row, so the roster is always one longer
            // than the table says.
            memberCount: org._count.members + 1,
            teamCount: org._count.teams,
            spaceCount: org._count.spaces
        }))
        .sort((left, right) => Number(right.role === "owner") - Number(left.role === "owner"));
}

/** How many organizations this account owns, which is what the per-account cap
 *  is measured against. */
export async function ownedOrgCount(userId: string): Promise<number> {
    return prisma.organization.count({ where: { ownerId: userId } });
}

export async function orgIdForSlug(slug: string): Promise<string | null> {
    const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
    return org?.id ?? null;
}

export interface OrgDetail {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly image: string | null;
    readonly ownerId: string;
    readonly ownerName: string;
    readonly createdAt: string;
}

export async function getOrg(orgId: string): Promise<OrgDetail | null> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
            id: true,
            slug: true,
            name: true,
            description: true,
            image: true,
            ownerId: true,
            createdAt: true,
            owner: { select: { name: true } }
        }
    });
    if (!org) return null;
    return {
        id: org.id,
        slug: org.slug,
        name: org.name,
        description: org.description,
        image: org.image,
        ownerId: org.ownerId,
        ownerName: org.owner.name,
        createdAt: org.createdAt.toISOString()
    };
}

export interface OrgMemberView {
    readonly userId: string;
    readonly name: string;
    readonly email: string;
    readonly image: string | null;
    readonly role: core.OrgAccess;
    /** Team names this person is on, so the roster answers "what do they reach"
     *  without a second screen. */
    readonly teams: string[];
}

export async function listOrgMembers(orgId: string): Promise<OrgMemberView[]> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
            owner: { select: { id: true, name: true, email: true, image: true } },
            members: {
                orderBy: { createdAt: "asc" },
                select: { role: true, user: { select: { id: true, name: true, email: true, image: true } } }
            },
            teams: {
                select: { name: true, members: { select: { userId: true } } }
            }
        }
    });
    if (!org) return [];

    const teamsByUser = new Map<string, string[]>();
    for (const team of org.teams) {
        for (const member of team.members) {
            teamsByUser.set(member.userId, [...(teamsByUser.get(member.userId) ?? []), team.name]);
        }
    }

    const row = (
        user: { id: string; name: string; email: string; image: string | null },
        role: core.OrgAccess
    ): OrgMemberView => ({
        userId: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        role,
        teams: teamsByUser.get(user.id) ?? []
    });

    // The owner leads the roster and is not in the members table.
    return [row(org.owner, "owner"), ...org.members.map((member) => row(member.user, member.role as core.OrgRole))];
}

export interface TeamView {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly memberCount: number;
    readonly spaceCount: number;
    readonly folderCount: number;
}

export async function listTeams(orgId: string): Promise<TeamView[]> {
    const teams = await prisma.team.findMany({
        where: { orgId },
        orderBy: { name: "asc" },
        select: {
            id: true,
            slug: true,
            name: true,
            description: true,
            _count: { select: { members: true, spaceGrants: true, folderGrants: true } }
        }
    });
    return teams.map((team) => ({
        id: team.id,
        slug: team.slug,
        name: team.name,
        description: team.description,
        memberCount: team._count.members,
        spaceCount: team._count.spaceGrants,
        folderCount: team._count.folderGrants
    }));
}

export interface TeamMemberView {
    readonly userId: string;
    readonly name: string;
    readonly email: string;
    readonly image: string | null;
    readonly role: core.TeamRole;
}

export async function listTeamMembers(teamId: string): Promise<TeamMemberView[]> {
    const rows = await prisma.teamMember.findMany({
        where: { teamId },
        select: { role: true, user: { select: { id: true, name: true, email: true, image: true } } }
    });
    return rows
        .map((row) => ({
            userId: row.user.id,
            name: row.user.name,
            email: row.user.email,
            image: row.user.image,
            role: row.role as core.TeamRole
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
}

export interface TeamGrantView {
    readonly spaceId: string;
    readonly spaceName: string;
    readonly role: core.SpaceRole;
    /** Set when the grant is on one folder rather than the whole space. */
    readonly folderId: string | null;
    readonly folderName: string | null;
}

/** Everything a team can reach, whole spaces and single branches together, so
 *  one screen answers "what does joining this team give me". */
export async function listTeamGrants(teamId: string): Promise<TeamGrantView[]> {
    const [spaces, folders] = await Promise.all([
        prisma.taskSpaceTeam.findMany({
            where: { teamId },
            select: { role: true, space: { select: { id: true, name: true } } }
        }),
        prisma.taskFolderTeam.findMany({
            where: { teamId },
            select: {
                role: true,
                folder: { select: { id: true, name: true, space: { select: { id: true, name: true } } } }
            }
        })
    ]);

    return [
        ...spaces.map((grant) => ({
            spaceId: grant.space.id,
            spaceName: grant.space.name,
            role: grant.role as core.SpaceRole,
            folderId: null,
            folderName: null
        })),
        ...folders.map((grant) => ({
            spaceId: grant.folder.space.id,
            spaceName: grant.folder.space.name,
            role: grant.role as core.SpaceRole,
            folderId: grant.folder.id,
            folderName: grant.folder.name
        }))
    ].sort((left, right) => left.spaceName.localeCompare(right.spaceName));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Refuse a handle already spoken for.
 *
 * Organizations and accounts share one namespace, so `/o/acme` and a person
 * called `acme` can never both exist. Checked here rather than left to the unique
 * index because the index cannot see usernames, and a collision has to come back
 * as a sentence somebody can act on.
 */
async function assertSlugFree(slug: string, exceptOrgId?: string): Promise<void> {
    const [org, user] = await Promise.all([
        prisma.organization.findUnique({ where: { slug }, select: { id: true } }),
        prisma.user.findFirst({ where: { username: slug }, select: { id: true } })
    ]);
    if (org && org.id !== exceptOrgId) throw new OrgError("That handle is taken");
    if (user) throw new OrgError("That handle belongs to an account");
}

export async function createOrg(ownerId: string, input: core.OrganizationInput): Promise<string> {
    await assertSlugFree(input.slug);
    const org = await prisma.organization.create({
        data: { ownerId, slug: input.slug, name: input.name, description: input.description },
        select: { id: true }
    });
    return org.id;
}

export async function updateOrg(orgId: string, input: core.OrganizationProfileInput): Promise<void> {
    await prisma.organization.update({
        where: { id: orgId },
        data: { name: input.name, description: input.description }
    });
}

/** Move the handle. Separate from a rename because it breaks every link anybody
 *  saved, so it is never something a name edit does by accident. */
export async function changeOrgSlug(orgId: string, slug: string): Promise<void> {
    await assertSlugFree(slug, orgId);
    await prisma.organization.update({ where: { id: orgId }, data: { slug } });
}

/**
 * Hand the organization to somebody else on its roster.
 *
 * The new owner stops being a member row and the old one becomes an admin, so
 * the person who built it does not lose their way back in, and the invariant
 * that an owner is never also a member still holds afterwards.
 */
export async function transferOrg(orgId: string, toUserId: string): Promise<void> {
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { ownerId: true } });
    if (!org) throw new OrgError("That organization no longer exists");
    if (org.ownerId === toUserId) return;

    const membership = await prisma.organizationMember.findUnique({
        where: { orgId_userId: { orgId, userId: toUserId } },
        select: { id: true }
    });
    if (!membership) throw new OrgError("Only somebody already on the roster can be given the organization");

    await prisma.$transaction([
        prisma.organizationMember.delete({ where: { orgId_userId: { orgId, userId: toUserId } } }),
        prisma.organization.update({ where: { id: orgId }, data: { ownerId: toUserId } }),
        prisma.organizationMember.upsert({
            where: { orgId_userId: { orgId, userId: org.ownerId } },
            update: { role: "admin" },
            create: { orgId, userId: org.ownerId, role: "admin" }
        })
    ]);
}

/** Delete the organization and, with it, the spaces it owns. Deliberately not a
 *  lift-to-personal: work that belonged to a group has no obvious individual to
 *  fall to, and quietly handing it to whoever pressed delete is worse than
 *  saying what will go. */
export async function deleteOrg(orgId: string): Promise<void> {
    await prisma.organization.delete({ where: { id: orgId } });
}

/** What deleting an organization would take with it, so the confirmation can
 *  name it rather than asking "are you sure" about an unknown quantity. */
export async function orgDeletionImpact(orgId: string): Promise<{ spaces: number; tasks: number }> {
    const [spaces, tasks] = await Promise.all([
        prisma.taskSpace.count({ where: { orgId } }),
        prisma.task.count({ where: { space: { orgId } } })
    ]);
    return { spaces, tasks };
}

/** Add somebody by email or username, which is what the person doing it has in
 *  front of them rather than an id. */
export async function addOrgMember(orgId: string, identifier: string, role: core.OrgRole): Promise<void> {
    const needle = identifier.trim().toLowerCase();
    const user = await prisma.user.findFirst({
        where: { OR: [{ email: needle }, { username: needle }] },
        select: { id: true }
    });
    if (!user) throw new OrgError("No account matches that email or username");

    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { ownerId: true } });
    if (org?.ownerId === user.id) throw new OrgError("That person already owns this organization");

    const policy = await organizationPolicy();
    const existing = await prisma.organizationMember.findUnique({
        where: { orgId_userId: { orgId, userId: user.id } },
        select: { id: true }
    });
    // Only a genuinely new member counts against the cap; changing somebody's
    // role must not be refused because the roster is full.
    if (!existing) {
        const count = await prisma.organizationMember.count({ where: { orgId } });
        if (!core.withinLimit(policy.maxMembers, count + 1)) {
            throw new OrgError(`This organization is at the ${policy.maxMembers}-member limit for this Polaris`);
        }
    }

    await prisma.organizationMember.upsert({
        where: { orgId_userId: { orgId, userId: user.id } },
        update: { role },
        create: { orgId, userId: user.id, role }
    });
}

export async function setOrgMemberRole(orgId: string, userId: string, role: core.OrgRole): Promise<void> {
    await prisma.organizationMember.update({ where: { orgId_userId: { orgId, userId } }, data: { role } });
}

/** Take somebody off the roster, and off every team with it - a team membership
 *  outliving the organization membership would keep handing them work. */
export async function removeOrgMember(orgId: string, userId: string): Promise<void> {
    await prisma.$transaction([
        prisma.teamMember.deleteMany({ where: { userId, team: { orgId } } }),
        prisma.organizationMember.deleteMany({ where: { orgId, userId } })
    ]);
}

export async function createTeam(orgId: string, input: core.TeamInput): Promise<string> {
    const policy = await organizationPolicy();
    const count = await prisma.team.count({ where: { orgId } });
    if (!core.withinLimit(policy.maxTeams, count)) {
        throw new OrgError(`This organization is at the ${policy.maxTeams}-team limit for this Polaris`);
    }
    const clash = await prisma.team.findUnique({
        where: { orgId_slug: { orgId, slug: input.slug } },
        select: { id: true }
    });
    if (clash) throw new OrgError("This organization already has a team with that handle");

    const team = await prisma.team.create({
        data: { orgId, slug: input.slug, name: input.name, description: input.description },
        select: { id: true }
    });
    return team.id;
}

export async function updateTeam(teamId: string, input: core.TeamInput): Promise<void> {
    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { orgId: true } });
    if (!team) throw new OrgError("That team no longer exists");
    const clash = await prisma.team.findUnique({
        where: { orgId_slug: { orgId: team.orgId, slug: input.slug } },
        select: { id: true }
    });
    if (clash && clash.id !== teamId) throw new OrgError("This organization already has a team with that handle");

    await prisma.team.update({
        where: { id: teamId },
        data: { slug: input.slug, name: input.name, description: input.description }
    });
}

export async function deleteTeam(teamId: string): Promise<void> {
    await prisma.team.delete({ where: { id: teamId } });
}

/** Put somebody on a team. Only people already on the organization's roster:
 *  a team is a subset of the organization, never a way around joining it. */
export async function addTeamMember(teamId: string, identifier: string, role: core.TeamRole): Promise<void> {
    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { orgId: true } });
    if (!team) throw new OrgError("That team no longer exists");

    const needle = identifier.trim().toLowerCase();
    const user = await prisma.user.findFirst({
        where: { OR: [{ email: needle }, { username: needle }] },
        select: { id: true }
    });
    if (!user) throw new OrgError("No account matches that email or username");

    const org = await prisma.organization.findUnique({ where: { id: team.orgId }, select: { ownerId: true } });
    const onRoster =
        org?.ownerId === user.id ||
        (await prisma.organizationMember.findUnique({
            where: { orgId_userId: { orgId: team.orgId, userId: user.id } },
            select: { id: true }
        })) !== null;
    if (!onRoster) throw new OrgError("Add them to the organization first");

    await prisma.teamMember.upsert({
        where: { teamId_userId: { teamId, userId: user.id } },
        update: { role },
        create: { teamId, userId: user.id, role }
    });
}

export async function setTeamMemberRole(teamId: string, userId: string, role: core.TeamRole): Promise<void> {
    await prisma.teamMember.update({ where: { teamId_userId: { teamId, userId } }, data: { role } });
}

export async function removeTeamMember(teamId: string, userId: string): Promise<void> {
    await prisma.teamMember.deleteMany({ where: { teamId, userId } });
}

// ---------------------------------------------------------------------------
// Team grants over work
// ---------------------------------------------------------------------------

/** Grant, or re-grant at a different role, a team's access to a whole space. */
export async function grantTeamSpace(teamId: string, spaceId: string, role: core.SpaceRole): Promise<void> {
    await prisma.taskSpaceTeam.upsert({
        where: { spaceId_teamId: { spaceId, teamId } },
        update: { role },
        create: { spaceId, teamId, role }
    });
}

export async function revokeTeamSpace(teamId: string, spaceId: string): Promise<void> {
    await prisma.taskSpaceTeam.deleteMany({ where: { teamId, spaceId } });
}

export async function grantTeamFolder(teamId: string, folderId: string, role: core.SpaceRole): Promise<void> {
    await prisma.taskFolderTeam.upsert({
        where: { folderId_teamId: { folderId, teamId } },
        update: { role },
        create: { folderId, teamId, role }
    });
}

export async function revokeTeamFolder(teamId: string, folderId: string): Promise<void> {
    await prisma.taskFolderTeam.deleteMany({ where: { teamId, folderId } });
}

/** The teams a space can be granted to: the ones belonging to the organization
 *  that owns it. A personal space has none, which is what makes the picker say
 *  so rather than offering somebody else's teams. */
export async function teamsForSpace(spaceId: string): Promise<{ id: string; name: string }[]> {
    const space = await prisma.taskSpace.findUnique({ where: { id: spaceId }, select: { orgId: true } });
    if (!space?.orgId) return [];
    return prisma.team.findMany({
        where: { orgId: space.orgId },
        orderBy: { name: "asc" },
        select: { id: true, name: true }
    });
}

/** The teams currently granted a space, for the space's own access screen. */
export async function spaceTeamGrants(
    spaceId: string
): Promise<{ teamId: string; teamName: string; role: core.SpaceRole }[]> {
    const grants = await prisma.taskSpaceTeam.findMany({
        where: { spaceId },
        select: { teamId: true, role: true, team: { select: { name: true } } }
    });
    return grants
        .map((grant) => ({ teamId: grant.teamId, teamName: grant.team.name, role: grant.role as core.SpaceRole }))
        .sort((left, right) => left.teamName.localeCompare(right.teamName));
}

/** The same for one folder, so a branch can be handed to a team without opening
 *  the space around it. */
export async function folderTeamGrants(
    folderId: string
): Promise<{ teamId: string; teamName: string; role: core.SpaceRole }[]> {
    const grants = await prisma.taskFolderTeam.findMany({
        where: { folderId },
        select: { teamId: true, role: true, team: { select: { name: true } } }
    });
    return grants
        .map((grant) => ({ teamId: grant.teamId, teamName: grant.team.name, role: grant.role as core.SpaceRole }))
        .sort((left, right) => left.teamName.localeCompare(right.teamName));
}

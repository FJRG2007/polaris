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
import { ensureSystemRoles } from "./role-service";
import { OrgAccessError, OrgError } from "./errors";
import { contactLines } from "@/lib/privacy-service";
import { discardAvatars } from "@/lib/avatar-service";
import { isOrgSuccessor } from "@/lib/successor-service";

export { OrgAccessError, OrgError } from "./errors";

/** The caller, as the action layer resolved them. An instance administrator is
 *  treated as an owner so whoever runs the deployment is never locked out of an
 *  organization on it. */
export interface OrgActor {
    readonly id: string;
    readonly isAdmin: boolean;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * What one account may do inside one organization.
 *
 * The role is a slug the organization itself defined, so it means nothing on its
 * own; `permissions` is what every check is made against. The owner is resolved
 * to the wildcard rather than to a row, because the owner is not a member row and
 * never has been - which is what keeps "remove everybody" survivable.
 */
export interface OrgMembership {
    readonly orgId: string;
    /** The role's slug, or "owner". Shown, never used to decide anything. */
    readonly role: string;
    /** What that role is called here, which is the form worth putting on screen. */
    readonly roleName: string;
    readonly isOwner: boolean;
    readonly permissions: readonly string[];
}

/** What this actor may do across a whole organization, or null when it is not
 *  theirs to see. */
export async function resolveOrgAccess(
    actor: OrgActor,
    orgId: string
): Promise<OrgMembership | null> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { ownerId: true, members: { where: { userId: actor.id }, select: { role: true } } }
    });
    if (!org) return null;
    if (org.ownerId === actor.id || actor.isAdmin) {
        return {
            orgId,
            role: "owner",
            roleName: "Owner",
            isOwner: true,
            permissions: [core.ALL_ORG_PERMISSIONS]
        };
    }
    const slug = org.members[0]?.role;
    if (!slug) {
        // The successor the owner named is answered rather than turned away, so
        // the one act they may perform has a screen to be performed on - and is
        // answered with nothing at all, `org.read` included. That absence is
        // load-bearing: every screen anybody on the roster can open is gated on
        // `org.read`, so a successor gets the frame and the settings screen and
        // not the roster. Naming somebody to close your organizations when you
        // die is not handing them the list of who works in them today.
        // Asked of the organization rather than of its owner: an organization
        // that has named its own successor is answered by that person, and one
        // that has not still falls back to the owner's - see `isOrgSuccessor`.
        return (await isOrgSuccessor(actor.id, orgId))
            ? { orgId, role: "successor", roleName: "Successor", isOwner: false, permissions: [] }
            : null;
    }
    const role = await roleFor(orgId, slug);
    return {
        orgId,
        role: slug,
        roleName: role.name,
        isOwner: false,
        permissions: role.permissions
    };
}

/**
 * One role slug, as this organization defines it.
 *
 * Read from the organization's own roles, and falling back to the seeded
 * definition when no row answers. The fallback is not decoration: a membership
 * naming a role that has gone missing must resolve to what that slug has always
 * meant, never to nothing (which would lock a whole roster out of a place they
 * belong) and never to everything.
 */
async function roleFor(
    orgId: string,
    slug: string
): Promise<{ name: string; permissions: readonly string[] }> {
    const role = await prisma.orgRole.findUnique({
        where: { orgId_slug: { orgId, slug } },
        select: { name: true, permissions: true }
    });
    if (role) return { name: role.name, permissions: withRead(parsePermissions(role.permissions)) };
    const seeded = core.ORG_SYSTEM_ROLES[slug];
    return { name: seeded?.name ?? slug, permissions: withRead(seeded?.permissions ?? []) };
}

/**
 * Seeing the organization is what being on its roster means.
 *
 * Added here rather than made a box in the role editor, because a role that can
 * run the teams but not open the organization is not a configuration anybody
 * wants - it is a person who belongs somewhere and gets a 404 for it. So it comes
 * with every role, and the editor does not offer to take it away.
 */
function withRead(permissions: readonly string[]): readonly string[] {
    return permissions.includes("org.read") ? permissions : [...permissions, "org.read"];
}

/** Stored as JSON so one column carries the set. Anything unreadable grants
 *  nothing, which is the safe direction for a permission list. */
function parsePermissions(raw: string): string[] {
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((value): value is string => typeof value === "string")
            : [];
    } catch {
        return [];
    }
}

export function orgCan(access: OrgMembership | null, permission: core.OrgPermission): boolean {
    return access !== null && core.hasOrgPermission(access.permissions, permission);
}

/** Clear the actor for one thing they are trying to do here. Every write in the
 *  organization goes through this, and nothing else decides access. */
export async function requireOrgPermission(
    actor: OrgActor,
    orgId: string,
    permission: core.OrgPermission
): Promise<OrgMembership> {
    const access = await resolveOrgAccess(actor, orgId);
    if (!access) throw new OrgAccessError();
    if (!orgCan(access, permission)) {
        throw new OrgAccessError("You do not have permission to do that in this organization");
    }
    return access;
}

/** Handing the organization on. Never a permission, so no role anybody writes
 *  can end up able to give the organization away. An instance administrator
 *  counts, and nobody else does. */
export async function requireOrgOwner(actor: OrgActor, orgId: string): Promise<void> {
    const access = await resolveOrgAccess(actor, orgId);
    if (!access?.isOwner) throw new OrgAccessError("Only the organization's owner can do that");
}

/**
 * Whether this actor may end the organization, and nothing weaker.
 *
 * Three names, and deliberately not the same three as everything else here. The
 * owner, because it is theirs. An instance administrator, because somebody has
 * to be able to clear up after an account that is gone. And the successor - the
 * one this organization named, or failing that the one its owner named on their
 * own account - which is the whole point of naming one: an organization whose
 * only owner has died is otherwise permanent, and asking an administrator to
 * guess at the family's intentions is worse than letting the person the owner
 * actually chose decide.
 *
 * A permission cannot reach this and never will. Everything else about an
 * organization is recoverable by whoever comes next; this is the one act that
 * takes the spaces and the work with it.
 */
export async function canDeleteOrg(actor: OrgActor, orgId: string): Promise<boolean> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { ownerId: true }
    });
    if (!org) return false;
    if (actor.isAdmin || org.ownerId === actor.id) return true;
    return isOrgSuccessor(actor.id, orgId);
}

export async function requireOrgDeletion(actor: OrgActor, orgId: string): Promise<void> {
    if (!(await canDeleteOrg(actor, orgId))) {
        throw new OrgAccessError(
            "Only the owner, the successor they named, or an administrator can delete an organization"
        );
    }
}

/**
 * Clear the actor for one team, and say whether they may change its roster.
 *
 * A team is run by its maintainers as well as by whoever the organization gave
 * `teams.manage`, which is the whole point of the team role: a team lead adds and
 * removes their own people without being handed the organization.
 */
export async function requireTeam(
    actor: OrgActor,
    teamId: string,
    minimum: "read" | "manage"
): Promise<{ orgId: string; access: OrgMembership; canManage: boolean }> {
    const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: { orgId: true, members: { where: { userId: actor.id }, select: { role: true } } }
    });
    if (!team) throw new OrgAccessError("That team no longer exists");
    const access = await resolveOrgAccess(actor, team.orgId);
    if (!access) throw new OrgAccessError();
    const canManage = orgCan(access, "teams.manage") || team.members[0]?.role === "maintainer";
    if (minimum === "manage" && !canManage) {
        throw new OrgAccessError(
            "Only somebody who runs the teams here, or a maintainer of this one, can do that"
        );
    }
    return { orgId: team.orgId, access, canManage };
}

/** Every team this account is on. The one thing the Tasks access layer needs
 *  from this module, which is why it takes an id and returns ids. */
export async function teamIdsFor(userId: string): Promise<string[]> {
    const rows = await prisma.teamMember.findMany({ where: { userId }, select: { teamId: true } });
    return rows.map((row) => row.teamId);
}

/**
 * Every organization where this account holds one permission.
 *
 * Two queries rather than a check per organization: the memberships come back
 * with the role rows they name, so a person on forty organizations is answered in
 * one read of each table. Owned organizations are always in, because the owner
 * holds everything and is never a member row.
 */
export async function orgIdsWhere(
    actor: OrgActor,
    permission: core.OrgPermission
): Promise<string[]> {
    if (actor.isAdmin) {
        const all = await prisma.organization.findMany({ select: { id: true } });
        return all.map((org) => org.id);
    }
    const [owned, memberships] = await Promise.all([
        prisma.organization.findMany({ where: { ownerId: actor.id }, select: { id: true } }),
        prisma.organizationMember.findMany({
            where: { userId: actor.id },
            select: {
                orgId: true,
                role: true,
                org: { select: { roles: { select: { slug: true, permissions: true } } } }
            }
        })
    ]);

    const granted = memberships
        .filter((membership) => {
            const row = membership.org.roles.find((role) => role.slug === membership.role);
            const permissions = row
                ? parsePermissions(row.permissions)
                : (core.ORG_SYSTEM_ROLES[membership.role]?.permissions ?? []);
            return core.hasOrgPermission(permissions, permission);
        })
        .map((membership) => membership.orgId);

    return [...new Set([...owned.map((org) => org.id), ...granted])];
}

/** Every organization whose work this account administers. What a space asks when
 *  it needs to know whether its organization opens it to the reader. */
export async function administeredOrgIds(actor: OrgActor): Promise<string[]> {
    return orgIdsWhere(actor, "spaces.manage");
}

/** The organizations this account can create work for, named. What the "who owns
 *  this space" picker is built from - somebody who only belongs to an
 *  organization is not offered it, because putting a space on the group's shelf
 *  takes being allowed to run its work. */
export async function listAdministeredOrgs(
    actor: OrgActor
): Promise<{ id: string; name: string }[]> {
    return listOrgsByIds(await administeredOrgIds(actor));
}

async function listOrgsByIds(ids: readonly string[]): Promise<{ id: string; name: string }[]> {
    if (ids.length === 0) return [];
    return prisma.organization.findMany({
        where: { id: { in: [...ids] } },
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
    /** The role's slug, or "owner". */
    readonly role: string;
    /** What that role is called here, which is the only form worth showing. */
    readonly roleName: string;
    readonly memberCount: number;
    readonly teamCount: number;
    readonly spaceCount: number;
}

/**
 * The organizations this account is part of, owned ones first.
 *
 * Organizations this account is the successor for are in the list too, marked as
 * such. They are not somewhere this person works - they cannot change anything in
 * one - but leaving them out would mean the one act a successor exists to
 * perform has nowhere to be reached from.
 *
 * Two ways to be that successor and the second has to exclude the first: named
 * by the organization itself, or named by its owner on their own account *and*
 * the organization having named nobody. Without that second condition an owner's
 * personal successor would keep seeing an organization that has since chosen
 * somebody else - which is not a leak, but it is a list that disagrees with what
 * `isOrgSuccessor` will actually allow them to do when they open it.
 */
export async function listMyOrgs(userId: string): Promise<OrgSummary[]> {
    const orgs = await prisma.organization.findMany({
        where: {
            OR: [
                { ownerId: userId },
                { members: { some: { userId } } },
                { successor: { successorId: userId } },
                {
                    AND: [{ successor: null }, { owner: { successor: { successorId: userId } } }]
                }
            ]
        },
        orderBy: { name: "asc" },
        select: {
            id: true,
            slug: true,
            name: true,
            description: true,
            image: true,
            ownerId: true,
            members: { where: { userId }, select: { role: true } },
            roles: { select: { slug: true, name: true } },
            _count: { select: { members: true, teams: true, spaces: true } }
        }
    });

    return orgs
        .map((org) => {
            const owner = org.ownerId === userId;
            // Not on the roster and not the owner leaves one way to be here: the
            // owner named this account their successor.
            const member = org.members[0]?.role;
            const slug = owner ? "owner" : (member ?? "successor");
            return {
                id: org.id,
                slug: org.slug,
                name: org.name,
                description: org.description,
                image: org.image,
                role: slug,
                roleName: owner
                    ? "Owner"
                    : member
                      ? roleDisplayName(org.roles, member)
                      : "Successor",
                // The owner is not a member row, so the roster is always one
                // longer than the table says.
                memberCount: org._count.members + 1,
                teamCount: org._count.teams,
                spaceCount: org._count.spaces
            };
        })
        .sort((left, right) => Number(right.role === "owner") - Number(left.role === "owner"));
}

/** What a role slug is called. Falls back to the seeded name, and then to the
 *  slug itself, so a roster never shows a person with no role at all. */
function roleDisplayName(roles: readonly { slug: string; name: string }[], slug: string): string {
    return (
        roles.find((role) => role.slug === slug)?.name ?? core.ORG_SYSTEM_ROLES[slug]?.name ?? slug
    );
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
    /** Whether a photo has been uploaded, which is what the settings card offers
     *  to replace rather than to add. */
    readonly hasPhoto: boolean;
    /** The same, for the band across the top of its page. */
    readonly hasBanner: boolean;
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
            owner: { select: { name: true } },
            avatar: { select: { orgId: true } },
            banner: { select: { orgId: true } }
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
        createdAt: org.createdAt.toISOString(),
        hasPhoto: org.avatar !== null,
        hasBanner: org.banner !== null
    };
}

/** What an organization holds, for the screen that opens on it. Counted rather
 *  than listed: the overview says how much there is and every number is a link
 *  to the screen that shows it. */
export interface OrgTotals {
    readonly members: number;
    readonly teams: number;
    readonly spaces: number;
    readonly projects: number;
    readonly domains: number;
    readonly roles: number;
}

export async function orgTotals(orgId: string): Promise<OrgTotals> {
    const [members, teams, spaces, projects, domains, roles] = await Promise.all([
        prisma.organizationMember.count({ where: { orgId } }),
        prisma.team.count({ where: { orgId } }),
        prisma.taskSpace.count({ where: { orgId } }),
        prisma.project.count({ where: { orgId } }),
        prisma.ownerDomain.count({ where: { orgId } }),
        prisma.orgRole.count({ where: { orgId } })
    ]);
    // The owner is not a member row, so the roster is always one longer than the
    // table says.
    return { members: members + 1, teams, spaces, projects, domains, roles };
}

export interface OrgMemberView {
    readonly userId: string;
    readonly name: string;
    /**
     * The line under their name: their address if they let this reader see it,
     * their handle otherwise.
     *
     * Never the address itself. A roster is the widest audience a person has
     * here - everybody invited into the organization, for as long as they are in
     * it - and it used to hand every one of them everybody's address.
     */
    readonly contact: string;
    /** The role's slug, or "owner". */
    readonly role: string;
    /** What that role is called here. */
    readonly roleName: string;
    /** When they joined, so the roster can say how long somebody has been here. */
    readonly joinedAt: string | null;
    /** Team names this person is on, so the roster answers "what do they reach"
     *  without a second screen. */
    readonly teams: string[];
}

export async function listOrgMembers(orgId: string, viewer: OrgActor): Promise<OrgMemberView[]> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
            createdAt: true,
            owner: { select: { id: true, name: true, email: true, username: true } },
            members: {
                orderBy: { createdAt: "asc" },
                select: {
                    role: true,
                    createdAt: true,
                    user: {
                        select: { id: true, name: true, email: true, username: true }
                    }
                }
            },
            roles: { select: { slug: true, name: true } },
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

    const contacts = await contactLines({ id: viewer.id, isAdmin: viewer.isAdmin }, [
        org.owner,
        ...org.members.map((member) => member.user)
    ]);

    const row = (
        user: { id: string; name: string },
        role: string,
        joinedAt: Date
    ): OrgMemberView => ({
        userId: user.id,
        name: user.name,
        contact: contacts.get(user.id) ?? "",
        role,
        roleName: role === "owner" ? "Owner" : roleDisplayName(org.roles, role),
        joinedAt: joinedAt.toISOString(),
        teams: teamsByUser.get(user.id) ?? []
    });

    // The owner leads the roster and is not in the members table, so their own
    // joining date is the organization's.
    return [
        row(org.owner, "owner", org.createdAt),
        ...org.members.map((member) => row(member.user, member.role, member.createdAt))
    ];
}

export interface OrgSpaceView {
    readonly id: string;
    readonly name: string;
    readonly prefix: string;
    readonly color: string;
    readonly visibility: string;
    readonly archived: boolean;
    readonly taskCount: number;
    /** The teams that reach it, named, so the question this screen exists to
     *  answer - "who can actually see this work" - is answered on the row. */
    readonly teams: string[];
}

/** The work this organization owns. Archived spaces are included and marked:
 *  they are still the organization's, and hiding them here is how somebody
 *  concludes a space was deleted. */
export async function listOrgSpaces(orgId: string): Promise<OrgSpaceView[]> {
    const spaces = await prisma.taskSpace.findMany({
        where: { orgId },
        orderBy: [{ archived: "asc" }, { order: "asc" }],
        select: {
            id: true,
            name: true,
            prefix: true,
            color: true,
            visibility: true,
            archived: true,
            teamGrants: { select: { team: { select: { name: true } } } },
            _count: { select: { tasks: true } }
        }
    });
    return spaces.map((space) => ({
        id: space.id,
        name: space.name,
        prefix: space.prefix,
        color: space.color,
        visibility: space.visibility,
        archived: space.archived,
        taskCount: space._count.tasks,
        teams: space.teamGrants
            .map((grant) => grant.team.name)
            .sort((left, right) => left.localeCompare(right))
    }));
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
    /** As on the roster: their address only if they allow this reader it. */
    readonly contact: string;
    readonly role: core.TeamRole;
}

export async function listTeamMembers(teamId: string, viewer: OrgActor): Promise<TeamMemberView[]> {
    const rows = await prisma.teamMember.findMany({
        where: { teamId },
        select: {
            role: true,
            user: { select: { id: true, name: true, email: true, username: true } }
        }
    });
    const contacts = await contactLines(
        { id: viewer.id, isAdmin: viewer.isAdmin },
        rows.map((row) => row.user)
    );
    return rows
        .map((row) => ({
            userId: row.user.id,
            name: row.user.name,
            contact: contacts.get(row.user.id) ?? "",
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
                folder: {
                    select: { id: true, name: true, space: { select: { id: true, name: true } } }
                }
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
        data: {
            ownerId,
            slug: input.slug,
            name: input.name,
            description: input.description,
            // Seeded with the create so the organization is usable before anybody
            // opens the roles screen, and so the first person added has something
            // to be given.
            roles: {
                create: Object.entries(core.ORG_SYSTEM_ROLES).map(([slug, role]) => ({
                    slug,
                    name: role.name,
                    description: role.description,
                    permissions: JSON.stringify(role.permissions),
                    system: true
                }))
            }
        },
        select: { id: true }
    });
    return org.id;
}

export async function updateOrg(
    orgId: string,
    input: core.OrganizationProfileInput
): Promise<void> {
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
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { ownerId: true }
    });
    if (!org) throw new OrgError("That organization no longer exists");
    if (org.ownerId === toUserId) return;

    const membership = await prisma.organizationMember.findUnique({
        where: { orgId_userId: { orgId, userId: toUserId } },
        select: { id: true }
    });
    if (!membership)
        throw new OrgError("Only somebody already on the roster can be given the organization");

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

/**
 * Delete the organization and, with it, the spaces it owns. Deliberately not a
 * lift-to-personal: work that belonged to a group has no obvious individual to
 * fall to, and quietly handing it to whoever pressed delete is worse than saying
 * what will go.
 *
 * Answers whatever could not be taken off a storage, for the audit entry - a NAS
 * that is away must not be able to refuse a deletion somebody confirmed, and the
 * log is then the only place an operator learns there is a folder to sweep up.
 */
export async function deleteOrg(orgId: string): Promise<string[]> {
    // The row cascade takes the organization's deploy projects with it, and a
    // cascade cannot stop a container: without this the services it was running
    // stay up on their servers with nothing left in Polaris pointing at them.
    // Reached at call time because deploy-service reads organizations from here.
    const projects = await prisma.project.findMany({
        where: { orgId },
        select: { id: true, ownerId: true }
    });
    if (projects.length > 0) {
        const { tearDownProject } = await import("@/lib/deploy-service");
        for (const project of projects) {
            await tearDownProject(project.id, project.ownerId);
        }
    }
    // Its photo, before the row saying where it is cascades away with it.
    const leftBehind = await discardAvatars("org", orgId);
    // And the company's own shelf, for the same reason and with the same rule.
    // The Drive row carries the organization's id, so it cascades away with the
    // organization and takes with it the only record of where a company's whole
    // document store is - the bytes stay on the disk under a folder named after
    // an id nothing points at any more.
    const { discardOrganizationDrive } = await import("@/lib/organization-drive");
    const driveLeft = await discardOrganizationDrive(orgId);
    if (driveLeft) leftBehind.push(driveLeft);
    await prisma.organization.delete({ where: { id: orgId } });
    return leftBehind;
}

/** What deleting an organization would take with it, so the confirmation can
 *  name it rather than asking "are you sure" about an unknown quantity. */
export interface OrgDeletionImpact {
    readonly spaces: number;
    readonly tasks: number;
    readonly projects: number;
    /** Whether the organization has a Drive of its own. A count of what is on it
     *  would be a walk of a whole storage for one line of a confirmation. */
    readonly drive: boolean;
}

export async function orgDeletionImpact(orgId: string): Promise<OrgDeletionImpact> {
    const [spaces, tasks, projects, drive] = await Promise.all([
        prisma.taskSpace.count({ where: { orgId } }),
        prisma.task.count({ where: { space: { orgId } } }),
        // Named because this is the part that is not just a row: the services
        // these projects run are stopped and removed from their servers.
        prisma.project.count({ where: { orgId } }),
        // Whether there is a company shelf, rather than what is on it: counting
        // the files means walking a whole storage to draw one line of a
        // confirmation. That there IS a Drive going is the part somebody is
        // wrong about.
        prisma.storageConnection.count({ where: { orgId } })
    ]);
    return { spaces, tasks, projects, drive: drive > 0 };
}

/**
 * Refuse a role this organization does not have.
 *
 * A slug arrives from a form, so it is a claim like any other. Checked against
 * the organization's own roles rather than a fixed list, because that list is
 * exactly what an organization is allowed to change - and a membership naming a
 * role nobody defined would resolve to the seeded fallback, quietly granting
 * something nobody chose.
 */
async function assertRoleExists(orgId: string, slug: string): Promise<void> {
    const role = await prisma.orgRole.findUnique({
        where: { orgId_slug: { orgId, slug } },
        select: { id: true }
    });
    if (!role) throw new OrgError("This organization has no role by that name");
}

/**
 * Nobody is added to a roster here.
 *
 * Joining an organization takes an invitation and an answer - see
 * `invitation-service`. This module writes a membership row only when one is
 * accepted, and when the organization is handed to somebody else below.
 */
export async function setOrgMemberRole(orgId: string, userId: string, role: string): Promise<void> {
    await ensureSystemRoles(orgId);
    await assertRoleExists(orgId, role);
    await prisma.organizationMember.update({
        where: { orgId_userId: { orgId, userId } },
        data: { role }
    });
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
        throw new OrgError(
            `This organization is at the ${policy.maxTeams}-team limit for this Polaris`
        );
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
    if (clash && clash.id !== teamId)
        throw new OrgError("This organization already has a team with that handle");

    await prisma.team.update({
        where: { id: teamId },
        data: { slug: input.slug, name: input.name, description: input.description }
    });
}

export async function deleteTeam(teamId: string): Promise<void> {
    await prisma.team.delete({ where: { id: teamId } });
}

/** Put somebody on a team. Only people already on the organization's roster:
 *  a team is a subset of the organization, never a way around joining it.
 *
 *  Answers with the account the identifier resolved to, so nothing downstream
 *  has to keep the address somebody typed. */
export async function addTeamMember(
    teamId: string,
    identifier: string,
    role: core.TeamRole
): Promise<string> {
    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { orgId: true } });
    if (!team) throw new OrgError("That team no longer exists");

    const needle = identifier.trim().toLowerCase();
    const user = await prisma.user.findFirst({
        where: { OR: [{ email: needle }, { username: needle }] },
        select: { id: true }
    });
    if (!user) throw new OrgError("No account matches that email or username");

    const org = await prisma.organization.findUnique({
        where: { id: team.orgId },
        select: { ownerId: true }
    });
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

    return user.id;
}

export async function setTeamMemberRole(
    teamId: string,
    userId: string,
    role: core.TeamRole
): Promise<void> {
    await prisma.teamMember.update({
        where: { teamId_userId: { teamId, userId } },
        data: { role }
    });
}

export async function removeTeamMember(teamId: string, userId: string): Promise<void> {
    await prisma.teamMember.deleteMany({ where: { teamId, userId } });
}

// ---------------------------------------------------------------------------
// Team grants over work
// ---------------------------------------------------------------------------

/** Grant, or re-grant at a different role, a team's access to a whole space. */
export async function grantTeamSpace(
    teamId: string,
    spaceId: string,
    role: core.SpaceRole
): Promise<void> {
    await prisma.taskSpaceTeam.upsert({
        where: { spaceId_teamId: { spaceId, teamId } },
        update: { role },
        create: { spaceId, teamId, role }
    });
}

export async function revokeTeamSpace(teamId: string, spaceId: string): Promise<void> {
    await prisma.taskSpaceTeam.deleteMany({ where: { teamId, spaceId } });
}

export async function grantTeamFolder(
    teamId: string,
    folderId: string,
    role: core.SpaceRole
): Promise<void> {
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
    const space = await prisma.taskSpace.findUnique({
        where: { id: spaceId },
        select: { orgId: true }
    });
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
        .map((grant) => ({
            teamId: grant.teamId,
            teamName: grant.team.name,
            role: grant.role as core.SpaceRole
        }))
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
        .map((grant) => ({
            teamId: grant.teamId,
            teamName: grant.team.name,
            role: grant.role as core.SpaceRole
        }))
        .sort((left, right) => left.teamName.localeCompare(right.teamName));
}

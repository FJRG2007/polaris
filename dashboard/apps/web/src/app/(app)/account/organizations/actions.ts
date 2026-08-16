"use server";

/**
 * Every write an organization or one of its teams takes.
 *
 * Same three steps as the rest of the dashboard, in the same order: establish
 * who is asking, establish what they may do in this organization, then validate
 * the payload against the shared schema before it reaches the service. The
 * client's copy of that schema is what shows errors as somebody types; this one
 * is what makes them true.
 *
 * Errors come back as `{ error }` rather than thrown, because a rejected server
 * action inside a transition escalates to the nearest error boundary and would
 * replace the whole screen over one refused write.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { proveStepUp } from "@/lib/step-up";
import * as orgs from "@/lib/orgs/org-service";
import * as roles from "@/lib/orgs/role-service";
import { recordAudit } from "@/lib/audit-service";
import { canCreateOrganization } from "@/lib/orgs/policy";
import * as invitations from "@/lib/orgs/invitation-service";

const ORGS_PATH = "/account/organizations";

async function actor(): Promise<orgs.OrgActor> {
    const user = await requireUser();
    return { id: user.id, isAdmin: user.isAdmin };
}

function failure(caught: unknown, fallback: string): { error: string } {
    if (caught instanceof orgs.OrgError) return { error: caught.message };
    console.error(caught);
    return { error: fallback };
}

/** An organization change can move what the Tasks app shows as well, since a
 *  team grant is how work is reached, so both subtrees are revalidated. */
function refresh(): void {
    revalidatePath(ORGS_PATH, "layout");
    revalidatePath("/tasks", "layout");
}

/**
 * Write one line of the organization's own history.
 *
 * `orgId` is what separates it from the actor's personal history: the same table
 * carries both, and an organization's Activity screen is exactly the entries that
 * name it. Kept to one helper so no write here can forget to stamp it - an entry
 * without the id is one the organization can never see.
 */
async function record(
    actorId: string,
    orgId: string,
    action: string,
    metadata?: Record<string, unknown>
): Promise<void> {
    await recordAudit({ actorId, orgId, action, targetType: "org", targetId: orgId, metadata });
}

// ---------------------------------------------------------------------------
// The organization itself
// ---------------------------------------------------------------------------

export async function createOrgAction(input: unknown): Promise<{ slug?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.organizationSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        // The instance policy is checked here rather than in the service, so the
        // one place that says "may this account start one" is also the place the
        // screen asks to decide whether to offer the button.
        const allowed = await canCreateOrganization(
            caller.isAdmin,
            await orgs.ownedOrgCount(caller.id)
        );
        if (!allowed.ok) return { error: allowed.reason };

        const id = await orgs.createOrg(caller.id, parsed.data);
        await record(caller.id, id, "org.create", { name: parsed.data.name });
        refresh();
        return { slug: parsed.data.slug };
    } catch (caught) {
        return failure(caught, "Could not create the organization");
    }
}

export async function updateOrgAction(orgId: string, input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.organizationProfileSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        // The name, the description and the photo are settings, not ownership:
        // whoever the organization trusted with its settings may change them.
        await orgs.requireOrgPermission(caller, orgId, "settings.manage");
        await orgs.updateOrg(orgId, parsed.data);
        await record(caller.id, orgId, "org.update", { name: parsed.data.name });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the organization");
    }
}

export async function changeOrgSlugAction(
    orgId: string,
    slug: unknown
): Promise<{ slug?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.orgSlugField.safeParse(slug);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the handle and try again" };
    try {
        await orgs.requireOrgPermission(caller, orgId, "settings.manage");
        await orgs.changeOrgSlug(orgId, parsed.data);
        await record(caller.id, orgId, "org.rename", { slug: parsed.data });
        refresh();
        return { slug: parsed.data };
    } catch (caught) {
        return failure(caught, "Could not change the handle");
    }
}

export async function transferOrgAction(
    orgId: string,
    toUserId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await orgs.requireOrgOwner(caller, orgId);
        await orgs.transferOrg(orgId, toUserId);
        await record(caller.id, orgId, "org.transfer", { toUserId });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not hand over the organization");
    }
}

/**
 * End an organization.
 *
 * Two gates rather than one. The first says who may: the owner, the successor
 * they named, or an instance administrator, and no role in between. The second
 * asks that person to prove they are still themselves - this takes every space
 * and every task in the organization with it, and an open session left on a
 * borrowed laptop is not evidence that its owner wanted that.
 *
 * The proof is checked before the authorization is even looked at, so a wrong
 * code and a refused account are told apart only by somebody who already passed
 * the other gate.
 */
export async function deleteOrgAction(orgId: string, proof: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.stepUpProofSchema.safeParse(proof);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Confirm it is you first" };
    try {
        await orgs.requireOrgDeletion(caller, orgId);
        const proven = await proveStepUp(caller.id, `org-delete:${orgId}`, parsed.data);
        if (proven.error) return proven;
        await orgs.deleteOrg(orgId);
        // The organization is gone, so nothing will ever read this through its
        // own screen. It stays for the instance's history, which is the one place
        // "where did Acme go" can still be answered.
        await record(caller.id, orgId, "org.delete");
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the organization");
    }
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/**
 * Ask somebody to join, rather than putting them on the roster.
 *
 * The identifier goes no further than the lookup it is for: whoever is invited
 * is named by the account it resolved to from here on, and the record says that
 * id. An organization's history is readable by everybody holding `activity.read`
 * on it, so an address typed into this box would be an address published to the
 * roster - the one thing the invitation itself is careful never to do.
 */
export async function inviteOrgMemberAction(
    orgId: string,
    identifier: string,
    role: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await orgs.requireOrgPermission(caller, orgId, "people.manage");
        const userId = await invitations.inviteToOrg(orgId, identifier, role, caller.id);
        await record(caller.id, orgId, "org.member.invite", { userId, role });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not invite that person");
    }
}

export async function revokeOrgInvitationAction(
    orgId: string,
    invitationId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await orgs.requireOrgPermission(caller, orgId, "people.manage");
        await invitations.revokeOrgInvitation(orgId, invitationId);
        await record(caller.id, orgId, "org.member.invite.revoke", { invitationId });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not withdraw that invitation");
    }
}

/**
 * Accept or turn down an invitation.
 *
 * The one write here that nobody in the organization may make: it is checked
 * against the invitation's own account rather than against a permission, because
 * the whole point of an invitation is that the person asked is the only one who
 * can answer it.
 */
export async function respondToOrgInvitationAction(
    invitationId: string,
    accept: boolean
): Promise<{ slug?: string; error?: string }> {
    const caller = await actor();
    try {
        const answered = await invitations.respondToInvitation(
            caller.id,
            String(invitationId),
            Boolean(accept)
        );
        await record(
            caller.id,
            answered.orgId,
            accept ? "org.member.invite.accept" : "org.member.invite.decline"
        );
        refresh();
        return accept ? { slug: answered.orgSlug } : {};
    } catch (caught) {
        return failure(caught, "Could not answer that invitation");
    }
}

export async function setOrgMemberRoleAction(
    orgId: string,
    userId: string,
    role: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await orgs.requireOrgPermission(caller, orgId, "people.manage");
        await orgs.setOrgMemberRole(orgId, userId, role);
        await record(caller.id, orgId, "org.member.role", { userId, role });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not change that role");
    }
}

export async function removeOrgMemberAction(
    orgId: string,
    userId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        // Leaving is the one write anybody on the roster may make about
        // themselves; taking somebody else off takes running the people here.
        if (userId !== caller.id) await orgs.requireOrgPermission(caller, orgId, "people.manage");
        else await orgs.requireOrgPermission(caller, orgId, "org.read");
        await orgs.removeOrgMember(orgId, userId);
        await record(
            caller.id,
            orgId,
            userId === caller.id ? "org.member.leave" : "org.member.remove",
            { userId }
        );
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove that person");
    }
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export async function createTeamAction(
    orgId: string,
    input: unknown
): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.teamSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        await orgs.requireOrgPermission(caller, orgId, "teams.manage");
        const id = await orgs.createTeam(orgId, parsed.data);
        await record(caller.id, orgId, "org.team.create", { name: parsed.data.name });
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "Could not create the team");
    }
}

export async function updateTeamAction(
    teamId: string,
    input: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.teamSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const { orgId } = await orgs.requireTeam(caller, teamId, "manage");
        await orgs.updateTeam(teamId, parsed.data);
        await record(caller.id, orgId, "org.team.update", { teamId, name: parsed.data.name });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the team");
    }
}

export async function deleteTeamAction(teamId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        // Deleting a team revokes everything it reached, so it takes the
        // organization rather than the team's own maintainer.
        const { orgId } = await orgs.requireTeam(caller, teamId, "read");
        await orgs.requireOrgPermission(caller, orgId, "teams.manage");
        await orgs.deleteTeam(teamId);
        await record(caller.id, orgId, "org.team.delete", { teamId });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the team");
    }
}

export async function addTeamMemberAction(
    teamId: string,
    identifier: string,
    role: core.TeamRole
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { orgId } = await orgs.requireTeam(caller, teamId, "manage");
        const userId = await orgs.addTeamMember(teamId, identifier, role);
        await record(caller.id, orgId, "org.team.member.add", { teamId, userId, role });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not add that person to the team");
    }
}

export async function setTeamMemberRoleAction(
    teamId: string,
    userId: string,
    role: core.TeamRole
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { orgId } = await orgs.requireTeam(caller, teamId, "manage");
        await orgs.setTeamMemberRole(teamId, userId, role);
        await record(caller.id, orgId, "org.team.member.role", { teamId, userId, role });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not change that role");
    }
}

export async function removeTeamMemberAction(
    teamId: string,
    userId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { orgId } = await orgs.requireTeam(
            caller,
            teamId,
            userId === caller.id ? "read" : "manage"
        );
        await orgs.removeTeamMember(teamId, userId);
        await record(caller.id, orgId, "org.team.member.remove", { teamId, userId });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove that person from the team");
    }
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export async function createOrgRoleAction(
    orgId: string,
    input: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.orgRoleSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        await orgs.requireOrgPermission(caller, orgId, "roles.manage");
        await roles.createOrgRole(orgId, parsed.data);
        await record(caller.id, orgId, "org.role.create", {
            slug: parsed.data.slug,
            permissions: parsed.data.permissions
        });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not create the role");
    }
}

export async function updateOrgRoleAction(
    orgId: string,
    slug: string,
    input: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.orgRoleSchema.omit({ slug: true }).safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        await orgs.requireOrgPermission(caller, orgId, "roles.manage");
        await roles.updateOrgRole(orgId, slug, parsed.data);
        // What a role may do is the one change here that silently moves what
        // other people can do, so the grants themselves go into the record.
        await record(caller.id, orgId, "org.role.update", {
            slug,
            permissions: parsed.data.permissions
        });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the role");
    }
}

export async function deleteOrgRoleAction(
    orgId: string,
    slug: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await orgs.requireOrgPermission(caller, orgId, "roles.manage");
        await roles.deleteOrgRole(orgId, slug);
        await record(caller.id, orgId, "org.role.delete", { slug });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the role");
    }
}

/** What a team can reach, and the people on it, fetched when its panel opens
 *  rather than sent with the page - most visits open no team at all. */
export async function teamDetailAction(teamId: string): Promise<{
    members?: orgs.TeamMemberView[];
    grants?: orgs.TeamGrantView[];
    canManage?: boolean;
    error?: string;
}> {
    const caller = await actor();
    try {
        const { canManage } = await orgs.requireTeam(caller, teamId, "read");
        const [members, grants] = await Promise.all([
            orgs.listTeamMembers(teamId, caller),
            orgs.listTeamGrants(teamId)
        ]);
        return { members, grants, canManage };
    } catch (caught) {
        return failure(caught, "Could not read the team");
    }
}

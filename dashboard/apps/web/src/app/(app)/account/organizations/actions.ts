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
import * as orgs from "@/lib/orgs/org-service";
import { recordAudit } from "@/lib/audit-service";
import { canCreateOrganization } from "@/lib/orgs/policy";

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

// ---------------------------------------------------------------------------
// The organization itself
// ---------------------------------------------------------------------------

export async function createOrgAction(input: unknown): Promise<{ slug?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.organizationSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        // The instance policy is checked here rather than in the service, so the
        // one place that says "may this account start one" is also the place the
        // screen asks to decide whether to offer the button.
        const allowed = await canCreateOrganization(caller.isAdmin, await orgs.ownedOrgCount(caller.id));
        if (!allowed.ok) return { error: allowed.reason };

        const id = await orgs.createOrg(caller.id, parsed.data);
        await recordAudit({ actorId: caller.id, action: "org.create", targetType: "org", targetId: id });
        refresh();
        return { slug: parsed.data.slug };
    } catch (caught) {
        return failure(caught, "Could not create the organization");
    }
}

export async function updateOrgAction(orgId: string, input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.organizationProfileSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        await orgs.requireOrgOwner(caller, orgId);
        await orgs.updateOrg(orgId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the organization");
    }
}

export async function changeOrgSlugAction(orgId: string, slug: unknown): Promise<{ slug?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.orgSlugField.safeParse(slug);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the handle and try again" };
    try {
        await orgs.requireOrgOwner(caller, orgId);
        await orgs.changeOrgSlug(orgId, parsed.data);
        await recordAudit({ actorId: caller.id, action: "org.rename", targetType: "org", targetId: orgId });
        refresh();
        return { slug: parsed.data };
    } catch (caught) {
        return failure(caught, "Could not change the handle");
    }
}

export async function transferOrgAction(orgId: string, toUserId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await orgs.requireOrgOwner(caller, orgId);
        await orgs.transferOrg(orgId, toUserId);
        await recordAudit({ actorId: caller.id, action: "org.transfer", targetType: "org", targetId: orgId });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not hand over the organization");
    }
}

export async function deleteOrgAction(orgId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await orgs.requireOrgOwner(caller, orgId);
        await orgs.deleteOrg(orgId);
        await recordAudit({ actorId: caller.id, action: "org.delete", targetType: "org", targetId: orgId });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the organization");
    }
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export async function addOrgMemberAction(
    orgId: string,
    identifier: string,
    role: core.OrgRole
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await orgs.requireOrg(caller, orgId, "admin");
        await orgs.addOrgMember(orgId, identifier, role);
        await recordAudit({ actorId: caller.id, action: "org.member.add", targetType: "org", targetId: orgId });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not add that person");
    }
}

export async function setOrgMemberRoleAction(
    orgId: string,
    userId: string,
    role: core.OrgRole
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await orgs.requireOrg(caller, orgId, "admin");
        await orgs.setOrgMemberRole(orgId, userId, role);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not change that role");
    }
}

export async function removeOrgMemberAction(orgId: string, userId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        // Leaving is the one write a plain member may make about themselves; an
        // admin is what it takes to remove anybody else.
        if (userId !== caller.id) await orgs.requireOrg(caller, orgId, "admin");
        else await orgs.requireOrg(caller, orgId, "member");
        await orgs.removeOrgMember(orgId, userId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove that person");
    }
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export async function createTeamAction(orgId: string, input: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.teamSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        await orgs.requireOrg(caller, orgId, "admin");
        const id = await orgs.createTeam(orgId, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "Could not create the team");
    }
}

export async function updateTeamAction(teamId: string, input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.teamSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        await orgs.requireTeam(caller, teamId, "manage");
        await orgs.updateTeam(teamId, parsed.data);
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
        await orgs.requireOrg(caller, orgId, "admin");
        await orgs.deleteTeam(teamId);
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
        await orgs.requireTeam(caller, teamId, "manage");
        await orgs.addTeamMember(teamId, identifier, role);
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
        await orgs.requireTeam(caller, teamId, "manage");
        await orgs.setTeamMemberRole(teamId, userId, role);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not change that role");
    }
}

export async function removeTeamMemberAction(teamId: string, userId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        if (userId !== caller.id) await orgs.requireTeam(caller, teamId, "manage");
        else await orgs.requireTeam(caller, teamId, "read");
        await orgs.removeTeamMember(teamId, userId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove that person from the team");
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
        const [members, grants] = await Promise.all([orgs.listTeamMembers(teamId), orgs.listTeamGrants(teamId)]);
        return { members, grants, canManage };
    } catch (caught) {
        return failure(caught, "Could not read the team");
    }
}

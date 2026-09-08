/**
 * Who may hand a thing over, and what they may hand it to.
 *
 * `grants.ts` reads and writes the rows; it decides nothing about whether the
 * person asking is allowed to. That question belongs to the thing being shared
 * and to nobody else - running a conversation, running a space, running the
 * house - so it is answered by each app's own access module and only routed
 * here. One dispatcher rather than a rule per screen, because "who may share
 * this" is exactly the check that gets forgotten on the fourth screen.
 *
 * The candidates are the other half. A grant to a team or a role is only
 * meaningful inside the organization that has them, so what is offered is scoped
 * to the organization that owns the subject - and, for the house, which has no
 * organization at all, to the ones the person sharing actually belongs to. A
 * picker that offered every team on the instance would be a picker that leaks
 * the shape of every organization on it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { sessionCan } from "@/lib/session";
import type { SessionUser } from "@/lib/session";
import { GrantError } from "@/lib/access/grants";
import { memberOrgIds } from "@/lib/orgs/org-service";
import { requireSpace as requireNoteSpace } from "@/lib/notes/access";
import { requireSpace as requireChatSpace, requireChannel } from "@/lib/chat/access";
import { requireSpace as requireTaskSpace, requireFolder } from "@/lib/tasks/access";

/**
 * Refuse unless this account may hand this thing to somebody else.
 *
 * Sharing is always the strongest standing the thing has: an admin of a space, a
 * moderator of a channel, whoever may set the house up. Being able to open a
 * door is not being able to lend it, which is the whole point - a visitor with a
 * key must not be able to cut copies.
 */
export async function requireMayShare(
    user: SessionUser,
    subject: core.GrantSubject,
    subjectId: string
): Promise<void> {
    const actor = { id: user.id, isAdmin: user.isAdmin };
    switch (subject) {
        case "chat.space":
            await requireChatSpace({ id: user.id }, subjectId, "admin");
            return;
        case "chat.channel": {
            const access = await requireChannel({ id: user.id }, subjectId);
            if (!access.mayAdminister) throw new GrantError("You cannot share that conversation");
            return;
        }
        case "task.space":
            await requireTaskSpace(actor, subjectId, "admin");
            return;
        case "task.folder":
            await requireFolder(actor, subjectId, "admin");
            return;
        case "note.space":
            await requireNoteSpace(actor, subjectId, "admin");
            return;
        case "place.device":
        case "place.camera":
            // Deciding who gets a key to the house is the same standing as
            // deciding what Polaris is connected to. Being able to open a door
            // is deliberately not enough: a visitor must not be able to lend it
            // on.
            if (!(await sessionCan(user, "home.manage"))) {
                throw new GrantError("You cannot share that");
            }
            return;
    }
}

/** Somebody a grant can be written to, as the picker draws them. */
export interface GrantCandidate {
    readonly type: core.GrantPrincipal;
    readonly id: string;
    readonly name: string;
    /** Which organization it came from, for a picker showing two of them. */
    readonly orgName: string;
    /** What the row says underneath - how many people it reaches, or an
     *  address. */
    readonly detail: string;
}

/**
 * The teams and roles this thing can be handed to.
 *
 * Scoped to the organization that owns the subject, so a conversation belonging
 * to one organization cannot be handed to another's people. The house belongs to
 * no organization, so there it is the organizations the sharer is on - which is
 * how "the security team" ends up on the list at all.
 *
 * People are deliberately not here: they are found by searching, through the
 * same privacy rules every other people search obeys, rather than being listed.
 */
export async function shareCandidates(
    user: SessionUser,
    subject: core.GrantSubject,
    subjectId: string
): Promise<GrantCandidate[]> {
    const orgIds = await owningOrgIds(user, subject, subjectId);
    if (orgIds.length === 0) return [];

    const [teams, roles] = await Promise.all([
        prisma.team.findMany({
            where: { orgId: { in: orgIds } },
            orderBy: [{ org: { name: "asc" } }, { name: "asc" }],
            select: {
                id: true,
                name: true,
                org: { select: { name: true } },
                _count: { select: { members: true } }
            }
        }),
        prisma.orgRole.findMany({
            where: { orgId: { in: orgIds } },
            orderBy: [{ org: { name: "asc" } }, { name: "asc" }],
            select: { id: true, name: true, description: true, org: { select: { name: true } } }
        })
    ]);

    return [
        ...teams.map((team) => ({
            type: "team" as const,
            id: team.id,
            name: team.name,
            orgName: team.org.name,
            detail: team._count.members === 1 ? "1 person" : `${team._count.members} people`
        })),
        ...roles.map((role) => ({
            type: "role" as const,
            id: role.id,
            name: role.name,
            orgName: role.org.name,
            detail: role.description || "Everybody holding this role"
        }))
    ];
}

/** Which organizations' groups are on the table for this subject. */
async function owningOrgIds(
    user: SessionUser,
    subject: core.GrantSubject,
    subjectId: string
): Promise<string[]> {
    const owning = await ownerOrgOf(subject, subjectId);
    if (owning) return [owning];
    // No organization owns it - somebody's own space, or the house, which is one
    // per Polaris and belongs to nobody. Then the groups worth offering are the
    // ones the person sharing is actually on.
    return memberOrgIds(user.id);
}

async function ownerOrgOf(subject: core.GrantSubject, subjectId: string): Promise<string | null> {
    switch (subject) {
        case "chat.space":
            return orgOf(await prisma.chatSpace.findUnique({ where: { id: subjectId }, select: { orgId: true } }));
        case "chat.channel": {
            const channel = await prisma.chatChannel.findUnique({
                where: { id: subjectId },
                select: { space: { select: { orgId: true } } }
            });
            return channel?.space?.orgId ?? null;
        }
        case "task.space":
            return orgOf(await prisma.taskSpace.findUnique({ where: { id: subjectId }, select: { orgId: true } }));
        case "task.folder": {
            const folder = await prisma.taskFolder.findUnique({
                where: { id: subjectId },
                select: { space: { select: { orgId: true } } }
            });
            return folder?.space?.orgId ?? null;
        }
        case "note.space":
            return orgOf(await prisma.noteSpace.findUnique({ where: { id: subjectId }, select: { orgId: true } }));
        default:
            return null;
    }
}

function orgOf(row: { orgId: string | null } | null): string | null {
    return row?.orgId ?? null;
}

/**
 * Whether a grant on this subject is worth bounding by hours and uses.
 *
 * A door lent to a visitor is; a conversation handed to the support team is not.
 * The columns exist either way - one table - but a form that asked how many
 * times somebody may read a channel would be asking a question with no meaning,
 * and a form nobody can answer is a form nobody fills in.
 */
export function shareIsBounded(subject: core.GrantSubject): boolean {
    return subject === "place.device" || subject === "place.camera";
}

/** What each capability is called and what it means, for the picker. Kept beside
 *  the vocabulary rather than in each screen, so the three places that draw this
 *  say the same words. */
export const CAPABILITY_LABELS: Record<string, { label: string; hint: string }> = {
    guest: { label: "Guest", hint: "Read it, and comment where they are involved." },
    member: { label: "Member", hint: "Take part: post, create and edit." },
    admin: { label: "Admin", hint: "Everything a member can do, plus running it." },
    view: { label: "Can see", hint: "Watch it and see its state. Nothing else." },
    control: { label: "Can operate", hint: "Open, close and switch it, as well as see it." }
};
